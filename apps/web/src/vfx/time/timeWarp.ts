import { easeInOutCubic, easeOutCubic, lerp } from '../easing.ts';

/** The art bible's hit-stop window for big events. */
export const HIT_STOP_MS = { min: 40, max: 80, default: 60 } as const;
/** Anything longer than this stops reading as impact and starts reading as a hang. */
const HIT_STOP_CEILING_MS = 120;
/** After the freeze, time eases back in over this long instead of snapping. */
const HIT_STOP_RECOVER_S = 0.06;

export interface SlowMoOptions {
  /** Time scale while held, in (0, 1). */
  readonly scale: number;
  /** Milliseconds (real time) at the held scale. */
  readonly holdMs: number;
  readonly rampInMs?: number;
  readonly rampOutMs?: number;
}

interface SlowMo {
  readonly scale: number;
  readonly rampIn: number;
  readonly hold: number;
  readonly rampOut: number;
  age: number;
}

/**
 * Hit-stop and slow-mo on one clock. `update(realDt)` returns the scale the integrator
 * multiplies its visual delta by (sim interpolation, coin spin, particles); 0 is a freeze.
 * Both run on real time, so a freeze always ends on schedule.
 *
 * Reduced motion keeps hit-stop (a pause is not motion) but drops slow-mo, whose long
 * drawn-out drift is exactly what the preference asks to avoid.
 */
export class TimeWarp {
  reducedMotion = false;
  private freezeLeft = 0;
  private recover = 0;
  private slowMo: SlowMo | null = null;
  private current = 1;

  get scale(): number {
    return this.current;
  }

  get frozen(): boolean {
    return this.freezeLeft > 0;
  }

  /** Freezes time for `ms` (clamped to 120 ms); overlapping calls keep the longer freeze. */
  hitStop(ms: number = HIT_STOP_MS.default): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(`hitStop needs a finite duration >= 0 ms, got ${ms}`);
    }
    const seconds = Math.min(ms, HIT_STOP_CEILING_MS) / 1000;
    this.freezeLeft = Math.max(this.freezeLeft, seconds);
    this.recover = 0;
  }

  slowMotion(options: SlowMoOptions): void {
    const { scale, holdMs } = options;
    if (!(scale > 0 && scale < 1) || !(holdMs >= 0)) {
      throw new RangeError(
        `slowMotion needs 0 < scale < 1 and holdMs >= 0, got ${scale}/${holdMs}`,
      );
    }
    if (this.reducedMotion) return;
    this.slowMo = {
      scale,
      rampIn: (options.rampInMs ?? 120) / 1000,
      hold: holdMs / 1000,
      rampOut: (options.rampOutMs ?? 380) / 1000,
      age: 0,
    };
  }

  update(realDt: number): number {
    const dt = Math.max(0, realDt);
    let freeze = 1;
    if (this.freezeLeft > 0) {
      this.freezeLeft -= dt;
      freeze = 0;
      if (this.freezeLeft <= 0) this.recover = HIT_STOP_RECOVER_S;
    } else if (this.recover > 0) {
      this.recover = Math.max(0, this.recover - dt);
      freeze = easeOutCubic(1 - this.recover / HIT_STOP_RECOVER_S);
    }
    this.current = Math.min(freeze, this.slowMoScale(dt));
    return this.current;
  }

  reset(): void {
    this.freezeLeft = 0;
    this.recover = 0;
    this.slowMo = null;
    this.current = 1;
  }

  private slowMoScale(dt: number): number {
    const s = this.slowMo;
    if (!s) return 1;
    s.age += dt;
    const { rampIn, hold, rampOut, scale } = s;
    if (s.age < rampIn) return lerp(1, scale, easeInOutCubic(s.age / rampIn));
    if (s.age < rampIn + hold) return scale;
    if (s.age < rampIn + hold + rampOut) {
      return lerp(scale, 1, easeInOutCubic((s.age - rampIn - hold) / rampOut));
    }
    this.slowMo = null;
    return 1;
  }
}
