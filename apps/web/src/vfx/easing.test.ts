import { describe, expect, it } from 'vitest';
import {
  clamp01,
  easeInBack,
  easeInOutCubic,
  easeOutBack,
  easeOutCubic,
  easeOutExpo,
  easeOutSpring,
  progress,
  pulse,
  stepSpring,
  type SpringState,
} from './easing.ts';

const sample = (fn: (t: number) => number, n = 200): number[] =>
  Array.from({ length: n + 1 }, (_, i) => fn(i / n));

describe('easings', () => {
  it.each([
    ['easeOutCubic', easeOutCubic],
    ['easeInOutCubic', easeInOutCubic],
    ['easeOutExpo', easeOutExpo],
    ['easeOutBack', easeOutBack()],
    ['easeInBack', easeInBack()],
    ['easeOutSpring', easeOutSpring()],
  ])('%s starts at 0, ends at 1 and clamps outside [0, 1]', (_name, fn) => {
    expect(fn(0)).toBeCloseTo(0, 6);
    expect(fn(1)).toBeCloseTo(1, 6);
    expect(fn(-3)).toBeCloseTo(fn(0), 6);
    expect(fn(7)).toBeCloseTo(fn(1), 6);
  });

  it('anticipates below 0 before travelling (easeInBack)', () => {
    expect(Math.min(...sample(easeInBack(1.7)))).toBeLessThan(-0.05);
  });

  it('overshoots past 1 and settles (easeOutBack, easeOutSpring)', () => {
    expect(Math.max(...sample(easeOutBack(1.7)))).toBeGreaterThan(1.05);
    expect(Math.max(...sample(easeOutSpring(1.5, 4)))).toBeGreaterThan(1.05);
  });

  it('pulse rises to 1 at the attack point and returns to 0', () => {
    expect(pulse(0, 0.2)).toBe(0);
    expect(pulse(0.2, 0.2)).toBeCloseTo(1, 6);
    expect(pulse(1, 0.2)).toBeCloseTo(0, 6);
  });

  it('progress handles a zero-length window as a step', () => {
    expect(progress(5, 5, 5)).toBe(1);
    expect(progress(4.9, 5, 5)).toBe(0);
    expect(progress(7.5, 5, 10)).toBe(0.5);
    expect(clamp01(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

describe('stepSpring', () => {
  it('settles on the target whatever the frame rate', () => {
    const run = (dt: number): SpringState => {
      const s: SpringState = { value: 0, velocity: 0 };
      for (let t = 0; t < 1; t += dt) stepSpring(s, 1, 20, 0.5, dt);
      return s;
    };
    const coarse = run(1 / 20);
    const fine = run(1 / 240);
    expect(coarse.value).toBeCloseTo(1, 3);
    expect(coarse.value).toBeCloseTo(fine.value, 2);
  });

  it('overshoots when underdamped and not when critically damped', () => {
    const peak = (damping: number): number => {
      const s: SpringState = { value: 0, velocity: 0 };
      let max = 0;
      for (let i = 0; i < 240; i++) {
        stepSpring(s, 1, 20, damping, 1 / 240);
        max = Math.max(max, s.value);
      }
      return max;
    };
    expect(peak(0.3)).toBeGreaterThan(1.2);
    expect(peak(1)).toBeLessThanOrEqual(1.0001);
  });

  it('ignores negative time', () => {
    const s: SpringState = { value: 0.5, velocity: 1 };
    stepSpring(s, 0, 20, 0.5, -1);
    expect(s).toEqual({ value: 0.5, velocity: 1 });
  });
});
