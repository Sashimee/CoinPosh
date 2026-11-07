import { describe, expect, it } from 'vitest';
import { DEFAULT_VOLUMES, sliderToGain } from './mixer.ts';
import { fillRoomImpulse } from './synth/buffers.ts';
import { createRng } from './rng.ts';

describe('sliderToGain', () => {
  it('mutes at zero and is unity at the top', () => {
    expect(sliderToGain(0)).toBe(0);
    expect(sliderToGain(1)).toBe(1);
  });

  it('follows a square-law taper: half travel is about -12 dB, and it never jumps', () => {
    const db = (v: number) => 20 * Math.log10(sliderToGain(v));
    expect(db(0.5)).toBeCloseTo(-12.04, 2);
    let previous = 0;
    for (let v = 0.01; v <= 1; v += 0.01) {
      const gain = sliderToGain(v);
      expect(gain).toBeGreaterThan(previous);
      expect(gain - previous).toBeLessThan(0.025);
      previous = gain;
    }
  });

  it('clamps out-of-range values and rejects non-numbers', () => {
    expect(sliderToGain(-1)).toBe(0);
    expect(sliderToGain(3)).toBe(1);
    expect(() => sliderToGain(Number.NaN)).toThrow(RangeError);
  });

  it('ships defaults with music sitting under the effects', () => {
    expect(DEFAULT_VOLUMES.music).toBeLessThan(DEFAULT_VOLUMES.sfx);
    for (const v of Object.values(DEFAULT_VOLUMES)) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('fillRoomImpulse', () => {
  it('is silent during the predelay, then decays by about 60 dB over t60', () => {
    const sampleRate = 8000;
    const data = new Float32Array(sampleRate);
    fillRoomImpulse(data, sampleRate, 1, createRng(5), 0.01);
    expect(data.slice(0, 80).every((s) => s === 0)).toBe(true);
    const rms = (from: number, to: number) =>
      Math.sqrt(data.slice(from, to).reduce((sum, s) => sum + s * s, 0) / (to - from));
    const early = rms(100, 900);
    const late = rms(7000, 7900);
    expect(early).toBeGreaterThan(0);
    expect(20 * Math.log10(late / early)).toBeLessThan(-40);
    expect(data.every(Number.isFinite)).toBe(true);
  });
});
