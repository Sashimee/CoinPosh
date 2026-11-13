import { describe, expect, it } from 'vitest';
import { artKey, displayByte, encodeFrame, frameYaw, swayFrames } from './art.ts';

const LIT = [1, 1, 1, 1];
const DARK = [0, 0, 0, 1];
const CLEAR = [0, 0, 0, 0];

describe('card art', () => {
  it('caches per kind and rarity', () => {
    expect(artKey({ kind: 'charm', rarity: 'rare' })).toBe('charm:rare');
    expect(artKey({ kind: 'safe', rarity: null })).toBe('safe:none');
    expect(artKey({ kind: 'charm', rarity: 'rare' })).not.toBe(
      artKey({ kind: 'charm', rarity: 'fine' }),
    );
  });

  it('sways on WebGPU and holds one still frame on WebGL2', () => {
    expect(swayFrames('webgpu')).toBeGreaterThan(1);
    expect(swayFrames('webgl2')).toBe(1);
  });

  it('loops the sway without a seam', () => {
    const frames = swayFrames('webgpu');
    const step = Math.abs(frameYaw(1, frames) - frameYaw(0, frames));
    const wrap = Math.abs(frameYaw(0, frames) - frameYaw(frames - 1, frames));
    expect(wrap).toBeCloseTo(step, 6);
    expect(frameYaw(0, 1)).not.toBe(0);
  });

  it('tone-maps linear light into display bytes, monotonically', () => {
    expect(displayByte(0)).toBe(0);
    expect(displayByte(-1)).toBe(0);
    expect(displayByte(100)).toBe(255);
    let previous = -1;
    for (const value of [0.001, 0.01, 0.05, 0.18, 0.5, 1, 2, 4]) {
      const byte = displayByte(value);
      expect(byte).toBeGreaterThan(previous);
      previous = byte;
    }
  });

  it('box-filters a supersampled frame premultiplied, keeping coverage as alpha', () => {
    const pixels = new Float32Array([...LIT, ...CLEAR, ...CLEAR, ...CLEAR]);
    const out = new Uint8ClampedArray(4);
    encodeFrame(pixels, 1, 2, false, out, 0);
    expect(out[0]).toBe(displayByte(1));
    expect(out[3]).toBe(Math.round(0.25 * 255));
  });

  it('leaves fully transparent pixels black and clear', () => {
    const out = new Uint8ClampedArray(4).fill(9);
    encodeFrame(new Float32Array(CLEAR), 1, 1, false, out, 0);
    expect([...out]).toEqual([0, 0, 0, 0]);
  });

  it('flips WebGL rows so the sheet reads top-down', () => {
    const pixels = new Float32Array([...LIT, ...LIT, ...DARK, ...DARK]);
    const topDown = new Uint8ClampedArray(16);
    encodeFrame(pixels, 2, 1, false, topDown, 0);
    expect([topDown[0], topDown[8]]).toEqual([displayByte(1), 0]);
    const bottomUp = new Uint8ClampedArray(16);
    encodeFrame(pixels, 2, 1, true, bottomUp, 0);
    expect([bottomUp[0], bottomUp[8]]).toEqual([0, displayByte(1)]);
  });

  it('writes each frame at its row offset in the sheet', () => {
    const sheet = new Uint8ClampedArray(8);
    encodeFrame(new Float32Array(LIT), 1, 1, false, sheet, 1);
    expect([sheet[0], sheet[4]]).toEqual([0, displayByte(1)]);
  });
});
