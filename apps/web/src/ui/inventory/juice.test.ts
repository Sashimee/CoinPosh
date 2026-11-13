import { RARITIES } from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import { cuePlan, type CueItem, type InventoryCue } from './juice.ts';
import { ITEM_KINDS, type ItemKind } from './model.ts';

const CUES: readonly InventoryCue[] = ['open', 'flip', 'levelUp'];

function item(kind: ItemKind, rarity: CueItem['rarity'] = 'rare'): CueItem {
  return { kind, rarity: kind === 'charm' ? rarity : null, level: 1, copies: 1 };
}

describe('inventory juice', () => {
  it.each(CUES)('%s lights at least four checklist channels in both motion modes', (cue) => {
    for (const reduced of [false, true]) {
      const plan = cuePlan(cue, cue === 'open' ? null : item('charm'), reduced);
      expect(new Set(plan.channels).size, `${cue} reduced=${reduced}`).toBeGreaterThanOrEqual(4);
      expect(plan.channels).toContain('sound');
      expect(plan.channels).toContain('haptic');
    }
  });

  it('reduced motion drops travel: no particles, squash or hit-stop', () => {
    for (const cue of CUES) {
      const plan = cuePlan(cue, item('charm', 'legendary'), true);
      expect(plan.channels).not.toContain('particles');
      expect(plan.channels).not.toContain('squash');
      expect(plan.sparks).toBe(0);
      expect(plan.hold).toBe(0);
    }
  });

  it('a level-up rings a rising chime that grows with rarity', () => {
    const common = cuePlan('levelUp', item('charm', 'common'), false);
    const heirloom = cuePlan('levelUp', item('charm', 'heirloom'), false);
    expect(common.feedback).toBe('confirm');
    expect(common.haptic).toBe('fanfare');
    expect(heirloom.sparks).toBeGreaterThan(common.sparks);
    expect(heirloom.chime.length).toBeGreaterThan(common.chime.length);
    const coins = heirloom.chime.filter((step) => step.impact.material === 'coin');
    coins.slice(1).forEach((current, i) => {
      const previous = coins[i];
      if (!previous) throw new Error('chime step missing');
      expect(current.at).toBeGreaterThan(previous.at);
      expect(current.impact.velocity).toBeGreaterThan(previous.impact.velocity);
    });
  });

  it('keeps every chime strike inside the impact synth range', () => {
    for (const rarity of [...RARITIES, null]) {
      for (const step of cuePlan('levelUp', { ...item('charm'), rarity }, false).chime) {
        expect(step.impact.velocity).toBeGreaterThanOrEqual(0.06);
        expect(step.impact.velocity).toBeLessThanOrEqual(2.8);
      }
    }
  });

  it('a level-up still sounds and buzzes under reduced motion', () => {
    const plan = cuePlan('levelUp', item('charm', null), true);
    expect(plan.chime.length).toBeGreaterThan(0);
    expect(plan.haptic).toBe('fanfare');
  });

  it('opening and flipping use the bus cues', () => {
    expect(cuePlan('open', null, false).feedback).toBe('open');
    expect(cuePlan('flip', item('safe'), false).feedback).toBe('toggle');
  });

  it.each(ITEM_KINDS)('flipping a %s still lights four channels under reduced motion', (kind) => {
    const plan = cuePlan('flip', item(kind), true);
    expect(new Set(plan.channels).size).toBeGreaterThanOrEqual(4);
    expect(plan.channels).toEqual(['sound', 'haptic', 'light', 'numberPop']);
  });

  it('pops no number on a flip when the back has nothing to roll', () => {
    const plan = cuePlan('flip', { kind: 'safe', rarity: null, level: 0, copies: 0 }, true);
    expect(plan.channels).not.toContain('numberPop');
  });
});
