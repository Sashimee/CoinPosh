import { describe, expect, it } from 'vitest';
import { Xoshiro128ss } from './prng.ts';

describe('Xoshiro128ss', () => {
  it('matches the reference C implementation from state [1, 2, 3, 4]', () => {
    const rng = Xoshiro128ss.fromState([1, 2, 3, 4]);
    const outputs = Array.from({ length: 8 }, () => rng.nextUint32());
    expect(outputs).toEqual([
      11520, 0, 5927040, 70819200, 2031721883, 1637235492, 1287239034, 3734860849,
    ]);
  });

  it('matches the reference C implementation after 1,000 draws from a high-bit state', () => {
    const rng = Xoshiro128ss.fromState([0x9e3779b9, 0x243f6a88, 0xb7e15162, 0xdeadbeef]);
    for (let i = 0; i < 1000; i++) {
      rng.nextUint32();
    }
    expect(rng.nextUint32()).toBe(2541037969);
  });

  it('produces the same stream for the same seed and pins the seed expansion', () => {
    const a = Xoshiro128ss.fromSeed(42);
    const b = Xoshiro128ss.fromSeed(42);
    const streamA = Array.from({ length: 64 }, () => a.nextUint32());
    const streamB = Array.from({ length: 64 }, () => b.nextUint32());
    expect(streamA).toEqual(streamB);
    expect(Xoshiro128ss.fromSeed(42).state()).toMatchInlineSnapshot(`
      [
        939911724,
        3948730756,
        321366731,
        3317318717,
      ]
    `);
  });

  it('gives adjacent seeds unrelated streams', () => {
    const first = Xoshiro128ss.fromSeed(1).nextUint32();
    const second = Xoshiro128ss.fromSeed(2).nextUint32();
    expect(first).not.toBe(second);
    expect(
      Xoshiro128ss.fromSeed(0)
        .state()
        .some((word) => word !== 0),
    ).toBe(true);
  });

  it('round-trips through state() so a replay can resume mid-stream', () => {
    const original = Xoshiro128ss.fromSeed(7);
    for (let i = 0; i < 100; i++) {
      original.nextUint32();
    }
    const resumed = Xoshiro128ss.fromState(original.state());
    expect(resumed.nextUint32()).toBe(original.nextUint32());
    expect(resumed.state()).toEqual(original.state());
  });

  it('keeps nextFloat in [0, 1) and nextRange inside its bounds', () => {
    const rng = Xoshiro128ss.fromSeed(123);
    for (let i = 0; i < 10_000; i++) {
      const f = rng.nextFloat();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
      const r = rng.nextRange(-0.5, 0.25);
      expect(r).toBeGreaterThanOrEqual(-0.5);
      expect(r).toBeLessThan(0.25);
    }
    expect(Xoshiro128ss.fromState([0, 0, 0, 1]).nextFloat()).toBe(0);
  });

  it('draws every value of nextInt roughly uniformly', () => {
    const rng = Xoshiro128ss.fromSeed(99);
    const counts = new Array<number>(6).fill(0);
    const draws = 60_000;
    for (let i = 0; i < draws; i++) {
      const v = rng.nextInt(6);
      counts[v] = (counts[v] ?? 0) + 1;
    }
    for (const count of counts) {
      expect(Math.abs(count - draws / 6)).toBeLessThan(draws / 6 / 20);
    }
    expect(rng.nextInt(1)).toBe(0);
    expect(Number.isInteger(rng.nextInt(4294967296))).toBe(true);
  });

  it('rejects invalid seeds, states and bounds', () => {
    expect(() => Xoshiro128ss.fromSeed(-1)).toThrow(RangeError);
    expect(() => Xoshiro128ss.fromSeed(1.5)).toThrow(RangeError);
    expect(() => Xoshiro128ss.fromSeed(4294967296)).toThrow(RangeError);
    expect(() => Xoshiro128ss.fromState([0, 0, 0, 0])).toThrow(/all zeros/);
    expect(() => Xoshiro128ss.fromState([1, 2, 3, Number.NaN])).toThrow(RangeError);
    const rng = Xoshiro128ss.fromSeed(1);
    expect(() => rng.nextInt(0)).toThrow(RangeError);
    expect(() => rng.nextInt(2.5)).toThrow(RangeError);
    expect(() => rng.nextRange(1, 1)).toThrow(RangeError);
    expect(() => rng.nextRange(0, Number.NaN)).toThrow(RangeError);
  });
});
