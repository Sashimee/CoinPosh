import type { Rng } from '../rng.ts';
import { MIN_PITCH_STEP, PITCH_JITTER } from '../synth/impactSpec.ts';

/**
 * The coin bed's anti-repetition rule for any key (a prize family, a coin variant): pitch moves
 * by up to ±6 % and never lands within {@link MIN_PITCH_STEP} of the previous play.
 */
export class PitchVariator<K> {
  private readonly last = new Map<K, number>();

  constructor(private readonly rng: Rng) {}

  /** Returns a pitch factor in [1 - PITCH_JITTER, 1 + PITCH_JITTER]. */
  next(key: K): number {
    let offset = (this.rng() * 2 - 1) * PITCH_JITTER;
    const last = this.last.get(key);
    if (last !== undefined && Math.abs(offset - last) < MIN_PITCH_STEP) {
      const away = offset >= last ? 1 : -1;
      offset = last + away * MIN_PITCH_STEP;
      if (Math.abs(offset) > PITCH_JITTER) offset = last - away * MIN_PITCH_STEP;
    }
    this.last.set(key, offset);
    return 1 + offset;
  }
}

export function signedSpread(rng: Rng, spread: number): number {
  return 1 + (rng() * 2 - 1) * spread;
}
