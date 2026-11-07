import { describe, expect, it } from 'vitest';
import {
  bakeHdri,
  decodeRadiance,
  downsampleHalf,
  encodeRadiance,
  gradeRadiance,
  type RadianceImage,
} from './bake.ts';

const neutral = [1, 1, 1] as const;

function image(width: number, height: number, texel: (x: number, y: number) => number[]) {
  const data = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data.set(texel(x, y), (y * width + x) * 4);
  }
  return { width, height, data } satisfies RadianceImage;
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function encoded(source: RadianceImage): ArrayBuffer {
  return toBuffer(encodeRadiance(source));
}

describe('gradeRadiance', () => {
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

describe('downsampleHalf', () => {
  it('averages each 2×2 block in linear light', () => {
    const source = image(4, 2, (x) => [x, x * 2, 8, 1]);
    const half = downsampleHalf(source);
    expect([half.width, half.height]).toEqual([2, 1]);
    expect(Array.from(half.data)).toEqual([0.5, 1, 8, 1, 2.5, 5, 8, 1]);
  });

  it('rejects odd dimensions', () => {
    expect(() => downsampleHalf(image(3, 2, () => [0, 0, 0, 1]))).toThrow(RangeError);
  });
});

describe('encodeRadiance', () => {
  it('round-trips through three’s HDRLoader within RGBE precision', () => {
    const source = image(40, 3, (x, y) => [
      x < 20 ? 0.25 : 0.01 * x + y,
      x % 3 === 0 ? 5.5 : 0.003,
      0,
      1,
    ]);
    const decoded = decodeRadiance(encoded(source));
    expect([decoded.width, decoded.height]).toEqual([40, 3]);
    for (let i = 0; i < source.data.length; i += 4) {
      for (let c = 0; c < 3; c += 1) {
        const expected = source.data[i + c] ?? 0;
        const peak = Math.max(
          source.data[i] ?? 0,
          source.data[i + 1] ?? 0,
          source.data[i + 2] ?? 0,
        );
        expect(Math.abs((decoded.data[i + c] ?? 0) - expected)).toBeLessThanOrEqual(peak / 128);
      }
    }
  });

  it('compresses flat scanlines with runs', () => {
    const flat = encodeRadiance(image(512, 4, () => [1, 0.5, 0.25, 1]));
    const raw = 512 * 4 * 4;
    expect(flat.byteLength).toBeLessThan(raw / 20);
  });

  it('writes black texels as zero and rejects widths RLE cannot encode', () => {
    const decoded = decodeRadiance(encoded(image(8, 1, () => [0, 0, 0, 1])));
    expect(Array.from(decoded.data).filter((_, i) => i % 4 !== 3)).toEqual(new Array(24).fill(0));
    expect(() => encodeRadiance(image(4, 1, () => [1, 1, 1, 1]))).toThrow(RangeError);
  });
});

describe('bakeHdri', () => {
  it('grades, halves and re-encodes a source file', () => {
    const source = image(32, 16, (x) => [x === 5 ? 900 : 0.5, 0.5, 0.5, 1]);
    const baked = decodeRadiance(
      toBuffer(bakeHdri(encoded(source), { maxRadiance: 6, tint: [2, 1, 1] }, 1)),
    );
    expect([baked.width, baked.height]).toEqual([16, 8]);
    let peak = 0;
    for (let i = 0; i < baked.data.length; i += 4) peak = Math.max(peak, baked.data[i] ?? 0);
    expect(peak).toBeLessThanOrEqual(6.1);
    expect(baked.data[0]).toBeCloseTo(1, 1);
    expect(baked.data[1]).toBeCloseTo(0.5, 1);
  });
});
