import { describe, expect, it } from 'vitest';
import { DataUtils } from 'three/webgpu';
import { gradeHalfFloatRadiance, SUNSET_HDRI } from './environment.ts';

function texels(...rgba: number[]): Uint16Array {
  return Uint16Array.from(rgba, (v) => DataUtils.toHalfFloat(v));
}

function read(data: Uint16Array): number[] {
  return Array.from(data, (v) => DataUtils.fromHalfFloat(v));
}

describe('gradeHalfFloatRadiance', () => {
  const neutral = [1, 1, 1] as const;

  it('leaves texels under the cap untouched with a neutral tint', () => {
    const data = texels(0.5, 1.25, 2, 1);
    expect(gradeHalfFloatRadiance(data, { maxRadiance: 6, tint: neutral })).toBe(0);
    expect(read(data)).toEqual([0.5, 1.25, 2, 1]);
  });

  it('clips a hot texel to the cap while keeping its hue and alpha', () => {
    const data = texels(6000, 3000, 1500, 1, 1, 1, 1, 1);
    expect(gradeHalfFloatRadiance(data, { maxRadiance: 8, tint: neutral })).toBe(1);
    const [r = 0, g = 0, b = 0, a = 0, ...rest] = read(data);
    expect(r).toBeCloseTo(8, 2);
    expect(g / r).toBeCloseTo(0.5, 2);
    expect(b / r).toBeCloseTo(0.25, 2);
    expect(a).toBe(1);
    expect(rest).toEqual([1, 1, 1, 1]);
  });

  it('applies the tint before the cap', () => {
    const data = texels(1, 1, 1, 1, 10, 10, 10, 1);
    gradeHalfFloatRadiance(data, { maxRadiance: 6, tint: [1.2, 1, 0.5] });
    const values = read(data);
    expect(values.slice(0, 3).map((v) => Number(v.toFixed(2)))).toEqual([1.2, 1, 0.5]);
    expect(values[4]).toBeCloseTo(6, 2);
    expect(values[6]).toBeCloseTo(2.5, 2);
  });

  it('rejects a non-positive cap and negative tints', () => {
    expect(() =>
      gradeHalfFloatRadiance(texels(1, 1, 1, 1), { maxRadiance: 0, tint: neutral }),
    ).toThrow(RangeError);
    expect(() =>
      gradeHalfFloatRadiance(texels(1, 1, 1, 1), { maxRadiance: 4, tint: [1, -1, 1] }),
    ).toThrow(RangeError);
  });
});

describe('SUNSET_HDRI', () => {
  it('points at the bundled CC0 asset with its sun bearing inside one turn', () => {
    expect(SUNSET_HDRI.url).toMatch(/venice_sunset_1k\.hdr/);
    expect(Math.abs(SUNSET_HDRI.sunYaw)).toBeLessThan(Math.PI);
  });
});
