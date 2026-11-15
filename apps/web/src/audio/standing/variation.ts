import { clamp, elementAt, type Rng } from '../rng.ts';

/**
 * Picks one of `count` options per key and never the same one twice in a row, so a chime motif
 * or a sparkle figure always answers the last play with a different shape.
 */
export class NoRepeatPicker<K> {
  private readonly last = new Map<K, number>();

  constructor(private readonly rng: Rng) {}

  pick<T>(key: K, options: readonly T[]): T {
    if (options.length === 0) throw new RangeError('NoRepeatPicker needs at least one option');
    const previous = this.last.get(key);
    let index: number;
    if (options.length === 1 || previous === undefined || previous >= options.length) {
      index = Math.floor(this.rng() * options.length);
    } else {
      index = Math.floor(this.rng() * (options.length - 1));
      if (index >= previous) index++;
    }
    index = clamp(index, 0, options.length - 1);
    this.last.set(key, index);
    return elementAt(options, index);
  }
}

/**
 * A tonal cue cannot take the coin bed's ±6 % pitch jitter without leaving the venue key, so it
 * detunes by a few cents instead: enough that two plays never sit on the same sample, not
 * enough to sound out of tune against the band.
 */
export const TONAL_DETUNE_CENTS = 6;
export const MIN_DETUNE_STEP_CENTS = 2;

export class DetuneVariator<K> {
  private readonly last = new Map<K, number>();

  constructor(private readonly rng: Rng) {}

  /** Returns a frequency factor within ±{@link TONAL_DETUNE_CENTS} cents. */
  next(key: K): number {
    let cents = (this.rng() * 2 - 1) * TONAL_DETUNE_CENTS;
    const last = this.last.get(key);
    if (last !== undefined && Math.abs(cents - last) < MIN_DETUNE_STEP_CENTS) {
      const away = cents >= last ? 1 : -1;
      cents = last + away * MIN_DETUNE_STEP_CENTS;
      if (Math.abs(cents) > TONAL_DETUNE_CENTS) cents = last - away * MIN_DETUNE_STEP_CENTS;
    }
    this.last.set(key, cents);
    return 2 ** (cents / 1200);
  }
}

/** Nudges a note's onset by up to ±`seconds`, never before the cue's own start. */
export function humanizeTime(rng: Rng, at: number, seconds: number): number {
  return at === 0 ? 0 : Math.max(0, at + (rng() * 2 - 1) * seconds);
}

export function humanizeVelocity(rng: Rng, velocity: number, spread: number): number {
  return clamp(velocity * (1 + (rng() * 2 - 1) * spread), 0.05, 1);
}
