import { describe, expect, it } from 'vitest';
import { Spring, SPRINGS, SPRING_STEP } from './spring.ts';

function run(spring: Spring, seconds: number, frame = 1 / 60): number[] {
  const values: number[] = [];
  for (let t = 0; t < seconds; t += frame) {
    spring.step(frame);
    values.push(spring.value);
  }
  return values;
}

describe('Spring', () => {
  it.each(Object.entries(SPRINGS))('%s settles exactly on its target', (_name, config) => {
    const spring = new Spring(0, config);
    spring.setTarget(1);
    run(spring, 3);
    expect(spring.settled).toBe(true);
    expect(spring.value).toBe(1);
    expect(spring.velocity).toBe(0);
  });

  it('overshoots when underdamped and not when heavily damped', () => {
    const bouncy = new Spring(0, SPRINGS.bouncy);
    bouncy.setTarget(1);
    expect(Math.max(...run(bouncy, 1))).toBeGreaterThan(1.05);

    const damped = new Spring(0, { stiffness: 100, damping: 40 });
    damped.setTarget(1);
    expect(Math.max(...run(damped, 2))).toBeLessThanOrEqual(1);
  });

  it('gives the same motion whatever the frame rate', () => {
    const at60 = new Spring(0, SPRINGS.sheet);
    const at120 = new Spring(0, SPRINGS.sheet);
    at60.setTarget(1);
    at120.setTarget(1);
    for (let i = 0; i < 6; i++) at60.step(1 / 60);
    for (let i = 0; i < 12; i++) at120.step(1 / 120);
    expect(at120.value).toBeCloseTo(at60.value, 6);
  });

  it('clamps long frames so a stalled tab does not explode', () => {
    const spring = new Spring(0, SPRINGS.pop);
    spring.setTarget(1);
    spring.step(10);
    expect(Number.isFinite(spring.value)).toBe(true);
    expect(Math.abs(spring.value)).toBeLessThan(3);
  });

  it('ignores negative and sub-step time', () => {
    const spring = new Spring(0, SPRINGS.snappy);
    spring.setTarget(1);
    spring.step(-1);
    spring.step(SPRING_STEP / 2);
    expect(spring.value).toBe(0);
  });

  it('jumps with no motion for reduced motion', () => {
    const spring = new Spring(0, SPRINGS.bouncy);
    spring.setTarget(5);
    spring.step(0.05);
    spring.jump(2);
    expect(spring.value).toBe(2);
    expect(spring.target).toBe(2);
    expect(spring.step(1 / 60)).toBe(true);
  });

  it('moves away from rest after an impulse', () => {
    const spring = new Spring(0, SPRINGS.pop);
    spring.impulse(4);
    expect(spring.step(1 / 60)).toBe(false);
    expect(spring.value).toBeGreaterThan(0);
  });

  it('rejects invalid configs and non-finite numbers', () => {
    expect(() => new Spring(0, { stiffness: 0, damping: 1 })).toThrow(RangeError);
    expect(() => new Spring(0, { stiffness: 1, damping: -1 })).toThrow(RangeError);
    expect(() => new Spring(0, { stiffness: 1, damping: 1, mass: 0 })).toThrow(RangeError);
    expect(() => new Spring(Number.NaN, SPRINGS.gentle)).toThrow(RangeError);
    expect(() => {
      new Spring(0, SPRINGS.gentle).setTarget(Infinity);
    }).toThrow(RangeError);
  });
});
