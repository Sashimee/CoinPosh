import { describe, expect, it } from 'vitest';
import { JUICE_ITEMS } from '../../juice.ts';
import {
  ASCEND_CUES,
  ASCEND_JUICE,
  ascendBeats,
  ascendPose,
  ascendTimeline,
  cinematicMs,
  FULL_ASCEND,
  REDUCED_ASCEND,
  sparkCount,
  SPARKS_MAX,
  SPARKS_MIN,
  type AscendTimeline,
} from './plan.ts';
import { makeSparks, sparkAt } from './sparks.ts';

function defined<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a value');
  return value;
}

const TIMELINES: readonly [string, AscendTimeline, boolean][] = [
  ['full', FULL_ASCEND, false],
  ['reduced', REDUCED_ASCEND, true],
];

function sample(timeline: AscendTimeline, reduced: boolean, stepMs = 10) {
  const frames = [];
  for (let real = 0; real <= timeline.totalMs; real += stepMs) {
    frames.push({ real, pose: ascendPose(cinematicMs(real, timeline), timeline, reduced) });
  }
  return frames;
}

describe('ascension timeline', () => {
  it('runs 3 s in both variants and picks the reduced one under reduced motion', () => {
    expect(FULL_ASCEND.totalMs).toBe(3_000);
    expect(REDUCED_ASCEND.totalMs).toBe(3_000);
    expect(ascendTimeline(false)).toBe(FULL_ASCEND);
    expect(ascendTimeline(true)).toBe(REDUCED_ASCEND);
  });

  it.each(TIMELINES)('%s: beats run in story order and finish inside the 3 s', (_, timeline) => {
    const beats = ascendBeats(timeline);
    expect(beats.map((beat) => beat.kind)).toEqual([
      'sink',
      'curtain',
      'stamp',
      'lift',
      'rise',
      'done',
    ]);
    for (let i = 1; i < beats.length; i++) {
      expect(defined(beats[i]).atMs).toBeGreaterThanOrEqual(defined(beats[i - 1]).atMs);
    }
    expect(defined(beats.at(-1)).atMs).toBe(timeline.totalMs);
    expect(timeline.riseAtMs + timeline.riseMs + timeline.hitStopMs).toBeLessThanOrEqual(
      timeline.totalMs,
    );
  });

  it('freezes the clock through the hit-stop on the stamp, and only there', () => {
    const { stampAtMs, hitStopMs } = FULL_ASCEND;
    expect(hitStopMs).toBeGreaterThanOrEqual(50);
    expect(cinematicMs(stampAtMs - 1, FULL_ASCEND)).toBe(stampAtMs - 1);
    expect(cinematicMs(stampAtMs + hitStopMs / 2, FULL_ASCEND)).toBe(stampAtMs);
    expect(cinematicMs(stampAtMs + hitStopMs, FULL_ASCEND)).toBe(stampAtMs);
    expect(cinematicMs(stampAtMs + hitStopMs + 10, FULL_ASCEND)).toBe(stampAtMs + 10);
    expect(cinematicMs(-50, FULL_ASCEND)).toBe(0);
    expect(cinematicMs(500, REDUCED_ASCEND)).toBe(500);
  });
});

describe('ascension pose (full motion)', () => {
  const at = (ms: number) => ascendPose(ms, FULL_ASCEND, false);

  it('starts on the untouched table and ends on the risen venue with the curtain gone', () => {
    expect(at(0)).toMatchObject({ sink: 0, curtain: 0, stamp: 0, count: 0, flash: 0, rise: 0 });
    const end = at(cinematicMs(FULL_ASCEND.totalMs, FULL_ASCEND));
    expect(end.sink).toBeCloseTo(0, 6);
    expect(end.curtain).toBeCloseTo(0, 6);
    expect(end.stamp).toBeCloseTo(0, 6);
    expect(end.rise).toBeCloseTo(1, 6);
    expect(end.title).toBe(1);
    expect(end.stageLight).toBeCloseTo(1, 6);
  });

  it('sinks the table fully before the curtain lifts, with the screen covered at the stamp', () => {
    expect(at(FULL_ASCEND.sinkMs).sink).toBe(1);
    const stamp = at(FULL_ASCEND.stampAtMs);
    expect(stamp.curtain).toBeGreaterThan(0.95);
    expect(stamp.stageLight).toBeLessThan(0.5);
  });

  it('slams the medallion past full size, flashes, shakes and counts the Gold Bars up', () => {
    const frames = sample(FULL_ASCEND, false, 5).map((frame) => frame.pose);
    expect(Math.max(...frames.map((pose) => pose.stamp))).toBeGreaterThan(1.05);
    expect(Math.max(...frames.map((pose) => pose.flash))).toBeGreaterThan(0.9);
    expect(Math.max(...frames.map((pose) => Math.abs(pose.shake)))).toBeGreaterThan(3);
    const counts = frames.map((pose) => pose.count);
    for (let i = 1; i < counts.length; i++)
      expect(counts[i]).toBeGreaterThanOrEqual(defined(counts[i - 1]));
    expect(at(FULL_ASCEND.stampAtMs + FULL_ASCEND.countMs).count).toBe(1);
  });

  it('overshoots the rise of the new venue, then settles', () => {
    const rises = sample(FULL_ASCEND, false, 5).map((frame) => frame.pose.rise);
    expect(Math.max(...rises)).toBeGreaterThan(1);
    expect(rises.at(-1)).toBeCloseTo(1, 6);
  });

  it('never leaves a pose value undefined or NaN', () => {
    for (const { pose } of sample(FULL_ASCEND, false, 7)) {
      for (const value of Object.values(pose)) expect(Number.isFinite(value)).toBe(true);
    }
  });
});

describe('ascension pose (reduced motion)', () => {
  it('never moves, shakes, flashes or overshoots anything', () => {
    for (const { pose } of sample(REDUCED_ASCEND, true)) {
      expect(pose.sink).toBe(0);
      expect(pose.shake).toBe(0);
      expect(pose.flash).toBe(0);
      expect(pose.stamp).toBeLessThanOrEqual(1);
      expect(pose.rise === 0 || pose.rise === 1).toBe(true);
      expect(pose.curtain === 0 || pose.curtain === 1).toBe(true);
    }
  });

  it('fades the curtain in, shows the full payout at once and fades out on the next venue', () => {
    const at = (ms: number) => ascendPose(ms, REDUCED_ASCEND, true);
    expect(at(REDUCED_ASCEND.curtainMs / 2).curtainOpacity).toBeCloseTo(0.5, 6);
    expect(at(REDUCED_ASCEND.stampAtMs - 1).count).toBe(0);
    expect(at(REDUCED_ASCEND.stampAtMs).count).toBe(1);
    const end = at(REDUCED_ASCEND.totalMs);
    expect(end.curtainOpacity).toBe(0);
    expect(end.title).toBe(1);
    expect(end.stageLight).toBe(1);
  });
});

describe('ascension juice', () => {
  it('lists at least 4 checklist items besides sound, all of them real', () => {
    const silent = ASCEND_JUICE.items.filter((item) => item !== 'sound');
    expect(silent.length).toBeGreaterThanOrEqual(4);
    for (const item of ASCEND_JUICE.items) expect(JUICE_ITEMS[item]).toBeDefined();
    expect(ASCEND_JUICE.reduced.length).toBeGreaterThan(0);
  });

  it('gives the stamp the heaviest sound and a haptic', () => {
    const loudest = (kind: keyof typeof ASCEND_CUES) =>
      Math.max(0, ...ASCEND_CUES[kind].sounds.map((sound) => sound.velocity));
    for (const kind of ['sink', 'curtain', 'lift', 'rise'] as const) {
      expect(loudest('stamp')).toBeGreaterThan(loudest(kind));
    }
    expect(ASCEND_CUES.stamp.haptic).not.toBeNull();
  });
});

describe('stamp sparks', () => {
  it('scales the burst with the payout, inside phone-safe bounds', () => {
    expect(sparkCount(0)).toBe(0);
    expect(sparkCount(Number.NaN)).toBe(0);
    expect(sparkCount(1)).toBe(SPARKS_MIN);
    expect(sparkCount(10)).toBeGreaterThan(sparkCount(1));
    expect(sparkCount(1e12)).toBe(SPARKS_MAX);
  });

  it('throws the same sparks for the same seed, and they burn out', () => {
    expect(makeSparks(20, 7)).toEqual(makeSparks(20, 7));
    expect(makeSparks(20, 7)).not.toEqual(makeSparks(20, 8));
    expect(makeSparks(-3, 1)).toEqual([]);
    for (const spark of makeSparks(30, 3)) {
      expect(sparkAt(spark, -1)).toBeNull();
      const launch = defined(sparkAt(spark, 0));
      expect(Math.hypot(launch.x, launch.y)).toBe(0);
      expect(launch.alpha).toBe(1);
      expect(defined(sparkAt(spark, spark.lifeMs - 1)).alpha).toBeLessThan(0.05);
      expect(sparkAt(spark, spark.lifeMs)).toBeNull();
    }
  });
});
