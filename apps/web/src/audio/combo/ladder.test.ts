import { describe, expect, it } from 'vitest';
import { isInMajorPentatonic, midiToHz, pentatonicMidi, RIVIERA_KEY } from '../music/theory.ts';
import {
  COMBO_TIER_COUNT,
  comboStepNote,
  LADDER_TOP_DEGREE,
  ladderDegree,
  tierFlourishDegrees,
  voiceComboDegree,
} from './ladder.ts';

const hzToMidi = (hz: number) => 69 + 12 * Math.log2(hz / 440);

describe('pentatonic theory', () => {
  it('converts MIDI to Hz around A4', () => {
    expect(midiToHz(69)).toBe(440);
    expect(midiToHz(81)).toBeCloseTo(880, 10);
    expect(midiToHz(74)).toBeCloseTo(587.33, 2);
  });

  it('walks the major pentatonic across octaves, including below the tonic', () => {
    const d = 62;
    expect([0, 1, 2, 3, 4, 5, 6].map((deg) => pentatonicMidi(d, deg))).toEqual([
      62, 64, 66, 69, 71, 74, 76,
    ]);
    expect(pentatonicMidi(d, -1)).toBe(59);
    expect(pentatonicMidi(d, -5)).toBe(50);
  });

  it('rejects fractional degrees', () => {
    expect(() => pentatonicMidi(62, 1.5)).toThrow(RangeError);
  });

  it('recognises pitch classes in and out of the scale in any octave', () => {
    expect(isInMajorPentatonic(62, 30)).toBe(true);
    expect(isInMajorPentatonic(62, 67)).toBe(false);
    expect(isInMajorPentatonic(62, 73)).toBe(false);
  });
});

describe('combo ladder', () => {
  it('climbs one pentatonic degree per coin from the first step', () => {
    expect(Array.from({ length: LADDER_TOP_DEGREE + 1 }, (_, i) => ladderDegree(i + 1))).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it('loops the top octave as a rising riff instead of climbing out of range', () => {
    const tail = Array.from({ length: 12 }, (_, i) => ladderDegree(LADDER_TOP_DEGREE + 2 + i));
    expect(tail).toEqual([6, 7, 8, 9, 10, 6, 7, 8, 9, 10, 6, 7]);
    for (let step = 1; step < 500; step++) {
      expect(ladderDegree(step)).toBeLessThanOrEqual(LADDER_TOP_DEGREE);
    }
  });

  it('rejects steps that are not positive integers', () => {
    expect(() => ladderDegree(0)).toThrow(RangeError);
    expect(() => ladderDegree(-3)).toThrow(RangeError);
    expect(() => ladderDegree(2.5)).toThrow(RangeError);
  });

  it('starts the Riviera ladder on D5 and plays a strictly rising melody', () => {
    const first = comboStepNote(1, 1, RIVIERA_KEY).tones[0]?.frequency ?? 0;
    expect(hzToMidi(first)).toBeCloseTo(74, 6);
    let previous = 0;
    for (let step = 1; step <= LADDER_TOP_DEGREE + 1; step++) {
      const freq = comboStepNote(step, 1, RIVIERA_KEY).tones[0]?.frequency ?? 0;
      expect(freq).toBeGreaterThan(previous);
      previous = freq;
    }
  });

  it('keeps every tone of every tier in the venue key', () => {
    for (let tier = 1; tier <= COMBO_TIER_COUNT; tier++) {
      for (let step = 1; step <= 20; step++) {
        for (const tone of comboStepNote(step, tier, RIVIERA_KEY).tones) {
          const midi = Math.round(hzToMidi(tone.frequency));
          expect(isInMajorPentatonic(62, midi)).toBe(true);
        }
      }
    }
  });

  it('thickens the voicing and brightness as tiers rise', () => {
    const counts = [1, 2, 3, 4, 5].map(
      (tier) => voiceComboDegree(3, tier, RIVIERA_KEY).tones.length,
    );
    expect(counts).toEqual([1, 2, 3, 3, 4]);
    const brightness = [1, 2, 3, 4, 5].map((t) => voiceComboDegree(3, t, RIVIERA_KEY).brightness);
    for (let i = 1; i < brightness.length; i++) {
      expect(brightness[i]).toBeGreaterThanOrEqual(brightness[i - 1] ?? 0);
    }
  });

  it('keeps the voiced chord at constant power so tiers do not just get louder', () => {
    for (let tier = 1; tier <= COMBO_TIER_COUNT; tier++) {
      const { tones } = voiceComboDegree(2, tier, RIVIERA_KEY);
      const sum = tones.reduce((s, t) => s + t.gain, 0);
      expect(sum).toBeLessThanOrEqual(Math.sqrt(2.5));
      expect(tones[0]?.gain).toBeGreaterThan(0.5);
    }
  });

  it('rejects tiers outside 0..5', () => {
    expect(() => voiceComboDegree(0, 6, RIVIERA_KEY)).toThrow(RangeError);
    expect(() => voiceComboDegree(0, -1, RIVIERA_KEY)).toThrow(RangeError);
    expect(() => tierFlourishDegrees(1.5)).toThrow(RangeError);
  });

  it('plays a rising flourish that starts higher on every tier and tops out on the ladder tonic', () => {
    expect(tierFlourishDegrees(0)).toEqual([]);
    expect(tierFlourishDegrees(1)).toEqual([0, 2, 4]);
    let previousStart = -1;
    for (let tier = 1; tier <= COMBO_TIER_COUNT; tier++) {
      const degrees = tierFlourishDegrees(tier);
      expect(degrees[0]).toBeGreaterThan(previousStart);
      previousStart = degrees[0] ?? 0;
      expect([...degrees].sort((a, b) => a - b)).toEqual(degrees);
    }
    expect(tierFlourishDegrees(COMBO_TIER_COUNT)).toEqual([5, 7, 9, 10]);
    for (let tier = 1; tier <= COMBO_TIER_COUNT; tier++) {
      expect(Math.max(...tierFlourishDegrees(tier))).toBeLessThanOrEqual(LADDER_TOP_DEGREE);
    }
  });
});
