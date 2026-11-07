import { describe, expect, it } from 'vitest';
import { downsampleRgba, flipRows, gradeRadiance } from './radiance.ts';

describe('gradeRadiance', () => {
  const neutral = [1, 1, 1] as const;

  it('leaves texels under the cap untouched with a neutral tint', () => {
    const data = Float32Array.of(0.5, 1.25, 2, 1);
    expect(gradeRadiance(data, { maxRadiance: 6, tint: neutral })).toBe(0);
    expect(Array.from(data)).toEqual([0.5, 1.25, 2, 1]);
  });

  it('clips a hot texel to the cap while keeping its hue and alpha', () => {
    const data = Float32Array.of(6000, 3000, 1500, 1, 1, 1, 1, 1);
    expect(gradeRadiance(data, { maxRadiance: 8, tint: neutral })).toBe(1);
    const [r = 0, g = 0, b = 0, a = 0, ...rest] = Array.from(data);
    expect(r).toBeCloseTo(8, 5);
    expect(g / r).toBeCloseTo(0.5, 5);
    expect(b / r).toBeCloseTo(0.25, 5);
    expect(a).toBe(1);
    expect(rest).toEqual([1, 1, 1, 1]);
  });

  it('applies the tint before the cap', () => {
    const data = Float32Array.of(1, 1, 1, 1, 10, 10, 10, 1);
    gradeRadiance(data, { maxRadiance: 6, tint: [1.2, 1, 0.5] });
    expect(Array.from(data.slice(0, 3), (v) => Number(v.toFixed(4)))).toEqual([1.2, 1, 0.5]);
    expect(data[4]).toBeCloseTo(6, 5);
    expect(data[6]).toBeCloseTo(2.5, 5);
  });

  it('rejects a non-positive cap and negative tints', () => {
    expect(() =>
      gradeRadiance(Float32Array.of(1, 1, 1, 1), { maxRadiance: 0, tint: neutral }),
    ).toThrow(RangeError);
    expect(() =>
      gradeRadiance(Float32Array.of(1, 1, 1, 1), { maxRadiance: 4, tint: [1, -1, 1] }),
    ).toThrow(RangeError);
  });
});

describe('downsampleRgba', () => {
  it('averages each block, conserving mean radiance', () => {
    const data = new Float32Array(4 * 2 * 4);
    for (let i = 0; i < 8; i += 1) data.set([i, i * 2, 0, 1], i * 4);
    const out = downsampleRgba({ data, width: 4, height: 2 }, 2);
    expect([out.width, out.height]).toEqual([2, 1]);
    expect(Array.from(out.data)).toEqual([2.5, 5, 0, 1, 4.5, 9, 0, 1]);
  });

  it('returns an equal copy for a factor of one', () => {
    const data = Float32Array.of(1, 2, 3, 4);
    const out = downsampleRgba({ data, width: 1, height: 1 }, 1);
    expect(Array.from(out.data)).toEqual([1, 2, 3, 4]);
    expect(out.data).not.toBe(data);
  });

  it('rejects factors that do not divide the image and mismatched buffers', () => {
    const data = new Float32Array(3 * 2 * 4);
    expect(() => downsampleRgba({ data, width: 3, height: 2 }, 2)).toThrow(RangeError);
    expect(() => downsampleRgba({ data, width: 3, height: 2 }, 0)).toThrow(RangeError);
    expect(() => downsampleRgba({ data, width: 2, height: 2 }, 1)).toThrow(RangeError);
  });
});

describe('flipRows', () => {
  it('reverses row order and keeps texels within a row in place', () => {
    const data = Float32Array.from({ length: 2 * 3 * 4 }, (_, i) => i);
    const out = flipRows({ data, width: 2, height: 3 });
    expect(Array.from(out.data.subarray(0, 8))).toEqual(Array.from(data.subarray(16, 24)));
    expect(Array.from(out.data.subarray(8, 16))).toEqual(Array.from(data.subarray(8, 16)));
    expect(Array.from(out.data.subarray(16, 24))).toEqual(Array.from(data.subarray(0, 8)));
  });
});
