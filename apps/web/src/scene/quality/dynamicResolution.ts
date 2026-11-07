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
   * from a controller that verified it; the confirmation expires on the usual timer.
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
/** Longer gaps are a paused tab, a suspended device or a debugger, not rendering cost. */
export const PAUSE_MS = 1000;
/**
 * Frames right after a pause carry resume costs (texture re-uploads, compositor catch-up,
 * a cold GPU clock), so this much active time is skipped before measuring again.
 */
export const RESUME_GRACE_MS = 500;
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
/**
 * An unverified drop is an A/B test: the controller switches between the lower and the
 * higher scale for this many segments of pseudo-random length. GPU-bound frames follow every
 * switch, while a cap that comes and goes on its own spans segments of both kinds, and the
 * random lengths stop a cap with a steady period from lining up with them.
 */
const TRIAL_SEGMENTS = 8;
const SEGMENT_MIN_MS = 150;
const SEGMENT_SPAN_MS = 200;
const SEGMENT_SEED = 0x9e3779b9;
/** Frames just after a switch can still carry the previous scale's cost (GPU pipelining). */
const SEGMENT_SKIP_FRAMES = 2;
const SEGMENT_MIN_SAMPLES = 2;
/** A segment that sees no GPU-attributable frames for this long fails the test. */
const SEGMENT_TIMEOUT_MS = 3000;
const IMPROVED_RATIO = 0.9;
/** Each failed test waits this much longer before the interval is trusted again. */
const INSENSITIVE_BASE_MS = 10_000;
const INSENSITIVE_GROWTH = 3;
const INSENSITIVE_MAX_MS = 10 * 60_000;
/** A confirmation is trusted for this long after its A/B test, then has to be re-verified. */
const CONFIRMED_FOR_MS = 15_000;
/** How far above the floor the A/B test at the floor scale raises resolution. */
const FLOOR_RETEST_RAISE = 0.3;
/** Timer readings older than this mean the timer stalled; fall back to frame intervals. */
const GPU_STALE_MS = 500;

interface Trial {
  readonly high: number;
  readonly low: number;
  readonly floorTried: boolean;
  /** Where a failed test leaves the scale. */
  readonly restoreTo: number;
  /** Median interval of each finished segment at each scale, in order. */
  readonly lowMs: number[];
  readonly highMs: number[];
  samples: number[];
  skipped: number;
  ageMs: number;
  segmentMs: number;
}

/**
 * Picks a render scale from frame timing, and only ever lowers it for GPU-bound frames.
 *
 * With GPU timestamps the measured GPU time drives it directly. Without them it works from
 * the frame interval: frames the main thread filled are ignored, and since a frame pinned
 * at a 30 Hz power cap or a slow display looks exactly like a GPU-bound one, a drop made on
 * the interval is verified as an A/B test: frames have to speed up at the lower scale and slow
 * down again at the higher one, segment after segment. A failed test keeps the higher scale
 * and backs interval-based drops off exponentially. A confirmation expires on an
 * absolute timer, and only an overload verified within the current slow episode reports
 * `exhausted` at the floor scale.
 *
 * All timers run on active time, the sum of measured intervals. A gap longer than
 * `PAUSE_MS` (or an `interrupt()` from a hidden tab) is not a frame: it adds nothing to that
 * clock, discards the measurements of the episode it cut, and the frames of the next
 * `RESUME_GRACE_MS` are skipped. A running A/B test survives it: only the segment the pause
 * cut is measured again, so tests still reach a verdict when pauses come more often than a
 * test lasts.
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
  private trial: Trial | null = null;
  private confirmedAtMs: number | null = null;
  private episodeConfirmed = false;
  private segmentSeed = SEGMENT_SEED;
  private insensitiveUntilMs = 0;
  private insensitiveBackoffMs = INSENSITIVE_BASE_MS;
  private resumeGraceMs = 0;

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
    if (options.gpuBoundConfirmed === true) {
      this.confirmedAtMs = 0;
      this.episodeConfirmed = true;
    }
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
      this.interrupt();
      return null;
    }
    if (this.resumeGraceMs > 0) {
      this.resumeGraceMs -= interval;
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
    }
    if (this.trial !== null) return this.runTrial(this.trial, attribution, interval);
    if (this.sinceChangeMs < SETTLE_MS) return null;
    if (!this.usingGpuTimer() && this.frameEma !== null && this.frameEma <= this.frameSlowMs) {
      this.episodeConfirmed = false;
    }

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
    this.episodeConfirmed = false;
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

  /**
   * Marks a discontinuity in the frame stream, such as the tab being hidden or shown. The
   * smoothed cost and slow or healthy streaks are dropped, a running A/B test restarts the
   * segment it was in, and confirmations and back-offs keep their active-time timers.
   */
  interrupt(): void {
    this.frameEma = null;
    this.gpuEma = null;
    this.healthyMs = 0;
    this.slowMs = 0;
    this.starvedAtFloorMs = 0;
    this.resumeGraceMs = RESUME_GRACE_MS;
    if (this.trial !== null) {
      this.trial.samples = [];
      this.trial.skipped = 0;
      this.trial.ageMs = 0;
    }
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
    if (this.current <= this.minScale) {
      if (!confirmed || !(gpuMode || this.episodeConfirmed)) return this.retestAtFloor();
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
    const low = this.clamp(Math.round(Math.min(ideal, this.current - STEP) / STEP) * STEP);
    return this.startTrial(this.current, low, low <= this.minScale, this.current);
  }

  /**
   * At the floor there is nothing lower to try, so the test raises resolution instead; if
   * that makes no difference the floor buys nothing, and a failed test returns to full scale.
   */
  private retestAtFloor(): ResolutionEvent | null {
    if (this.clockMs < this.insensitiveUntilMs) return null;
    const high = this.clamp(this.current + FLOOR_RETEST_RAISE);
    if (high === this.current) return null;
    return this.startTrial(high, this.current, true, this.maxScale);
  }

  private startTrial(
    high: number,
    low: number,
    floorTried: boolean,
    restoreTo: number,
  ): ResolutionEvent | null {
    this.trial = {
      high,
      low,
      floorTried,
      restoreTo,
      lowMs: [],
      highMs: [],
      samples: [],
      skipped: 0,
      ageMs: 0,
      segmentMs: this.nextSegmentMs(),
    };
    return this.apply(low);
  }

  private runTrial(
    trial: Trial,
    attribution: FrameAttribution,
    frameMs: number,
  ): ResolutionEvent | null {
    if (this.usingGpuTimer()) {
      this.trial = null;
      return this.apply(trial.high);
    }
    trial.ageMs += frameMs;
    if (attribution === 'frame-interval') {
      if (trial.skipped < SEGMENT_SKIP_FRAMES) trial.skipped += 1;
      else trial.samples.push(frameMs);
    }
    const segmentMs = median(trial.samples);
    if (
      segmentMs === null ||
      trial.samples.length < SEGMENT_MIN_SAMPLES ||
      trial.ageMs < trial.segmentMs
    ) {
      return trial.ageMs >= SEGMENT_TIMEOUT_MS ? this.rejectTrial(trial) : null;
    }
    const atLow = trial.lowMs.length === trial.highMs.length;
    (atLow ? trial.lowMs : trial.highMs).push(segmentMs);
    trial.samples = [];
    trial.skipped = 0;
    trial.ageMs = 0;
    trial.segmentMs = this.nextSegmentMs();
    if (atLow || trial.highMs.length < TRIAL_SEGMENTS / 2) {
      return this.apply(atLow ? trial.high : trial.low);
    }
    this.trial = null;
    if (this.followsResolution(trial)) {
      this.confirmedAtMs = this.clockMs;
      this.episodeConfirmed = true;
      this.insensitiveBackoffMs = INSENSITIVE_BASE_MS;
      return this.apply(trial.low);
    }
    const lowNeverFast = trial.lowMs.every((ms) => ms > this.frameSlowMs);
    if (!trial.floorTried && lowNeverFast && trial.low > this.minScale) {
      return this.startTrial(trial.high, this.minScale, true, trial.restoreTo);
    }
    return this.rejectTrial(trial);
  }

  /** Every higher-scale segment is slow and slower than the lower-scale segments around it. */
  private followsResolution(trial: Trial): boolean {
    return trial.highMs.every((highMs, i) => {
      const neighbours = [trial.lowMs[i], trial.lowMs[i + 1]];
      return (
        highMs > this.frameSlowMs &&
        neighbours.every((lowMs) => lowMs === undefined || lowMs <= highMs * IMPROVED_RATIO)
      );
    });
  }

  /** Resolution did not explain the slow frames: keep the higher scale and back off. */
  private rejectTrial(trial: Trial): ResolutionEvent | null {
    this.trial = null;
    this.insensitiveUntilMs = this.clockMs + this.insensitiveBackoffMs;
    this.insensitiveBackoffMs = Math.min(
      INSENSITIVE_MAX_MS,
      this.insensitiveBackoffMs * INSENSITIVE_GROWTH,
    );
    return this.apply(trial.restoreTo);
  }

  /** xorshift32: deterministic, so the same frame timings always make the same decisions. */
  private nextSegmentMs(): number {
    let x = this.segmentSeed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.segmentSeed = x >>> 0;
    return SEGMENT_MIN_MS + (this.segmentSeed / 0x1_0000_0000) * SEGMENT_SPAN_MS;
  }

  private apply(scale: number): ResolutionEvent | null {
    const next = this.clamp(Math.round(scale / STEP) * STEP);
    if (next === this.current) return null;
    this.current = next;
    this.frameEma = null;
    this.gpuEma = null;
    this.sinceChangeMs = 0;
    this.healthyMs = 0;
    this.slowMs = 0;
    return { kind: 'scale', scale: next };
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
