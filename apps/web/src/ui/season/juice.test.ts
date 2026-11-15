import { describe, expect, it } from 'vitest';
import { CLAIM_HOLD_MS, paintSeasonFailure, seasonCuePlan, type SeasonCue } from './juice.ts';

const PRESS_CUES: readonly SeasonCue[] = ['open', 'tab', 'claim', 'already'];
const MOTION_CHANNELS = ['particles', 'squash', 'timeManipulation'] as const;

describe('seasonCuePlan', () => {
  it.each([...PRESS_CUES, 'failed'] as const)(
    '%s lights at least four juice channels in both motion modes',
    (cue) => {
      for (const reduced of [false, true]) {
        const { channels } = seasonCuePlan(cue, reduced);
        expect(new Set(channels).size, `${cue} reduced=${String(reduced)}`).toBeGreaterThanOrEqual(
          4,
        );
      }
    },
  );

  it('holds the claim stamp for at most 80 ms, and not at all with reduced motion', () => {
    expect(CLAIM_HOLD_MS).toBeLessThanOrEqual(80);
    expect(CLAIM_HOLD_MS).toBeGreaterThanOrEqual(40);
    expect(seasonCuePlan('claim', false).hold).toBe(CLAIM_HOLD_MS);
    expect(seasonCuePlan('claim', true).hold).toBe(0);
  });

  it('gives a tab no sound of its own beyond the press cue', () => {
    for (const reduced of [false, true]) {
      const plan = seasonCuePlan('tab', reduced);
      expect(plan.chime).toEqual([]);
      expect(plan.haptic).toBeNull();
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
    expect(plan.pop).toBe('pulse');
  });
});

describe('paintSeasonFailure', () => {
  function paint(reduced: boolean, note: string | null = 'note') {
    const calls: [string, string][] = [];
    paintSeasonFailure(
      { card: 'card', action: 'retry', note },
      seasonCuePlan('failed', reduced),
      (el, className) => calls.push([el, className]),
    );
    return calls;
  }

  it('plays the deny glow, the note flash, the retry pop and the shake at full motion', () => {
    expect(paint(false)).toEqual([
      ['card', 'is-deny-glowing'],
      ['note', 'is-flashing'],
      ['retry', 'is-popping'],
      ['card', 'is-denied'],
    ]);
  });

  it('keeps the glow, flash and pop but drops the shake with reduced motion', () => {
    expect(paint(true)).toEqual([
      ['card', 'is-deny-glowing'],
      ['note', 'is-flashing'],
      ['retry', 'is-popping'],
    ]);
  });

  it('paints one visual for every visual channel the failed plan declares', () => {
    for (const reduced of [false, true]) {
      const plan = seasonCuePlan('failed', reduced);
      const classes = new Set(paint(reduced).map(([, className]) => className));
      expect(classes.has('is-deny-glowing')).toBe(plan.channels.includes('light'));
      expect(classes.has('is-popping')).toBe(plan.channels.includes('numberPop'));
      expect(classes.has('is-denied')).toBe(plan.channels.includes('squash'));
    }
  });

  it('still glows the card when the card has no error note', () => {
    expect(paint(true, null)).toEqual([
      ['card', 'is-deny-glowing'],
      ['retry', 'is-popping'],
    ]);
  });
});
