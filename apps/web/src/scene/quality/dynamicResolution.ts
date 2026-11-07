export interface DynamicResolutionOptions {
  readonly minScale: number;
  readonly maxScale: number;
  readonly initialScale?: number;
  /** The rate the controller defends; frames slower than this trigger a downscale. */
  readonly floorFps?: number;
  /** The rate that counts as "keeping up" before probing a higher resolution. */
  readonly targetFps?: number;
  /**
   * Starts with the overload already shown to be GPU-bound, as when a tier step hands over
   * from a controller that verified it; the confirmation lapses as usual without slow frames.
   */
  readonly gpuBoundConfirmed?: boolean;
}

export interface FrameTiming {
  /** Time since the previous frame started (the requestAnimationFrame timestamp delta). */
  readonly intervalMs: number;
  /** Main-thread time that frame spent before its GPU work was submitted, when measured. */
  readonly cpuMs?: number | null;
  /** GPU time of that frame's passes from timestamp queries, when the device exposes them. */
  readonly gpuMs?: number | null;
}

/**
 * What a frame's timing says about the GPU:
 * - `gpu-timer`: measured GPU time, the only direct signal.
 * - `frame-interval`: the interval with the CPU ruled out; may still be a vsync or power cap,
 *   so drops made on it are verified before they count.
 * - `cpu-bound`: main-thread work alone filled the frame; resolution cannot help.
 */
export type FrameAttribution = 'gpu-timer' | 'frame-interval' | 'cpu-bound';

export type ResolutionEvent =
  { readonly kind: 'scale'; readonly scale: number } | { readonly kind: 'exhausted' };

const STEP = 0.05;
/** Vsync rounds a slightly late frame up to a whole extra interval, so the overshoot it
 * reports is exaggerated; capping each confirmed drop stops one late frame halving resolution. */
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
/** GPU time has to leave the CPU, compositor and vsync jitter part of the frame. */
const GPU_SLOW_SHARE = 0.88;
const GPU_HEALTHY_SHARE = 0.72;
/** Main-thread work at this share of the interval (or of the budget) owns the frame. */
const CPU_BOUND_SHARE = 0.8;
/** How long a lower scale is watched before deciding whether it moved the frame rate. */
const VERIFY_MS = 600;
/** A verification that never sees GPU-attributable frames gives up after this long. */
const VERIFY_TIMEOUT_MS = 3000;
const IMPROVED_RATIO = 0.9;
/** Verification compares medians of raw intervals over this window: a hitch cannot fake or
 * hide a win, and an overload far past `FRAME_CAP_MS` still shows its improvement. */
const VERIFY_WINDOW_MS = 1000;
/** Each failed verification waits this much longer before the interval is trusted again. */
const INSENSITIVE_BASE_MS = 10_000;
const INSENSITIVE_GROWTH = 3;
const INSENSITIVE_MAX_MS = 10 * 60_000;
/** A confirmed GPU-bound episode is trusted until this long passes without a slow frame. */
const CONFIRMED_FOR_MS = 15_000;
/** Timer readings older than this mean the timer stalled; fall back to frame intervals. */
const GPU_STALE_MS = 500;

interface Verification {
  readonly fromScale: number;
  readonly baselineMs: number;
  floorTried: boolean;
  ageMs: number;
}

/**
 * Picks a render scale from frame timing, and only ever lowers it for GPU-bound frames.
 *
 * With GPU timestamps the measured GPU time drives it directly. Without them it works from
 * the frame interval: frames the main thread filled are ignored, and since a frame pinned
 * at a 30 Hz power cap or a slow display looks exactly like a GPU-bound one, a drop made on
 * the interval is verified: if neither that drop nor the floor scale speeds frames up, the
 * scale is restored and interval-based drops back off exponentially. Only a verified
 * GPU-bound overload at the floor scale reports `exhausted`.
 *
 * GPU cost is roughly proportional to pixel count, so drops follow the square root of the
 * overshoot; growing back is a single-step probe that is reverted, and backs off
 * exponentially, each time it fails, which stops it see-sawing around the vsync boundary.
 */
export class DynamicResolution {
  readonly minScale: number;
  readonly maxScale: number;
  private readonly frameSlowMs: number;
  private readonly frameHealthyMs: number;
  private readonly gpuSlowMs: number;
  private readonly gpuHealthyMs: number;
  private current: number;
  private clockMs = 0;
  private frameEma: number | null = null;
  private gpuEma: number | null = null;
  private lastGpuAtMs: number | null = null;
  private attribution: FrameAttribution | null = null;
  private sinceChangeMs = 0;
  private healthyMs = 0;
  private slowMs = 0;
  private starvedAtFloorMs = 0;
  private probeAfterMs = PROBE_BASE_MS;
  private lastProbeAgeMs: number | null = null;
  private verification: Verification | null = null;
  private recentIntervals: number[] = [];
  private confirmedAtMs: number | null = null;
  private insensitiveUntilMs = 0;
  private insensitiveBackoffMs = INSENSITIVE_BASE_MS;

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
    this.frameSlowMs = 1000 / floorFps;
    this.frameHealthyMs = 1000 / targetFps;
    this.gpuSlowMs = this.frameSlowMs * GPU_SLOW_SHARE;
    this.gpuHealthyMs = this.frameHealthyMs * GPU_HEALTHY_SHARE;
    this.current = this.clamp(options.initialScale ?? options.maxScale);
    if (options.gpuBoundConfirmed === true) this.confirmedAtMs = 0;
  }

  get scale(): number {
    return this.current;
  }

  /** The smoothed cost the controller is acting on: GPU time with a timer, else the interval. */
  get smoothedFrameMs(): number | null {
    return this.usingGpuTimer() ? this.gpuEma : this.frameEma;
  }

  get lastAttribution(): FrameAttribution | null {
    return this.attribution;
  }

  /** Whether the current overload has been shown to respond to resolution. */
  get gpuBoundConfirmed(): boolean {
    return this.usingGpuTimer() || this.isConfirmed();
  }

  /** Feeds one frame; returns an event when the scale changed or ran out of room. */
  sample(frame: FrameTiming): ResolutionEvent | null {
    const interval = frame.intervalMs;
    if (!Number.isFinite(interval) || interval <= 0) return null;
    if (interval > PAUSE_MS) {
      this.frameEma = null;
      this.gpuEma = null;
      this.healthyMs = 0;
      this.slowMs = 0;
      this.verification = null;
      this.recentIntervals = [];
      return null;
    }
    this.clockMs += interval;
    this.sinceChangeMs += interval;
    if (this.lastProbeAgeMs !== null) this.lastProbeAgeMs += interval;

    const attribution = this.attribute(frame);
    this.attribution = attribution;
    if (attribution === 'gpu-timer') {
      this.gpuEma = smooth(this.gpuEma, frame.gpuMs ?? 0, interval);
      this.lastGpuAtMs = this.clockMs;
    } else if (attribution === 'frame-interval') {
      this.frameEma = smooth(this.frameEma, interval, interval);
      this.remember(interval);
    }
    if (this.sinceChangeMs < SETTLE_MS) return null;
    if (this.verification !== null) return this.verify(this.verification, attribution, interval);

    const gpuMode = this.usingGpuTimer();
    if (!gpuMode && attribution === 'cpu-bound') return null;
    const ema = gpuMode ? this.gpuEma : this.frameEma;
    if (ema === null) return null;

    if (ema > (gpuMode ? this.gpuSlowMs : this.frameSlowMs)) {
      if (!gpuMode && !this.isConfirmed() && this.clockMs < this.insensitiveUntilMs) return null;
      this.slowMs += interval;
      this.healthyMs = 0;
      return this.slowMs >= SUSTAINED_SLOW_MS ? this.onSlow(ema, gpuMode, interval) : null;
    }

    this.slowMs = 0;
    this.starvedAtFloorMs = 0;
    if (ema <= (gpuMode ? this.gpuHealthyMs : this.frameHealthyMs)) {
      this.healthyMs += interval;
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

  private attribute(frame: FrameTiming): FrameAttribution {
    const { gpuMs, cpuMs, intervalMs } = frame;
    if (typeof gpuMs === 'number' && Number.isFinite(gpuMs) && gpuMs > 0) return 'gpu-timer';
    if (
      intervalMs > this.frameSlowMs &&
      typeof cpuMs === 'number' &&
      Number.isFinite(cpuMs) &&
      cpuMs >= CPU_BOUND_SHARE * Math.min(intervalMs, this.frameSlowMs)
    ) {
      return 'cpu-bound';
    }
    return 'frame-interval';
  }

  private usingGpuTimer(): boolean {
    return this.lastGpuAtMs !== null && this.clockMs - this.lastGpuAtMs <= GPU_STALE_MS;
  }

  private isConfirmed(): boolean {
    return this.confirmedAtMs !== null && this.clockMs - this.confirmedAtMs <= CONFIRMED_FOR_MS;
  }

  private onSlow(ema: number, gpuMode: boolean, frameMs: number): ResolutionEvent | null {
    if (this.lastProbeAgeMs !== null && this.lastProbeAgeMs <= FAILED_PROBE_WINDOW_MS) {
      this.probeAfterMs = Math.min(PROBE_MAX_MS, this.probeAfterMs * 2);
      this.lastProbeAgeMs = null;
      return this.apply(this.current - STEP);
    }
    const confirmed = gpuMode || this.isConfirmed();
    if (confirmed && !gpuMode) this.confirmedAtMs = this.clockMs;
    if (this.current <= this.minScale) {
      if (!confirmed) return null;
      this.starvedAtFloorMs += frameMs;
      if (this.starvedAtFloorMs >= EXHAUSTED_AFTER_MS) {
        this.starvedAtFloorMs = 0;
        return { kind: 'exhausted' };
      }
      return null;
    }
    const budget = gpuMode ? this.gpuSlowMs : this.frameSlowMs;
    const ideal = this.current * Math.sqrt(budget / ema) * 0.95;
    if (confirmed) {
      const bounded = Math.max(ideal, this.current - MAX_DROP);
      return this.apply(Math.min(bounded, this.current - STEP));
    }
    // Unverified: the interval is quantised to vsync, so the drop goes straight to the scale
    // the overshoot asks for; a small step could hide a real GPU win behind the same vsync.
    const from = this.current;
    const baselineMs = median(this.recentIntervals) ?? ema;
    const event = this.apply(Math.min(ideal, this.current - STEP));
    this.verification = {
      fromScale: from,
      baselineMs,
      floorTried: this.current <= this.minScale,
      ageMs: 0,
    };
    return event;
  }

  private verify(
    verification: Verification,
    attribution: FrameAttribution,
    frameMs: number,
  ): ResolutionEvent | null {
    if (this.usingGpuTimer()) {
      this.verification = null;
      return null;
    }
    verification.ageMs += frameMs;
    const measured = median(this.recentIntervals);
    const decided = attribution !== 'cpu-bound' && verification.ageMs >= VERIFY_MS;
    if (!decided && verification.ageMs < VERIFY_TIMEOUT_MS) return null;
    const improved =
      decided &&
      measured !== null &&
      (measured <= this.frameSlowMs || measured <= verification.baselineMs * IMPROVED_RATIO);
    if (improved) {
      this.verification = null;
      this.confirmedAtMs = this.clockMs;
      this.insensitiveBackoffMs = INSENSITIVE_BASE_MS;
      return null;
    }
    if (decided && !verification.floorTried && this.current > this.minScale) {
      verification.floorTried = true;
      verification.ageMs = 0;
      return this.apply(this.minScale);
    }
    this.verification = null;
    this.insensitiveUntilMs = this.clockMs + this.insensitiveBackoffMs;
    this.insensitiveBackoffMs = Math.min(
      INSENSITIVE_MAX_MS,
      this.insensitiveBackoffMs * INSENSITIVE_GROWTH,
    );
    return this.apply(verification.fromScale);
  }

  private apply(scale: number): ResolutionEvent | null {
    const next = this.clamp(Math.round(scale / STEP) * STEP);
    if (next === this.current) return null;
    this.current = next;
    this.frameEma = null;
    this.gpuEma = null;
    this.recentIntervals = [];
    this.sinceChangeMs = 0;
    this.healthyMs = 0;
    this.slowMs = 0;
    return { kind: 'scale', scale: next };
  }

  private remember(intervalMs: number): void {
    this.recentIntervals.push(intervalMs);
    let total = this.recentIntervals.reduce((sum, ms) => sum + ms, 0);
    while (this.recentIntervals.length > 1 && total > VERIFY_WINDOW_MS) {
      total -= this.recentIntervals.shift() ?? 0;
    }
  }

  private clamp(scale: number): number {
    const clamped = Math.min(this.maxScale, Math.max(this.minScale, scale));
    return Math.round(clamped * 1000) / 1000;
  }
}

function smooth(previous: number | null, valueMs: number, frameMs: number): number {
  const cost = Math.min(valueMs, FRAME_CAP_MS);
  if (previous === null) return cost;
  const alpha = 1 - Math.pow(0.5, frameMs / EMA_HALF_LIFE_MS);
  return previous + (cost - previous) * alpha;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}
