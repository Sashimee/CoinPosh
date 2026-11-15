import { describe, expect, it } from 'vitest';
import { createRng } from '../rng.ts';
import {
  DetuneVariator,
  humanizeTime,
  humanizeVelocity,
  MIN_DETUNE_STEP_CENTS,
  NoRepeatPicker,
  TONAL_DETUNE_CENTS,
} from './variation.ts';

const cents = (factor: number) => 1200 * Math.log2(factor);

describe('NoRepeatPicker', () => {
  it('never picks the same option twice in a row, and reaches every option', () => {
    const picker = new NoRepeatPicker<string>(createRng(3));
    const options = ['a', 'b', 'c', 'd'];
    const seen = new Set<string>();
    let previous: string | undefined;
    for (let i = 0; i < 400; i++) {
      const picked = picker.pick('k', options);
      expect(picked).not.toBe(previous);
      seen.add(picked);
      previous = picked;
    }
    expect(seen).toEqual(new Set(options));
  });

  it('keeps a separate history per key', () => {
    const always = (value: number) => () => value;
    const picker = new NoRepeatPicker<string>(always(0));
    expect(picker.pick('x', ['a', 'b'])).toBe('a');
    expect(picker.pick('y', ['a', 'b'])).toBe('a');
    expect(picker.pick('x', ['a', 'b'])).toBe('b');
  });

  it('copes with a single option and an rng at its upper edge', () => {
    const picker = new NoRepeatPicker<string>(() => 0.999999);
    expect(picker.pick('k', ['only'])).toBe('only');
    expect(picker.pick('k', ['only'])).toBe('only');
    expect(picker.pick('j', ['a', 'b', 'c'])).toBe('c');
    expect(picker.pick('j', ['a', 'b', 'c'])).toBe('b');
  });

  it('refuses an empty option list', () => {
    expect(() => new NoRepeatPicker<string>(createRng(1)).pick('k', [])).toThrow(RangeError);
  });
});

describe('DetuneVariator', () => {
  it('stays within the tonal detune and always moves from the last play', () => {
    const detune = new DetuneVariator<string>(createRng(9));
    let last: number | undefined;
    for (let i = 0; i < 500; i++) {
      const c = cents(detune.next('gold'));
      expect(Math.abs(c)).toBeLessThanOrEqual(TONAL_DETUNE_CENTS + 1e-9);
      if (last !== undefined) {
        expect(Math.abs(c - last)).toBeGreaterThanOrEqual(MIN_DETUNE_STEP_CENTS - 1e-9);
      }
      last = c;
    }
  });

  it('pushes a repeat away even at the edge of the range', () => {
    const detune = new DetuneVariator<string>(() => 0.9999);
    const first = cents(detune.next('k'));
    const second = cents(detune.next('k'));
    expect(first).toBeCloseTo(TONAL_DETUNE_CENTS, 2);
    expect(second).toBeCloseTo(TONAL_DETUNE_CENTS - MIN_DETUNE_STEP_CENTS, 2);
  });
});

describe('humanize', () => {
  it('keeps the very first note on the first sample and never moves a note before zero', () => {
    expect(humanizeTime(() => 0, 0, 0.01)).toBe(0);
    expect(humanizeTime(() => 0, 0.002, 0.01)).toBe(0);
    expect(humanizeTime(() => 1, 0.5, 0.01)).toBeCloseTo(0.51);
  });

  it('keeps velocities audible and never above full', () => {
    expect(humanizeVelocity(() => 0.999, 1, 0.1)).toBe(1);
    expect(humanizeVelocity(() => 0, 0.01, 0.1)).toBe(0.05);
    expect(humanizeVelocity(() => 0.5, 0.6, 0.1)).toBeCloseTo(0.6);
  });
});
