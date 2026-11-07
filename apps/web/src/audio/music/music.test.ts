import { describe, expect, it } from 'vitest';
import { layerGain, RIVIERA_LAYERS, smoothstep, STEM_IDS, type LayerSpec } from './layers.ts';
import { foldLoopTail } from './render.ts';
import { composeRiviera, loopSeconds } from './riviera.ts';
import { isInMajorPentatonic } from './theory.ts';

describe('intensity layers', () => {
  const layer: LayerSpec = { stem: 'drums', enterAt: 0.4, fullAt: 0.6, level: 0.5, pan: 0 };

  it('is silent below its entry, full above its peak and smooth between', () => {
    expect(layerGain(layer, 0)).toBe(0);
    expect(layerGain(layer, 0.4)).toBe(0);
    expect(layerGain(layer, 0.5)).toBeCloseTo(0.25, 10);
    expect(layerGain(layer, 0.6)).toBe(0.5);
    expect(layerGain(layer, 1)).toBe(0.5);
  });

  it('clamps intensity outside 0..1', () => {
    expect(layerGain(layer, 7)).toBe(0.5);
    expect(layerGain(layer, -2)).toBe(0);
  });

  it('treats a zero-width ramp as a step', () => {
    expect(smoothstep(0, 0, 0)).toBe(1);
    expect(smoothstep(0.5, 0.5, 0.49)).toBe(0);
  });

  it('keeps the Riviera bed audible at zero intensity and adds layers in order', () => {
    expect(RIVIERA_LAYERS.map((l) => l.stem).sort()).toEqual([...STEM_IDS].sort());
    const audibleAt = (x: number) => RIVIERA_LAYERS.filter((l) => layerGain(l, x) > 0).length;
    expect(audibleAt(0)).toBe(1);
    expect(audibleAt(1)).toBe(RIVIERA_LAYERS.length);
    let previous = 0;
    for (let x = 0; x <= 1; x += 0.05) {
      expect(audibleAt(x)).toBeGreaterThanOrEqual(previous);
      previous = audibleAt(x);
    }
  });

  it('keeps every stem pan inside the mono-safe range', () => {
    for (const l of RIVIERA_LAYERS) expect(Math.abs(l.pan)).toBeLessThanOrEqual(0.3);
  });
});

describe('Riviera composition', () => {
  const song = composeRiviera();
  const loopBeats = song.bars * song.beatsPerBar;

  it('is deterministic for a seed and varies the humanisation between seeds', () => {
    expect(composeRiviera()).toEqual(song);
    expect(composeRiviera(2).keys).not.toEqual(song.keys);
  });

  it('is an 8-bar loop at a lounge tempo', () => {
    expect(song.bars).toBe(8);
    expect(song.bpm).toBeGreaterThanOrEqual(80);
    expect(song.bpm).toBeLessThanOrEqual(100);
    expect(loopSeconds(song)).toBeCloseTo((8 * 4 * 60) / song.bpm, 10);
  });

  it('starts every event inside the loop', () => {
    for (const stem of [song.keys, song.bass, song.vibes, song.drums]) {
      expect(stem.length).toBeGreaterThan(0);
      for (const event of stem) {
        expect(event.time).toBeGreaterThanOrEqual(0);
        expect(event.time).toBeLessThan(loopBeats);
        expect(event.velocity).toBeGreaterThan(0);
        expect(event.velocity).toBeLessThanOrEqual(1);
      }
    }
  });

  it('writes the vibes line in the same pentatonic the combo ladder uses', () => {
    for (const note of song.vibes)
      expect(isInMajorPentatonic(song.tonicMidi, note.midi)).toBe(true);
  });

  it('keeps the bass in an upright register and every note positive length', () => {
    for (const note of [...song.bass, ...song.keys, ...song.vibes]) {
      expect(note.duration).toBeGreaterThan(0);
    }
    for (const note of song.bass) {
      expect(note.midi).toBeGreaterThanOrEqual(28);
      expect(note.midi).toBeLessThanOrEqual(55);
    }
  });

  it('plays a shaker on every sixteenth', () => {
    expect(song.drums.filter((d) => d.kind === 'shaker')).toHaveLength(song.bars * 16);
  });
});

describe('foldLoopTail', () => {
  it('wraps samples past the loop point back onto the start', () => {
    const rendered = new Float32Array([1, 2, 3, 4, 10, 20, 30]);
    expect(Array.from(foldLoopTail(rendered, 4))).toEqual([11, 22, 33, 4]);
  });

  it('wraps a tail longer than the loop more than once', () => {
    const rendered = new Float32Array([1, 1, 1, 1, 1]);
    expect(Array.from(foldLoopTail(rendered, 2))).toEqual([3, 2]);
  });

  it('returns the loop untouched when nothing rang past it', () => {
    expect(Array.from(foldLoopTail(new Float32Array([0.5, -0.5]), 2))).toEqual([0.5, -0.5]);
  });

  it('rejects a non-positive or fractional loop length', () => {
    expect(() => foldLoopTail(new Float32Array(4), 0)).toThrow(RangeError);
    expect(() => foldLoopTail(new Float32Array(4), 1.5)).toThrow(RangeError);
  });
});
