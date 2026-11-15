import { describe, expect, it } from 'vitest';
import { seasonCuePlan, type SeasonCue } from './juice.ts';

const PRESS_CUES: readonly SeasonCue[] = ['open', 'tab', 'claim', 'already'];
const MOTION_CHANNELS = ['particles', 'squash', 'timeManipulation'] as const;

describe('seasonCuePlan', () => {
  it.each(PRESS_CUES)('%s lights at least four juice channels in both motion modes', (cue) => {
    for (const reduced of [false, true]) {
      const { channels } = seasonCuePlan(cue, reduced);
      expect(new Set(channels).size, `${cue} reduced=${String(reduced)}`).toBeGreaterThanOrEqual(4);
    }
  });

  it.each([...PRESS_CUES, 'failed'] as const)(
    '%s claims light and number pop only when it carries the cue that plays them',
    (cue) => {
      for (const reduced of [false, true]) {
        const plan = seasonCuePlan(cue, reduced);
        expect(plan.channels.includes('light'), `${cue} light`).toBe(plan.light !== null);
        expect(plan.channels.includes('numberPop'), `${cue} pop`).toBe(plan.pop !== null);
        expect(plan.channels.includes('particles'), `${cue} sparks`).toBe(plan.sparks > 0);
        expect(plan.channels.includes('timeManipulation'), `${cue} hold`).toBe(plan.hold > 0);
      }
    },
  );

  it('gives the claim the full treatment at full motion', () => {
    const plan = seasonCuePlan('claim', false);
    expect(plan.channels).toEqual(
      expect.arrayContaining(['sound', 'haptic', 'particles', 'squash', 'light', 'numberPop']),
    );
    expect(plan.feedback).toBe('confirm');
    expect(plan.haptic).toBe('fanfare');
    expect(plan.sparks).toBeGreaterThan(0);
    expect(plan.hold).toBeGreaterThan(0);
    expect(plan.light).toBe('sweep');
    expect(plan.pop).toBe('float');
    expect(plan.chime.length).toBeGreaterThan(1);
  });

  it.each([...PRESS_CUES, 'failed'] as const)(
    '%s drops motion in its reduced variant but keeps sound, haptic and light',
    (cue) => {
      const plan = seasonCuePlan(cue, true);
      for (const channel of MOTION_CHANNELS) expect(plan.channels).not.toContain(channel);
      expect(plan.channels).toEqual(expect.arrayContaining(['sound', 'haptic', 'light']));
      expect(plan.sparks).toBe(0);
      expect(plan.hold).toBe(0);
      expect(plan.light).not.toBe('sweep');
      expect(plan.pop).not.toBe('float');
    },
  );

  it('keeps the same sound and haptic in both modes', () => {
    for (const cue of [...PRESS_CUES, 'failed'] as const) {
      const full = seasonCuePlan(cue, false);
      const calm = seasonCuePlan(cue, true);
      expect(calm.feedback).toBe(full.feedback);
      expect(calm.haptic).toBe(full.haptic);
      expect(calm.chime).toEqual(full.chime);
    }
  });

  it('answers a failed claim with a deny and a thud, not a celebration', () => {
    const plan = seasonCuePlan('failed', false);
    expect(plan.feedback).toBe('deny');
    expect(plan.haptic).toBe('thud');
    expect(plan.sparks).toBe(0);
    expect(plan.pop).toBeNull();
  });
});
