export interface RenderClockOptions {
  /** Milliseconds per sim tick. */
  readonly tickMs: number;
  /** Arrival samples kept for the latency estimate; 45 is three quarters of a second at 60 Hz. */
  readonly window?: number;
  /** Interpolation delay floor, in ticks. One tick is the least that always has a frame to blend toward. */
  readonly minDelayTicks?: number;
  readonly maxDelayTicks?: number;
  /** Largest rate the render timeline may run fast or slow while it converges, as a fraction. */
  readonly maxWarp?: number;
  /** A timeline error past this many ticks is snapped instead of slewed. */
  readonly snapTicks?: number;
}

/**
 * Maps the render thread's clock onto the sim's tick timeline, so a frame can be drawn at a
 * fractional tick between two sim frames. The worker steps on a fixed 60 Hz schedule, so a
 * frame for tick `t` reaches this thread at `t * tickMs + offset + jitter`. The lowest
 * `arrival - t * tickMs` over a recent window estimates `offset`, the spread above it the
 * jitter, and the render point trails the estimate by one tick plus that jitter, so the frame
 * to blend toward has nearly always arrived.
 *
 * The estimate moves whenever a late frame lands, so the timeline never jumps to it: it runs
 * at most `maxWarp` (2%) fast or slow until it catches up, which no eye can see, and snaps only
 * when it is more than `snapTicks` off, as after a long stall or on a new worker epoch. That is
 * what keeps coins gliding at the same speed on every frame of a 120 Hz display, and never
 * stepping back in time.
 */
export class RenderClock {
  readonly tickMs: number;
  readonly #window: number;
  readonly #minDelay: number;
  readonly #maxDelay: number;
  readonly #maxWarp: number;
  readonly #snapTicks: number;
  readonly #samples: number[] = [];
  readonly #sorted: number[] = [];
  #epoch = Number.NaN;
  #targetLag = Number.NaN;
  #lag = Number.NaN;
  #lastNow = Number.NaN;
  #lastTick = Number.NaN;
  #newestTick = Number.NaN;
  #delayTicks: number;
  #snaps = 0;

  constructor(options: RenderClockOptions) {
    if (!(options.tickMs > 0)) {
      throw new RangeError(`RenderClock.tickMs must be positive, got ${options.tickMs}`);
    }
    this.tickMs = options.tickMs;
    this.#window = options.window ?? 45;
    this.#minDelay = options.minDelayTicks ?? 1.1;
    this.#maxDelay = options.maxDelayTicks ?? 4;
    this.#maxWarp = options.maxWarp ?? 0.02;
    this.#snapTicks = options.snapTicks ?? 6;
    this.#delayTicks = this.#minDelay;
  }

  /** Interpolation delay the timeline is converging on, in ticks. */
  get delayTicks(): number {
    return this.#delayTicks;
  }

  /** Times the timeline was snapped rather than slewed. */
  get snaps(): number {
    return this.#snaps;
  }

  /** Records that the frame for `tick` of worker epoch `epoch` became visible at `nowMs`. */
  observe(tick: number, epoch: number, nowMs: number): void {
    if (epoch !== this.#epoch) {
      this.#epoch = epoch;
      this.#samples.length = 0;
      // The worker's tick runs on across epochs, so #newestTick and #lastTick carry over and the
      // render point held through a pause never steps back when frames resume.
      this.#lag = Number.NaN;
    }
    if (!(tick <= this.#newestTick)) this.#newestTick = tick;
    this.#samples.push(nowMs - tick * this.tickMs);
    if (this.#samples.length > this.#window) this.#samples.shift();

    const sorted = this.#sorted;
    sorted.length = 0;
    for (const sample of this.#samples) sorted.push(sample);
    sorted.sort((a, b) => a - b);
    const offset = sorted[0] ?? 0;
    const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] ?? offset;
    this.#delayTicks = clamp(
      this.#minDelay + (p90 - offset) / this.tickMs,
      this.#minDelay,
      this.#maxDelay,
    );
    this.#targetLag = offset + this.#delayTicks * this.tickMs;
  }

  /**
   * The fractional sim tick to draw at `nowMs`, or null before the first frame. Never beyond the
   * newest observed tick and never earlier than the previous call.
   */
  renderTick(nowMs: number): number | null {
    if (Number.isNaN(this.#targetLag)) return null;
    if (
      Number.isNaN(this.#lag) ||
      Math.abs(this.#targetLag - this.#lag) > this.#snapTicks * this.tickMs
    ) {
      if (!Number.isNaN(this.#lag)) this.#snaps += 1;
      this.#lag = this.#targetLag;
    } else {
      const elapsed = Number.isNaN(this.#lastNow) ? 0 : Math.max(0, nowMs - this.#lastNow);
      const step = this.#maxWarp * elapsed;
      this.#lag += clamp(this.#targetLag - this.#lag, -step, step);
    }
    this.#lastNow = nowMs;
    let tick = (nowMs - this.#lag) / this.tickMs;
    if (tick > this.#newestTick) tick = this.#newestTick;
    if (tick < this.#lastTick) tick = this.#lastTick;
    this.#lastTick = tick;
    return tick;
  }
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
