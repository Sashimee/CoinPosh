import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DataUtils } from 'three/webgpu';
import { encodeRadiance } from './hdri/bake.ts';
import {
  convolveGgx,
  PREFILTERED_ENVIRONMENT,
  prefilterEquirect,
  prefilterRadianceFile,
} from './prefilter.ts';
import type { RadianceImage } from './radiance.ts';

function equirect(
  width: number,
  radiance: (direction: [number, number, number]) => number,
): RadianceImage {
  const height = width / 2;
  const data = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const latitude = Math.PI / 2 - ((y + 0.5) / height) * Math.PI;
    for (let x = 0; x < width; x += 1) {
      const longitude = ((x + 0.5) / width - 0.5) * 2 * Math.PI;
      const value = radiance([
        Math.cos(latitude) * Math.cos(longitude),
        Math.sin(latitude),
        Math.cos(latitude) * Math.sin(longitude),
      ]);
      data.set([value, value, value, 1], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

function texel(image: RadianceImage, x: number, y: number): number {
  return image.data[(y * image.width + x) * 4] ?? 0;
}

function brightest(image: RadianceImage): { x: number; y: number; value: number } {
  let best = { x: -1, y: -1, value: -Infinity };
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const value = texel(image, x, y);
      if (value > best.value) best = { x, y, value };
    }
  }
  return best;
}

/** Texels at or above half the peak: the lobe's footprint. */
function footprint(image: RadianceImage): number {
  const { value } = brightest(image);
  let count = 0;
  for (let i = 0; i < image.width * image.height; i += 1) {
    if ((image.data[i * 4] ?? 0) >= value / 2) count += 1;
  }
  return count / (image.width * image.height);
}

describe('prefilterEquirect', () => {
  it('halves each level, keeps the source as level 0 and leaves a constant sky constant', () => {
    const source = equirect(64, () => 0.75);
    const chain = prefilterEquirect(source, 4);
    expect(chain[0]).toBe(source);
    expect(chain.map((level) => [level.width, level.height])).toEqual([
      [64, 32],
      [32, 16],
      [16, 8],
      [8, 4],
    ]);
    for (const level of chain) {
      for (let i = 0; i < level.data.length; i += 4) {
        expect(level.data[i]).toBeCloseTo(0.75, 5);
        expect(level.data[i + 3]).toBe(1);
      }
    }
  });

  it('keeps a bright spot where it is and widens it with roughness', () => {
    const sun: [number, number, number] = [Math.cos(0.4), Math.sin(0.4), 0];
    const source = equirect(128, ([x, y, z]) => {
      const cos = x * sun[0] + y * sun[1] + z * sun[2];
      return cos > Math.cos(0.06) ? 50 : 0.1;
    });
    const chain = prefilterEquirect(source, 6);
    const spots = chain.map(brightest);
    chain.slice(1, 4).forEach((level, i) => {
      const spot = spots[i + 1];
      const expectedX = level.width / 2 - 0.5;
      const expectedY = (0.5 - 0.4 / Math.PI) * level.height - 0.5;
      expect(Math.abs((spot?.x ?? -1) - expectedX)).toBeLessThanOrEqual(1);
      expect(Math.abs((spot?.y ?? -1) - expectedY)).toBeLessThanOrEqual(1);
    });
    const spread = chain.slice(1).map(footprint);
    for (let k = 1; k < spread.length; k += 1) {
      expect(spread[k]).toBeGreaterThan(spread[k - 1] ?? Infinity);
    }
    const peaks = spots.map((spot) => spot.value);
    for (let k = 1; k < peaks.length; k += 1) {
      expect(peaks[k]).toBeLessThan(peaks[k - 1] ?? 0);
    }
  });

  it('ends on cosine-weighted irradiance at roughness 1', () => {
    const sky = equirect(64, ([, y]) => (y > 0 ? 1 : 0));
    const irradiance = convolveGgx(sky, 1, 16, 8);
    const column = 3;
    expect(texel(irradiance, column, 0)).toBeGreaterThan(0.97);
    expect(texel(irradiance, column, 7)).toBeLessThan(0.03);
    const nearHorizon = (texel(irradiance, column, 3) + texel(irradiance, column, 4)) / 2;
    expect(nearHorizon).toBeCloseTo(0.5, 1);
    expect(texel(irradiance, column, 3)).toBeGreaterThan(texel(irradiance, column, 4));
  });

  it('rejects images and roughness it cannot filter', () => {
    expect(() =>
      prefilterEquirect(
        equirect(64, () => 1),
        7,
      ),
    ).toThrow(/2:1 image divisible/);
    expect(() =>
      prefilterEquirect({ width: 64, height: 64, data: new Float32Array(64 * 64 * 4) }, 2),
    ).toThrow(/2:1/);
    expect(() =>
      convolveGgx(
        equirect(16, () => 1),
        0,
        8,
        4,
      ),
    ).toThrow(RangeError);
    expect(() =>
      convolveGgx(
        equirect(16, () => 1),
        1.5,
        8,
        4,
      ),
    ).toThrow(RangeError);
  });
});

describe('prefilterRadianceFile', () => {
  it('pre-filters the shipped HDRI into half-float levels that keep its sun in place', () => {
    const file = readFileSync(new URL('./hdri/venice_sunset_512.hdr', import.meta.url));
    const result = prefilterRadianceFile(
      file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength),
    );
    const { width, height, levels } = PREFILTERED_ENVIRONMENT;
    expect([result.width, result.height, result.levels.length]).toEqual([width, height, levels]);
    result.levels.forEach((level, k) => {
      const w = width >> k;
      const h = height >> k;
      expect(level).toBeInstanceOf(Uint16Array);
      expect(level.length).toBe(w * h * 4);
      let best = { x: -1, value: -1 };
      for (let i = 0; i < w * h; i += 1) {
        const value = DataUtils.fromHalfFloat(level[i * 4] ?? 0);
        expect(Number.isFinite(value)).toBe(true);
        if (value > best.value) best = { x: i % w, value };
      }
      // The sun is clipped flat in the source, so its peak only settles once a lobe averages it.
      if (k > 0 && k < levels - 1) expect(Math.abs(best.x - (307 >> k))).toBeLessThanOrEqual(1);
    });
  });

  it('refuses an HDRI that is not 512×256', () => {
    const small = encodeRadiance(equirect(16, () => 1));
    expect(() => prefilterRadianceFile(small.buffer as ArrayBuffer)).toThrow(/16×8, not 512×256/);
  });
});
