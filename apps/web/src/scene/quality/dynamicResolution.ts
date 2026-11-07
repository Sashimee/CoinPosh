import { median } from './score.ts';

export interface DynamicResolutionOptions {
  readonly minScale: number;
  readonly maxScale: number;
  readonly initialScale?: number;
  /** The rate the controller defends; frames slower than this trigger a downscale. */
  readonly floorFps?: number;
  /** The rate that counts as "keeping up" before probing a higher resolution. */
  readonly targetFps?: number;
  /**
   * Typical frame time just before this controller took over (after a tier change). The first
   * evaluation compares against it, so a tier drop that did not help counts as no response.
   */
  readonly baselineFrameMs?: number;
}

export type ResolutionEvent =
  { readonly kind: 'scale'; readonly scale: number } | { readonly kind: 'exhausted' };

const STEP = 0.05;
/** Vsync rounds a slightly late frame up to a whole extra interval, so the overshoot it
 * reports is exaggerated; capping each drop stops one late frame from halving resolution. */
const MAX_DROP = 0.15;
const EMA_HALF_LIFE_MS = 250;
const SETTLE_MS = 400;
/** Longer gaps are a paused tab or a debugger, not rendering cost. */
const PAUSE_MS = 1000;
/** One very slow frame (shader compile, GC) must not dominate the average on its own. */
const FRAME_CAP_MS = 100;
/** A dropped vsync frame lifts the average briefly; only sustained overload counts. */
const SUSTAINED_SLOW_MS = 350;
const PROBE_BASE_MS = 2000;
const PROBE_MAX_MS = 32000;
const FAILED_PROBE_WINDOW_MS = 3000;
const EXHAUSTED_AFTER_MS = 3000;
/** A downscale must cut the typical frame time by this much to count as a response. */
const MIN_GAIN = 0.08;
/**
 * Consecutive downscales without a response before resolution is ruled out as the
 * bottleneck. Vsync quantisation can hide one real GPU saving, rarely two in a row.
 */
const MAX_UNRESPONSIVE = 2;
/** While holding, a load this much heavier than the held level is a new episode. */
const HOLD_BREAK = 1.25;
/** Span of recent frames the typical frame time is taken over; short, so it never lags a load change. */
const WINDOW_MS = 600;

interface PendingCheck {
  readonly typicalMs: number;
  readonly scale: number;
}

/**
 * Picks a render scale from frame times. GPU cost is roughly proportional to pixel count,
 * so sustained overload shrinks the scale by the square root of the overshoot (bounded);
 * growing back is a single-step probe that is reverted, and backs off exponentially, each
 * time it fails, which is what stops it see-sawing around the vsync boundary.
 *
 * Slow frames are not always GPU-bound: a 30 Hz rAF cap (low-power mode, throttled iframe),
 * a 48/50 Hz display or a CPU-heavy frame all look slow at every resolution. Each downscale
 * is therefore checked against the typical frame time before it; when two in a row change
 * nothing, the scale is restored and held, and 'exhausted' is only reported once a
 * downscale in the current slow episode has measurably helped.
 */
export class DynamicResolution {
  readonly minScale: number;
  readonly maxScale: number;
  private readonly downscaleAboveMs: number;
  private readonly upscaleBelowMs: number;
  private current: number;
  private ema: number | null = null;
  private sinceChangeMs = 0;
  private healthyMs = 0;
  private slowMs = 0;
  private starvedAtFloorMs = 0;
  private probeAfterMs = PROBE_BASE_MS;
  private lastProbeAgeMs: number | null = null;
  private readonly window: number[] = [];
  private windowMs = 0;
  private pending: PendingCheck | null;
  private responded = false;
  private unresponsive = 0;
  private restoreScale: number | null = null;
  private holdAtMs: number | null = null;

  constructor(options: DynamicResolutionOptions) {
    if (!(options.minScale > 0 && options.minScale <= options.maxScale)) {
      throw new Error(
        `DynamicResolution needs 0 < minScale <= maxScale, got ${options.minScale}..${options.maxScale}`,
      );
    }
    this.minScale = options.minScale;
    this.maxScale = options.maxScale;
    const floorFps = options.floorFps ?? 57;
    const targetFps = options.targetFps ?? 59;
    this.downscaleAboveMs = 1000 / floorFps;
    this.upscaleBelowMs = 1000 / targetFps;
    this.current = this.clamp(options.initialScale ?? options.maxScale);
    this.pending =
      options.baselineFrameMs === undefined
        ? null
        : { typicalMs: options.baselineFrameMs, scale: this.current };
  }

  get scale(): number {
    return this.current;
  }

  get smoothedFrameMs(): number | null {
    return this.ema;
  }

  /** Median of the recent frames at the current scale: robust to spikes, not capped. */
  get typicalFrameMs(): number | null {
    return this.window.length === 0 ? null : median(this.window);
  }

  /** True while resolution has been ruled out as the bottleneck and the scale is held. */
  get holding(): boolean {
    return this.holdAtMs !== null;
  }

  /** Feeds one frame's duration; returns an event when the scale changed or ran out of room. */
  sample(frameMs: number): ResolutionEvent | null {
    if (!Number.isFinite(frameMs) || frameMs <= 0) return null;
    if (frameMs > PAUSE_MS) {
      this.ema = null;
      this.healthyMs = 0;
      this.slowMs = 0;
      this.window.length = 0;
      this.windowMs = 0;
      return null;
    }
    this.window.push(frameMs);
    this.windowMs += frameMs;
    while (this.window.length > 1 && this.windowMs - (this.window[0] ?? 0) >= WINDOW_MS) {
      this.windowMs -= this.window.shift() ?? 0;
    }
    const cost = Math.min(frameMs, FRAME_CAP_MS);
    const alpha = 1 - Math.pow(0.5, frameMs / EMA_HALF_LIFE_MS);
    this.ema = this.ema === null ? cost : this.ema + (cost - this.ema) * alpha;
    this.sinceChangeMs += frameMs;
    if (this.lastProbeAgeMs !== null) this.lastProbeAgeMs += frameMs;
    if (this.sinceChangeMs < SETTLE_MS) return null;

    if (this.ema > this.downscaleAboveMs) {
      this.slowMs += frameMs;
      this.healthyMs = 0;
      return this.slowMs >= SUSTAINED_SLOW_MS ? this.onSlow(frameMs) : null;
    }

    this.slowMs = 0;
    this.starvedAtFloorMs = 0;
    this.endSlowEpisode();
    if (this.ema <= this.upscaleBelowMs) {
      this.healthyMs += frameMs;
      if (this.lastProbeAgeMs !== null && this.lastProbeAgeMs > FAILED_PROBE_WINDOW_MS) {
        this.probeAfterMs = Math.max(PROBE_BASE_MS, this.probeAfterMs / 2);
        this.lastProbeAgeMs = null;
      }
      if (this.healthyMs >= this.probeAfterMs && this.current < this.maxScale) {
        this.lastProbeAgeMs = 0;
        return this.apply(this.current + STEP);
      }
    } else {
      this.healthyMs = 0;
    }
    return null;
  }

  private onSlow(frameMs: number): ResolutionEvent | null {
    const ema = this.ema ?? frameMs;
    const typical = this.typicalFrameMs ?? frameMs;
    if (this.lastProbeAgeMs !== null && this.lastProbeAgeMs <= FAILED_PROBE_WINDOW_MS) {
      this.probeAfterMs = Math.min(PROBE_MAX_MS, this.probeAfterMs * 2);
      this.lastProbeAgeMs = null;
      this.pending = null;
      return this.apply(this.current - STEP);
    }
    if (this.holdAtMs !== null) {
      if (typical <= this.holdAtMs * HOLD_BREAK) return null;
      this.endSlowEpisode();
    }
    if (this.pending !== null) {
      const { typicalMs, scale } = this.pending;
      this.pending = null;
      if (typical <= typicalMs * (1 - MIN_GAIN)) {
        this.responded = true;
        this.unresponsive = 0;
        this.restoreScale = null;
      } else {
        if (this.unresponsive === 0) this.restoreScale = scale;
        this.unresponsive++;
        if (this.unresponsive >= MAX_UNRESPONSIVE) return this.hold(typical);
      }
    }
    if (this.current <= this.minScale) {
      if (!this.responded) return this.hold(typical);
      this.starvedAtFloorMs += frameMs;
      if (this.starvedAtFloorMs >= EXHAUSTED_AFTER_MS) {
        this.starvedAtFloorMs = 0;
        return { kind: 'exhausted' };
      }
      return null;
    }
    const ideal = this.current * Math.sqrt(this.downscaleAboveMs / ema) * 0.95;
    const bounded = Math.max(ideal, this.current - MAX_DROP);
    this.pending = { typicalMs: typical, scale: this.current };
    return this.apply(Math.min(bounded, this.current - STEP));
  }

  private hold(typicalMs: number): ResolutionEvent | null {
    const restore = this.restoreScale ?? this.current;
    this.endSlowEpisode();
    this.holdAtMs = typicalMs;
    return this.apply(restore);
  }

  private endSlowEpisode(): void {
    this.pending = null;
    this.responded = false;
    this.unresponsive = 0;
    this.restoreScale = null;
    this.holdAtMs = null;
  }

  private apply(scale: number): ResolutionEvent | null {
    const next = this.clamp(Math.round(scale / STEP) * STEP);
    if (next === this.current) return null;
    this.current = next;
    this.ema = null;
    this.sinceChangeMs = 0;
    this.healthyMs = 0;
    this.slowMs = 0;
    this.window.length = 0;
    this.windowMs = 0;
    return { kind: 'scale', scale: next };
  }

  private clamp(scale: number): number {
    const clamped = Math.min(this.maxScale, Math.max(this.minScale, scale));
    return Math.round(clamped * 1000) / 1000;
  }
}
