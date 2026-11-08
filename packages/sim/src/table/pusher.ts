import { PUSHER } from './layout.ts';
import { PUSHER_CAM } from './tuning.ts';

export interface PusherMotion {
  /** Travel of the front face in metres, in (0, MAX_PUSHER_STROKE]. */
  readonly stroke: number;
  /** Ticks per full push-and-return cycle, an integer in [MIN_PUSHER_PERIOD_TICKS, MAX_PUSHER_PERIOD_TICKS]. */
  readonly periodTicks: number;
  /** Fraction of the cycle spent pushing forward, in [0.2, 0.8]. */
  readonly pushFraction: number;
}

export const DEFAULT_PUSHER_MOTION: PusherMotion = {
  stroke: PUSHER.stroke,
  periodTicks: PUSHER.periodTicks,
  pushFraction: PUSHER.pushFraction,
};

export const MAX_PUSHER_STROKE = PUSHER.maxStroke;
/** 1 s per cycle: faster and the pusher flicks coins instead of shoving them. */
export const MIN_PUSHER_PERIOD_TICKS = 60;
export const MAX_PUSHER_PERIOD_TICKS = 1800;

export function assertValidPusherMotion(motion: PusherMotion): void {
  const { stroke, periodTicks, pushFraction } = motion;
  if (!Number.isFinite(stroke) || stroke <= 0 || stroke > MAX_PUSHER_STROKE) {
    throw new RangeError(`Pusher stroke must be in (0, ${MAX_PUSHER_STROKE}] m, got ${stroke}`);
  }
  if (
    !Number.isInteger(periodTicks) ||
    periodTicks < MIN_PUSHER_PERIOD_TICKS ||
    periodTicks > MAX_PUSHER_PERIOD_TICKS
  ) {
    throw new RangeError(
      `Pusher periodTicks must be an integer in [${MIN_PUSHER_PERIOD_TICKS}, ${MAX_PUSHER_PERIOD_TICKS}], got ${periodTicks}`,
    );
  }
  if (!Number.isFinite(pushFraction) || pushFraction < 0.2 || pushFraction > 0.8) {
    throw new RangeError(`Pusher pushFraction must be in [0.2, 0.8], got ${pushFraction}`);
  }
}

/**
 * The cam's lift over one half-stroke, u from 0 (retracted) to 1 (full reach): smoothstep
 * 3u² − 2u³ blended with the ease-in u² by PUSHER_CAM.knock, which is
 * u² · ((1 − knock)(3 − 2u) + knock). It leaves retraction at zero velocity, so coins
 * resting on the block are never jerked at the back, and reaches full reach still moving
 * at 2 · knock times the mean speed of its half-stroke (see PUSHER_CAM for why). It rises
 * monotonically for any knock in [0, 1]. Built from + − * only, so V8 and JavaScriptCore
 * agree bit for bit.
 */
function ease(u: number): number {
  const { knock } = PUSHER_CAM;
  return u * u * ((1 - knock) * (3 - 2 * u) + knock);
}

/**
 * Pusher extension in [0, 1] (0 retracted, 1 extended) at cycle phase [0, 1). The
 * push and the return are each one cam half-stroke: velocity is continuous through
 * retraction and reverses at once at full reach, the cam's knock.
 */
export function pusherExtension(phase: number, pushFraction: number = PUSHER.pushFraction): number {
  if (phase < pushFraction) {
    return ease(phase / pushFraction);
  }
  return ease((1 - phase) / (1 - pushFraction));
}

/**
 * Deterministic pusher clock. It counts whole ticks into the current cycle, so the
 * phase is always the exact ratio tickInCycle / periodTicks and a cycle lasts exactly
 * periodTicks ticks. A speed change rescales the count to keep the phase (to within one
 * tick), so the block never jumps; a stroke or push-fraction change waits for the next
 * full retraction, where every curve is at extension 0, so it cannot teleport the
 * block into the coins either.
 */
export class PusherClock {
  #motion: PusherMotion;
  #pending: PusherMotion | undefined;
  #tickInCycle = 0;
  #cycles = 0;

  constructor(motion: PusherMotion = DEFAULT_PUSHER_MOTION) {
    assertValidPusherMotion(motion);
    this.#motion = { ...motion };
  }

  get motion(): PusherMotion {
    return this.#motion;
  }

  /** The motion that takes effect at the next full retraction, if one is queued. */
  get pendingMotion(): PusherMotion | undefined {
    return this.#pending;
  }

  get tickInCycle(): number {
    return this.#tickInCycle;
  }

  /** Cycle phase in [0, 1): 0 is full retraction. */
  get phase(): number {
    return this.#tickInCycle / this.#motion.periodTicks;
  }

  /** Completed cycles since the clock started. */
  get cycles(): number {
    return this.#cycles;
  }

  /** 0 retracted, 1 extended. */
  get extension(): number {
    return pusherExtension(this.phase, this.#motion.pushFraction);
  }

  /** Front face offset from its retracted position, in metres. */
  get offset(): number {
    return this.extension * this.#motion.stroke;
  }

  setMotion(motion: PusherMotion): void {
    assertValidPusherMotion(motion);
    const { periodTicks } = motion;
    this.#tickInCycle = Math.floor((this.#tickInCycle * periodTicks) / this.#motion.periodTicks);
    this.#motion = { ...this.#motion, periodTicks };
    const shapeChanged =
      motion.stroke !== this.#motion.stroke || motion.pushFraction !== this.#motion.pushFraction;
    this.#pending = shapeChanged ? { ...motion } : undefined;
  }

  advance(): void {
    this.#tickInCycle += 1;
    if (this.#tickInCycle < this.#motion.periodTicks) {
      return;
    }
    this.#tickInCycle = 0;
    this.#cycles += 1;
    if (this.#pending) {
      this.#motion = this.#pending;
      this.#pending = undefined;
    }
  }
}
