import { describe, expect, it } from 'vitest';
import { LinearMipmapLinearFilter, NoColorSpace, RepeatWrapping } from 'three/webgpu';
import {
  bakeNoiseTexels,
  createNoiseTexture,
  NOISE_CHANNELS,
  periodicGradientNoise,
} from './noise-texture.ts';

const SIZE = 64;
const texels = bakeNoiseTexels(SIZE, 3);

function channelAt(channel: number, column: number, row: number): number {
  return texels[(row * SIZE + column) * 4 + channel] ?? Number.NaN;
}

describe('periodicGradientNoise', () => {
  it('repeats over its period and is zero on lattice points', () => {
    for (const [x, y] of [
      [0.3, 0.7],
      [2.9, 1.1],
      [5.5, 3.25],
    ] as const) {
      const base = periodicGradientNoise(x, y, 6, 4, 9);
      expect(periodicGradientNoise(x + 6, y, 6, 4, 9)).toBeCloseTo(base, 12);
      expect(periodicGradientNoise(x, y - 4, 6, 4, 9)).toBeCloseTo(base, 12);
    }
    expect(periodicGradientNoise(2, 3, 6, 4, 9)).toBe(0);
  });

  it('stays inside [-1, 1]', () => {
    for (let i = 0; i < 2000; i += 1) {
      const value = periodicGradientNoise(i * 0.137, i * 0.071, 16, 16, 1);
      expect(Math.abs(value)).toBeLessThanOrEqual(1);
    }
  });
});

describe('bakeNoiseTexels', () => {
  it('is deterministic for a seed and differs between seeds', () => {
    expect(bakeNoiseTexels(SIZE, 3)).toEqual(texels);
    expect(bakeNoiseTexels(SIZE, 4)).not.toEqual(texels);
  });

  it('tiles seamlessly: the wrap step matches a neighbouring step in every channel', () => {
    for (const spec of Object.values(NOISE_CHANNELS)) {
      let wrap = 0;
      let inner = 0;
      for (let i = 0; i < SIZE; i += 1) {
        wrap += Math.abs(channelAt(spec.channel, SIZE - 1, i) - channelAt(spec.channel, 0, i));
        wrap += Math.abs(channelAt(spec.channel, i, SIZE - 1) - channelAt(spec.channel, i, 0));
        inner += Math.abs(channelAt(spec.channel, 1, i) - channelAt(spec.channel, 0, i));
        inner += Math.abs(channelAt(spec.channel, i, 1) - channelAt(spec.channel, i, 0));
      }
      expect(wrap, `channel ${spec.channel}`).toBeLessThan(inner * 2 + SIZE);
    }
  });

  it('uses the byte range around a mid-grey mean in every channel', () => {
    for (const spec of Object.values(NOISE_CHANNELS)) {
      let sum = 0;
      let lo = 255;
      let hi = 0;
      for (let i = spec.channel; i < texels.length; i += 4) {
        const v = texels[i] ?? 0;
        sum += v;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      const mean = sum / (SIZE * SIZE);
      expect(mean, `channel ${spec.channel}`).toBeGreaterThan(100);
      expect(mean, `channel ${spec.channel}`).toBeLessThan(155);
      expect(hi - lo, `channel ${spec.channel}`).toBeGreaterThan(80);
    }
  });

  it('rejects sizes too small to hold the cell counts', () => {
    expect(() => bakeNoiseTexels(8)).toThrow(RangeError);
    expect(() => bakeNoiseTexels(100.5)).toThrow(RangeError);
  });
});

describe('createNoiseTexture', () => {
  it('builds a repeating, mipmapped, non-colour data texture', () => {
    const texture = createNoiseTexture(SIZE);
    expect(texture.image.width).toBe(SIZE);
    expect(texture.wrapS).toBe(RepeatWrapping);
    expect(texture.wrapT).toBe(RepeatWrapping);
    expect(texture.minFilter).toBe(LinearMipmapLinearFilter);
    expect(texture.generateMipmaps).toBe(true);
    expect(texture.colorSpace).toBe(NoColorSpace);
    texture.dispose();
  });
});
