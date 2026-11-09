import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DataUtils } from 'three/webgpu';
import { decodeRadiance, encodeRadiance } from './hdri/bake.ts';
import { decodeRgbe, toHalfFloat, toHalfFloats, type RadianceImage } from './radiance.ts';

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function shipped(): ArrayBuffer {
  return toBuffer(readFileSync(new URL('./hdri/venice_sunset_512.hdr', import.meta.url)));
}

function ascii(text: string): number[] {
  return Array.from(text, (ch) => ch.charCodeAt(0));
}

describe('decodeRgbe', () => {
  it('decodes the shipped HDRI exactly as three’s HDRLoader does', () => {
    const ours = decodeRgbe(shipped());
    const theirs = decodeRadiance(shipped());
    expect([ours.width, ours.height]).toEqual([512, 256]);
    expect([ours.width, ours.height]).toEqual([theirs.width, theirs.height]);
    let worst = 0;
    for (let i = 0; i < ours.data.length; i += 1) {
      const a = ours.data[i] ?? 0;
      const b = theirs.data[i] ?? 0;
      worst = Math.max(worst, Math.abs(a - b) / Math.max(Math.abs(b), 1e-6));
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it('round-trips run-length-encoded scanlines within RGBE precision', () => {
    const width = 16;
    const height = 3;
    const data = new Float32Array(width * height * 4);
    for (let i = 0; i < width * height; i += 1) {
      data.set([0.01 + i * 0.13, i % 5 === 0 ? 4 : 0.5, i < 8 ? 0 : 2.5, 1], i * 4);
    }
    const source: RadianceImage = { width, height, data };
    const decoded = decodeRgbe(toBuffer(encodeRadiance(source)));
    expect([decoded.width, decoded.height]).toEqual([width, height]);
    for (let i = 0; i < data.length; i += 1) {
      const expected = data[i] ?? 0;
      expect(Math.abs((decoded.data[i] ?? 0) - expected)).toBeLessThanOrEqual(
        Math.max(expected, 4) / 128,
      );
    }
  });

  it('reads flat scanlines and zero-exponent texels as black', () => {
    const header = ascii('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 2\n');
    const bytes = Uint8Array.from([...header, 128, 64, 32, 129, 200, 200, 200, 0]);
    const { width, height, data } = decodeRgbe(toBuffer(bytes));
    expect([width, height]).toEqual([2, 1]);
    const [r = 0, g = 0, b = 0, a = 0] = data;
    expect(r).toBeCloseTo(256 / 255, 6);
    expect(g).toBeCloseTo(128 / 255, 6);
    expect(b).toBeCloseTo(64 / 255, 6);
    expect(a).toBe(1);
    expect(Array.from(data.slice(4))).toEqual([0, 0, 0, 1]);
  });

  it('rejects files it cannot read with a reason', () => {
    expect(() => decodeRgbe(toBuffer(Uint8Array.from(ascii('P6\n2 2\n'))))).toThrow(
      /#\? signature/,
    );
    expect(() => decodeRgbe(toBuffer(Uint8Array.from(ascii('#?RADIANCE\n\n+Y 1 +X 1\n'))))).toThrow(
      /orientation/,
    );
    expect(() =>
      decodeRgbe(toBuffer(Uint8Array.from([...ascii('#?RADIANCE\n\n-Y 2 +X 2\n'), 1, 2, 3]))),
    ).toThrow(/truncated/);
    expect(() => decodeRgbe(toBuffer(Uint8Array.from(ascii('#?RADIANCE\n'))))).toThrow(
      /resolution line/,
    );
    const overrun = [...ascii('#?RADIANCE\n\n-Y 1 +X 8\n'), 2, 2, 0, 8, 128 + 9, 1];
    expect(() => decodeRgbe(toBuffer(Uint8Array.from(overrun)))).toThrow(/overruns/);
  });
});

describe('toHalfFloat', () => {
  it('round-trips through three’s half decoder to within half an ulp', () => {
    for (const value of [0, 1, -1, 0.1, 0.333, 2.5, 6, 1234.5, 65504, 1e-3, 6.2e-5]) {
      const back = DataUtils.fromHalfFloat(toHalfFloat(value));
      expect(Math.abs(back - value)).toBeLessThanOrEqual(Math.abs(value) * 2 ** -11 + 2 ** -25);
    }
  });

  it('keeps subnormals, flushes what is below them and saturates past the range', () => {
    expect(DataUtils.fromHalfFloat(toHalfFloat(2 ** -24))).toBe(2 ** -24);
    expect(DataUtils.fromHalfFloat(toHalfFloat(3 * 2 ** -20))).toBe(3 * 2 ** -20);
    expect(toHalfFloat(2 ** -30)).toBe(0);
    expect(DataUtils.fromHalfFloat(toHalfFloat(1e6))).toBe(65504);
    expect(DataUtils.fromHalfFloat(toHalfFloat(-Infinity))).toBe(-65504);
    expect(Number.isNaN(DataUtils.fromHalfFloat(toHalfFloat(Number.NaN)))).toBe(true);
  });

  it('converts whole arrays', () => {
    expect(Array.from(toHalfFloats(Float32Array.of(1, 0.5, 0, -2)))).toEqual([
      0x3c00, 0x3800, 0, 0xc000,
    ]);
  });
});
