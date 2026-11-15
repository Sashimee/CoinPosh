import { describe, expect, it } from 'vitest';
import { createRng } from '../rng.ts';
import {
  buildCellarEvent,
  cellarEventCost,
  fillCellarBed,
  loopSafeFrequency,
  type CellarEvent,
} from './cellar.ts';

const RATE = 8000;

function bed(seconds = 4, seed = 1): [Float32Array, Float32Array] {
  const channels: [Float32Array, Float32Array] = [
    new Float32Array(seconds * RATE),
    new Float32Array(seconds * RATE),
  ];
  fillCellarBed(channels, RATE, createRng(seed));
  return channels;
}

function meanStep(data: Float32Array): number {
  let sum = 0;
  for (let i = 1; i < data.length; i++) sum += Math.abs((data[i] ?? 0) - (data[i - 1] ?? 0));
  return sum / (data.length - 1);
}

function rms(data: Iterable<number> & { readonly length: number }): number {
  let sum = 0;
  for (const v of data) sum += v ** 2;
  return Math.sqrt(sum / data.length);
}

describe('loopSafeFrequency', () => {
  it('snaps to a whole number of cycles per loop, close to the request', () => {
    const loop = 10 * 48000;
    for (const hz of [73.42, 110, 146.83, 0.01]) {
      const snapped = loopSafeFrequency(hz, loop, 48000);
      const cycles = (snapped * loop) / 48000;
      expect(cycles).toBeCloseTo(Math.round(cycles), 9);
      expect(cycles).toBeGreaterThanOrEqual(1);
      if (hz > 1) expect(Math.abs(snapped - hz)).toBeLessThanOrEqual(0.05);
    }
  });
});

describe('fillCellarBed', () => {
  it('loops without a click: the wrap step is no bigger than an ordinary step', () => {
    for (const data of bed()) {
      const wrap = Math.abs((data[0] ?? 0) - (data[data.length - 1] ?? 0));
      expect(wrap).toBeLessThan(meanStep(data) * 6);
    }
  });

  it('keeps its level steady across the seam instead of dipping in the crossfade', () => {
    for (const data of bed(8)) {
      const head = rms(data.subarray(0, RATE / 2));
      const middle = rms(data.subarray(3 * RATE, 3.5 * RATE));
      expect(head / middle).toBeGreaterThan(0.6);
      expect(head / middle).toBeLessThan(1.6);
    }
  });

  it('peaks at the bed level, with no NaN, and folds to mono without cancelling', () => {
    const [left, right] = bed();
    let peak = 0;
    for (const data of [left, right]) {
      for (const v of data) {
        expect(Number.isFinite(v)).toBe(true);
        peak = Math.max(peak, Math.abs(v));
      }
    }
    expect(peak).toBeCloseTo(0.6, 6);
    const mono = left.map((v, i) => (v + (right[i] ?? 0)) / 2);
    expect(rms(mono)).toBeGreaterThan(((rms(left) + rms(right)) / 2) * 0.6);
  });

  it('renders different noise per channel so the room sounds wide', () => {
    const [left, right] = bed();
    expect(left).not.toEqual(right);
  });

  it('rejects empty or mismatched channels', () => {
    const rng = createRng(1);
    expect(() => {
      fillCellarBed([], RATE, rng);
    }).toThrow(/channel/);
    expect(() => {
      fillCellarBed([new Float32Array(100), new Float32Array(99)], RATE, rng);
    }).toThrow(/same length/);
  });
});

describe('cellar events', () => {
  const events: CellarEvent[] = Array.from({ length: 400 }, (_, i) =>
    buildCellarEvent(createRng(i + 1)),
  );

  it('is mostly rising water drips with the odd bottle clink', () => {
    const drips = events.filter((e) => e.kind === 'drip');
    const clinks = events.filter((e) => e.kind === 'clink');
    expect(drips.length).toBeGreaterThan(clinks.length * 2);
    expect(clinks.length).toBeGreaterThan(0);
    for (const drip of drips) {
      expect(drip.endFrequency).toBeGreaterThan(drip.frequency * 1.5);
      expect(drip.sweep).toBeLessThan(0.05);
    }
  });

  it('stays soft and inside the stereo field', () => {
    for (const event of events) {
      expect(event.gain).toBeGreaterThan(0);
      expect(event.gain).toBeLessThanOrEqual(0.15);
      expect(Math.abs(event.pan)).toBeLessThanOrEqual(0.7);
    }
  });

  it('costs one source per drip and one per clink partial', () => {
    for (const event of events.slice(0, 40)) {
      expect(cellarEventCost(event)).toBe(event.kind === 'drip' ? 1 : event.partials.length);
    }
  });
});
