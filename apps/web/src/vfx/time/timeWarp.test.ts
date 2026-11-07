import { describe, expect, it } from 'vitest';
import { HIT_STOP_MS, TimeWarp } from './timeWarp.ts';

function run(warp: TimeWarp, seconds: number, dt = 1 / 240): number[] {
  const out: number[] = [];
  for (let t = 0; t < seconds; t += dt) out.push(warp.update(dt));
  return out;
}

describe('TimeWarp.hitStop', () => {
  it('freezes for the requested time then eases back to full speed', () => {
    const warp = new TimeWarp();
    warp.hitStop(HIT_STOP_MS.default);
    const scales = run(warp, 0.2);
    const frozen = scales.filter((s) => s === 0).length / 240;
    expect(frozen).toBeCloseTo(0.06, 1);
    expect(scales.at(-1)).toBe(1);
    const recovering = scales.filter((s) => s > 0 && s < 1);
    expect(recovering.length).toBeGreaterThan(3);
  });

  it('keeps the longer of overlapping freezes and clamps absurd ones', () => {
    const warp = new TimeWarp();
    warp.hitStop(80);
    warp.update(0.03);
    warp.hitStop(20);
    expect(warp.frozen).toBe(true);
    warp.update(0.045);
    expect(warp.frozen).toBe(true);
    warp.update(0.01);
    expect(warp.frozen).toBe(false);

    const long = new TimeWarp();
    long.hitStop(5000);
    long.update(0.121);
    expect(long.frozen).toBe(false);
  });

  it('rejects invalid durations', () => {
    expect(() => {
      new TimeWarp().hitStop(-1);
    }).toThrow(RangeError);
    expect(() => {
      new TimeWarp().hitStop(Number.NaN);
    }).toThrow(RangeError);
  });

  it('still freezes under reduced motion', () => {
    const warp = new TimeWarp();
    warp.reducedMotion = true;
    warp.hitStop(60);
    expect(warp.update(0.01)).toBe(0);
  });
});

describe('TimeWarp.slowMotion', () => {
  it('ramps down, holds the scale, then ramps back up', () => {
    const warp = new TimeWarp();
    warp.slowMotion({ scale: 0.35, holdMs: 900, rampInMs: 100, rampOutMs: 400 });
    const scales = run(warp, 1.6);
    expect(Math.min(...scales)).toBeCloseTo(0.35, 5);
    const held = scales.filter((s) => Math.abs(s - 0.35) < 1e-9).length / 240;
    expect(held).toBeCloseTo(0.9, 1);
    expect(scales.at(-1)).toBe(1);
  });

  it('combines with a hit-stop by taking the slower of the two', () => {
    const warp = new TimeWarp();
    warp.hitStop(60);
    warp.slowMotion({ scale: 0.5, holdMs: 500 });
    expect(warp.update(0.01)).toBe(0);
  });

  it('is skipped entirely under reduced motion', () => {
    const warp = new TimeWarp();
    warp.reducedMotion = true;
    warp.slowMotion({ scale: 0.2, holdMs: 900 });
    expect(Math.min(...run(warp, 0.5))).toBe(1);
  });

  it('validates its scale', () => {
    expect(() => {
      new TimeWarp().slowMotion({ scale: 1, holdMs: 10 });
    }).toThrow(RangeError);
    expect(() => {
      new TimeWarp().slowMotion({ scale: 0.5, holdMs: -1 });
    }).toThrow(RangeError);
  });
});
