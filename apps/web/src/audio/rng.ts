/** Returns a float in [0, 1). Injected everywhere so the pure audio logic is testable. */
export type Rng = () => number;

/** mulberry32: small, fast and good enough for sound variation and humanisation. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

export function elementAt<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new RangeError(`Audio table lookup out of range: index ${index} of ${items.length}`);
  }
  return item;
}
