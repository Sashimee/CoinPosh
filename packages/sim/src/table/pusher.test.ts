import { describe, expect, it } from 'vitest';
import { PUSHER } from './layout.ts';
import {
  DEFAULT_PUSHER_MOTION,
  MAX_PUSHER_PERIOD_TICKS,
  MAX_PUSHER_STROKE,
  MIN_PUSHER_PERIOD_TICKS,
  PusherClock,
  pusherExtension,
  type PusherMotion,
} from './pusher.ts';

function offsets(clock: PusherClock, ticks: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < ticks; i++) {
    clock.advance();
    out.push(clock.offset);
  }
  return out;
}

/** The most an eased half-stroke can move the block in one tick: smoothstep peaks at slope 1.5. */
function peakStep({ stroke, periodTicks, pushFraction }: PusherMotion): number {
  return (1.5 * stroke) / (periodTicks * Math.min(pushFraction, 1 - pushFraction));
}

describe('pusherExtension', () => {
  it('is retracted at phase 0, fully extended at the push fraction and back by the end', () => {
    for (const pushFraction of [0.2, 0.5, 0.6, 0.8]) {
      expect(pusherExtension(0, pushFraction)).toBe(0);
      expect(pusherExtension(pushFraction, pushFraction)).toBe(1);
      expect(pusherExtension(1 - 1e-12, pushFraction)).toBeCloseTo(0, 9);
    }
  });

  it('rises monotonically while pushing and falls monotonically on the return', () => {
    const pf = PUSHER.pushFraction;
    let previous = -1;
    for (let i = 0; i <= 600; i++) {
      const e = pusherExtension((pf * i) / 600, pf);
      expect(e).toBeGreaterThanOrEqual(previous);
      previous = e;
    }
    for (let i = 1; i < 400; i++) {
      const e = pusherExtension(pf + ((1 - pf) * i) / 400, pf);
      expect(e).toBeLessThanOrEqual(previous);
      previous = e;
    }
  });

  it('eases into both turnarounds so coins on the block are never jerked', () => {
    const pf = PUSHER.pushFraction;
    const du = 1e-6;
    const slope = (phase: number): number =>
      (pusherExtension(phase + du, pf) - pusherExtension(phase, pf)) / du;
    expect(Math.abs(slope(0))).toBeLessThan(1e-3);
    expect(Math.abs(slope(pf - du))).toBeLessThan(1e-3);
    expect(Math.abs(slope(1 - 2 * du))).toBeLessThan(1e-3);
    expect(slope(pf / 2)).toBeCloseTo(1.5 / pf, 3);
  });

  it('pushes slower than it returns with the default motion', () => {
    const pf = PUSHER.pushFraction;
    const du = 1e-4;
    const pushPeak = (pusherExtension(pf / 2 + du, pf) - pusherExtension(pf / 2, pf)) / du;
    const mid = pf + (1 - pf) / 2;
    const returnPeak = (pusherExtension(mid, pf) - pusherExtension(mid + du, pf)) / du;
    expect(returnPeak).toBeGreaterThan(pushPeak);
  });
});

describe('PusherClock', () => {
  it('runs one cycle in exactly periodTicks ticks and repeats it bit for bit', () => {
    const clock = new PusherClock();
    const first = offsets(clock, PUSHER.periodTicks);
    expect(clock.tickInCycle).toBe(0);
    expect(clock.cycles).toBe(1);
    expect(first.at(-1)).toBe(0);
    expect(Math.max(...first)).toBe(PUSHER.stroke);
    expect(offsets(clock, PUSHER.periodTicks)).toEqual(first);
  });

  it('moves the block no further in a tick than its eased peak speed, under 2 mm, at the default motion', () => {
    const peak = peakStep(DEFAULT_PUSHER_MOTION);
    expect(peak).toBeLessThan(0.002);
    const steps = offsets(new PusherClock(), PUSHER.periodTicks);
    let previous = 0;
    let fastest = 0;
    for (const offset of steps) {
      fastest = Math.max(fastest, Math.abs(offset - previous));
      previous = offset;
    }
    expect(fastest).toBeLessThanOrEqual(peak);
    expect(fastest).toBeGreaterThan(0.95 * peak);
  });

  it('keeps the phase when the speed changes, so the block does not jump', () => {
    const clock = new PusherClock();
    offsets(clock, 60);
    const before = clock.offset;
    clock.setMotion({ ...DEFAULT_PUSHER_MOTION, periodTicks: 480 });
    expect(clock.motion.periodTicks).toBe(480);
    expect(clock.pendingMotion).toBeUndefined();
    expect(clock.tickInCycle).toBe(120);
    expect(clock.offset).toBe(before);
    const next = offsets(clock, 1)[0] ?? Number.NaN;
    expect(Math.abs(next - before)).toBeLessThan(0.001);
  });

  it('rounds the rescaled tick down, staying inside the new cycle', () => {
    const clock = new PusherClock();
    offsets(clock, 239);
    clock.setMotion({ ...DEFAULT_PUSHER_MOTION, periodTicks: 61 });
    expect(clock.tickInCycle).toBe(60);
    clock.advance();
    expect(clock.tickInCycle).toBe(0);
    expect(clock.cycles).toBe(1);
  });

  it('defers a stroke or push-fraction change to the next full retraction', () => {
    const clock = new PusherClock();
    offsets(clock, 100);
    const wanted: PusherMotion = { stroke: 0.05, periodTicks: 120, pushFraction: 0.5 };
    clock.setMotion(wanted);
    expect(clock.motion).toEqual({ ...DEFAULT_PUSHER_MOTION, periodTicks: 120 });
    expect(clock.pendingMotion).toEqual(wanted);
    const peak = peakStep({ ...DEFAULT_PUSHER_MOTION, periodTicks: 120 });
    let previous = clock.offset;
    while (clock.cycles === 0) {
      clock.advance();
      expect(Math.abs(clock.offset - previous)).toBeLessThanOrEqual(peak);
      previous = clock.offset;
    }
    expect(clock.offset).toBe(0);
    expect(clock.motion).toEqual(wanted);
    expect(clock.pendingMotion).toBeUndefined();
    expect(Math.max(...offsets(clock, 120))).toBe(0.05);
  });

  it('drops a queued shape change when the caller asks for the current shape again', () => {
    const clock = new PusherClock();
    clock.setMotion({ ...DEFAULT_PUSHER_MOTION, stroke: 0.05 });
    expect(clock.pendingMotion).toBeDefined();
    clock.setMotion(DEFAULT_PUSHER_MOTION);
    expect(clock.pendingMotion).toBeUndefined();
  });

  it('copies the motion it is given, so a caller mutating it cannot steer the sim', () => {
    const motion = { stroke: 0.08, periodTicks: 240, pushFraction: 0.6 };
    const clock = new PusherClock(motion);
    motion.periodTicks = 60;
    expect(clock.motion.periodTicks).toBe(PUSHER.periodTicks);
  });

  it.each<[string, Partial<PusherMotion>, RegExp]>([
    ['zero stroke', { stroke: 0 }, /stroke must be in \(0, 0.12\] m, got 0/],
    ['stroke past the guides', { stroke: 0.125 }, /got 0.125/],
    ['NaN stroke', { stroke: Number.NaN }, /got NaN/],
    ['fractional period', { periodTicks: 240.5 }, /periodTicks must be an integer in \[60, 1800\]/],
    ['too fast', { periodTicks: MIN_PUSHER_PERIOD_TICKS - 1 }, /got 59/],
    ['too slow', { periodTicks: MAX_PUSHER_PERIOD_TICKS + 1 }, /got 1801/],
    ['push fraction too small', { pushFraction: 0.19 }, /pushFraction must be in \[0.2, 0.8\]/],
    ['push fraction too large', { pushFraction: 0.81 }, /got 0.81/],
  ])('rejects %s, leaving the clock unchanged', (_name, change, error) => {
    const motion = { ...DEFAULT_PUSHER_MOTION, ...change };
    expect(() => new PusherClock(motion)).toThrow(RangeError);
    const clock = new PusherClock();
    offsets(clock, 30);
    expect(() => {
      clock.setMotion(motion);
    }).toThrow(error);
    expect(clock.motion).toEqual(DEFAULT_PUSHER_MOTION);
    expect(clock.tickInCycle).toBe(30);
    expect(clock.pendingMotion).toBeUndefined();
  });

  it('accepts the boundary motions', () => {
    for (const motion of [
      { stroke: MAX_PUSHER_STROKE, periodTicks: MIN_PUSHER_PERIOD_TICKS, pushFraction: 0.2 },
      { stroke: 0.001, periodTicks: MAX_PUSHER_PERIOD_TICKS, pushFraction: 0.8 },
    ]) {
      expect(new PusherClock(motion).motion).toEqual(motion);
    }
  });
});
