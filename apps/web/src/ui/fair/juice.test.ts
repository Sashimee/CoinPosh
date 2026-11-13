import { describe, expect, it } from 'vitest';
import { fairCuePlan, type FairCue } from './juice.ts';

const CUES: readonly FairCue[] = ['open', 'tab', 'source', 'step', 'rotate', 'match', 'mismatch'];

describe('Certified Fair juice', () => {
  it.each(CUES)('%s lights at least four checklist channels in both motion modes', (cue) => {
    for (const reduced of [false, true]) {
      const plan = fairCuePlan(cue, reduced);
      expect(
        new Set(plan.channels).size,
        `${cue} reduced=${String(reduced)}`,
      ).toBeGreaterThanOrEqual(4);
      expect(plan.channels).toContain('sound');
      expect(plan.channels).toContain('haptic');
    }
  });

  it.each(CUES)('%s under reduced motion drops travel: no particles, squash or hit-stop', (cue) => {
    const plan = fairCuePlan(cue, true);
    expect(plan.channels).not.toContain('particles');
    expect(plan.channels).not.toContain('squash');
    expect(plan.sparks).toBe(0);
    expect(plan.hold).toBe(0);
  });

  it('a match lands harder than a mismatch, and only a match confirms', () => {
    const match = fairCuePlan('match', false);
    const mismatch = fairCuePlan('mismatch', false);
    expect(match.feedback).toBe('confirm');
    expect(match.haptic).toBe('fanfare');
    expect(match.sparks).toBeGreaterThan(0);
    expect(mismatch.feedback).toBe('deny');
    expect(mismatch.sparks).toBe(0);
    expect(match.chime.length).toBeGreaterThan(mismatch.chime.length);
  });

  it('the match chime rises', () => {
    const coins = fairCuePlan('match', false).chime.filter(
      (step) => step.impact.material === 'coin',
    );
    coins.slice(1).forEach((current, i) => {
      const before = coins[i];
      expect(before && current.impact.velocity > before.impact.velocity).toBe(true);
      expect(before && current.at > before.at).toBe(true);
    });
  });
});
