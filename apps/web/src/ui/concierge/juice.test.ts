import { describe, expect, it } from 'vitest';
import { CONCIERGE_EXPRESSIONS, type ConciergeLineKind } from '../../game/concierge/index.ts';
import { conciergeCuePlan } from './juice.ts';

const KINDS: readonly ConciergeLineKind[] = ['remark', 'tip'];
const CASES = CONCIERGE_EXPRESSIONS.flatMap((expression) =>
  KINDS.flatMap((kind) => [false, true].map((reduced) => ({ expression, kind, reduced }))),
);

describe('conciergeCuePlan', () => {
  it.each(CASES)(
    'clears four juice channels for $expression $kind (reduced: $reduced)',
    ({ expression, kind, reduced }) => {
      const plan = conciergeCuePlan(expression, kind, reduced);
      expect(new Set(plan.channels).size).toBeGreaterThanOrEqual(4);
      expect(plan.channels).toEqual(expect.arrayContaining(['sound', 'haptic', 'light']));
      expect(plan.glints).toBeGreaterThan(0);
      expect(plan.bark).toBe(expression);
    },
  );

  it('springs, flies glints and cascades words only with full motion', () => {
    const full = conciergeCuePlan('pleased', 'remark', false);
    expect(full).toMatchObject({
      squash: true,
      glintMotion: 'burst',
      reveal: 'words',
      light: 'sweep',
    });
    expect(full.channels).toContain('squash');

    const reduced = conciergeCuePlan('pleased', 'remark', true);
    expect(reduced).toMatchObject({
      squash: false,
      glintMotion: 'twinkle',
      reveal: 'whole',
      light: 'glow',
    });
    expect(reduced.channels).not.toContain('squash');
    expect(reduced.glints).toBeLessThan(full.glints);
  });

  it('matches the haptic weight to the face', () => {
    expect(conciergeCuePlan('wry', 'remark', false).haptic).toBe('tick');
    expect(conciergeCuePlan('pleased', 'remark', false).haptic).toBe('tap');
    expect(conciergeCuePlan('scandalised', 'remark', false).haptic).toBe('thud');
  });

  it('gives a scandalised line more sparkle than a wry one, and a tip a little extra', () => {
    const wry = conciergeCuePlan('wry', 'remark', false).glints;
    expect(conciergeCuePlan('scandalised', 'remark', false).glints).toBeGreaterThan(wry);
    expect(conciergeCuePlan('wry', 'tip', false).glints).toBeGreaterThan(wry);
  });
});
