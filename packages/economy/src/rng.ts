export interface Rng {
  /** Uniform integer in [0, 2^32). */
  nextUint32(): number;
  /** Uniform integer in [0, maxExclusive), without modulo bias. */
  nextInt(maxExclusive: number): number;
  /** Uniform float in [0, 1). */
  nextFloat(): number;
}

const UINT32 = 0x1_0000_0000;

function splitmix32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
}

/** sfc32 seeded through splitmix32. Deterministic for a given 32-bit seed. */
export function createRng(seed: number): Rng {
  if (!Number.isInteger(seed)) {
    throw new RangeError(`createRng: seed must be an integer, got ${seed}`);
  }
  const init = splitmix32(seed);
  let a = init();
  let b = init();
  let c = init();
  let d = init();

  const nextUint32 = (): number => {
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) >>> 0;
    return t;
  };

  for (let i = 0; i < 12; i++) nextUint32();

  return {
    nextUint32,
    nextInt(maxExclusive) {
      if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > UINT32) {
        throw new RangeError(
          `nextInt: maxExclusive must be an integer in [1, 2^32], got ${maxExclusive}`,
        );
      }
      const limit = UINT32 - (UINT32 % maxExclusive);
      let value = nextUint32();
      while (value >= limit) value = nextUint32();
      return value % maxExclusive;
    },
    nextFloat() {
      return nextUint32() / UINT32;
    },
  };
}
