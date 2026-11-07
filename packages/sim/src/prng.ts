export type PrngState = readonly [number, number, number, number];

const TWO_POW_32 = 4294967296;

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

function assertUint32(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value >= TWO_POW_32) {
    throw new RangeError(`${name} must be an integer in [0, 2^32), got ${value}`);
  }
}

/**
 * Expands a 32-bit seed into four well-mixed words with SplitMix32, so that
 * neighbouring seeds (1, 2, 3...) produce unrelated streams and the all-zero
 * state that xoshiro can never leave is unreachable.
 */
function splitMix32(seed: number): [number, number, number, number] {
  let z = seed;
  const next = (): number => {
    z = (z + 0x9e3779b9) >>> 0;
    let t = z;
    t = Math.imul(t ^ (t >>> 16), 0x85ebca6b);
    t = Math.imul(t ^ (t >>> 13), 0xc2b2ae35);
    return (t ^ (t >>> 16)) >>> 0;
  };
  return [next(), next(), next(), next()];
}

/** xoshiro128** 1.1 (Blackman & Vigna), the sim's only source of randomness. */
export class Xoshiro128ss {
  #s0: number;
  #s1: number;
  #s2: number;
  #s3: number;

  private constructor(state: PrngState) {
    state.forEach((word, i) => {
      assertUint32(word, `PRNG state word ${i}`);
    });
    if (state.every((word) => word === 0)) {
      throw new RangeError('PRNG state must not be all zeros: xoshiro would only ever return 0');
    }
    [this.#s0, this.#s1, this.#s2, this.#s3] = state;
  }

  static fromSeed(seed: number): Xoshiro128ss {
    assertUint32(seed, 'PRNG seed');
    return new Xoshiro128ss(splitMix32(seed));
  }

  static fromState(state: PrngState): Xoshiro128ss {
    return new Xoshiro128ss(state);
  }

  state(): PrngState {
    return [this.#s0, this.#s1, this.#s2, this.#s3];
  }

  nextUint32(): number {
    const result = Math.imul(rotl(Math.imul(this.#s1, 5), 7), 9) >>> 0;
    const t = (this.#s1 << 9) >>> 0;
    this.#s2 = (this.#s2 ^ this.#s0) >>> 0;
    this.#s3 = (this.#s3 ^ this.#s1) >>> 0;
    this.#s1 = (this.#s1 ^ this.#s2) >>> 0;
    this.#s0 = (this.#s0 ^ this.#s3) >>> 0;
    this.#s2 = (this.#s2 ^ t) >>> 0;
    this.#s3 = rotl(this.#s3, 11);
    return result;
  }

  /** Uniform in [0, 1). Exact: a uint32 divided by 2^32 is representable as a double. */
  nextFloat(): number {
    return this.nextUint32() / TWO_POW_32;
  }

  /** Uniform in [min, max). */
  nextRange(min: number, max: number): number {
    if (!(max > min)) {
      throw new RangeError(`nextRange needs max > min, got [${min}, ${max})`);
    }
    return min + (max - min) * this.nextFloat();
  }

  /** Uniform integer in [0, bound), unbiased: draws below 2^32 mod bound are rejected. */
  nextInt(bound: number): number {
    if (!Number.isInteger(bound) || bound <= 0 || bound > TWO_POW_32) {
      throw new RangeError(`nextInt bound must be an integer in [1, 2^32], got ${bound}`);
    }
    const threshold = (TWO_POW_32 - bound) % bound;
    for (;;) {
      const r = this.nextUint32();
      if (r >= threshold) {
        return r % bound;
      }
    }
  }
}
