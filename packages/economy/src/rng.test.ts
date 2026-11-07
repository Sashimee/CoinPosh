import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createRng } from './rng.ts';

describe('createRng', () => {
  it('replays the same sequence for the same seed', () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const a = createRng(seed);
        const b = createRng(seed);
        for (let i = 0; i < 32; i++) expect(a.nextUint32()).toBe(b.nextUint32());
      }),
    );
  });

  it('diverges for neighbouring seeds', () => {
    const a = createRng(1);
    const b = createRng(2);
    const same = Array.from({ length: 16 }, () => a.nextUint32() === b.nextUint32());
    expect(same.filter(Boolean).length).toBeLessThan(2);
  });

  it('keeps nextInt inside [0, max) and nextFloat inside [0, 1)', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer({ min: 1, max: 2 ** 32 }), (seed, max) => {
        const rng = createRng(seed);
        for (let i = 0; i < 16; i++) {
          const n = rng.nextInt(max);
          expect(Number.isInteger(n)).toBe(true);
          expect(n).toBeGreaterThanOrEqual(0);
          expect(n).toBeLessThan(max);
          const f = rng.nextFloat();
          expect(f).toBeGreaterThanOrEqual(0);
          expect(f).toBeLessThan(1);
        }
      }),
    );
  });

  it('spreads nextInt evenly', () => {
    const rng = createRng(7);
    const buckets = new Array<number>(10).fill(0);
    const n = 100_000;
    for (let i = 0; i < n; i++) {
      const b = rng.nextInt(10);
      buckets[b] = (buckets[b] ?? 0) + 1;
    }
    for (const count of buckets) expect(count / n).toBeCloseTo(0.1, 2);
  });

  it('rejects invalid seeds and ranges', () => {
    expect(() => createRng(1.5)).toThrow(/seed must be an integer/);
    const rng = createRng(1);
    expect(() => rng.nextInt(0)).toThrow(RangeError);
    expect(() => rng.nextInt(2.5)).toThrow(RangeError);
    expect(() => rng.nextInt(2 ** 32 + 1)).toThrow(RangeError);
  });
});
