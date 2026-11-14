import { RARITIES } from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import {
  bounceContacts,
  bounceHeight,
  CRANK_DETENTS,
  detentIndex,
  detentTurns,
  DISPENSE,
  POP,
  popGlow,
  RARITY_GLOW,
  rollShare,
} from './motion.ts';

describe('crank detents', () => {
  it('rests at 0 and reaches one full turn at progress 1', () => {
    expect(detentTurns(0)).toBe(0);
    expect(detentTurns(1)).toBeCloseTo(1, 9);
    expect(detentTurns(-0.4)).toBe(0);
  });

  it('lands exactly on every tooth', () => {
    for (let tooth = 0; tooth <= CRANK_DETENTS; tooth++) {
      expect(detentTurns(tooth / CRANK_DETENTS)).toBeCloseTo(tooth / CRANK_DETENTS, 9);
    }
  });

  it('never runs backwards as the hand turns forwards', () => {
    let last = -1;
    for (let i = 0; i <= 2000; i++) {
      const turns = detentTurns(i / 2000);
      expect(turns).toBeGreaterThanOrEqual(last - 1e-12);
      last = turns;
    }
  });

  it('lags the hand through the hold and catches up after it', () => {
    const click = 1 / CRANK_DETENTS;
    expect(detentTurns(click * 0.5)).toBeLessThan(click * 0.5);
    expect(detentTurns(click * 0.5)).toBeLessThan(click * 0.25);
    expect(detentTurns(click * 0.98)).toBeGreaterThan(click * 0.85);
    expect(detentTurns(click * 0.86) - detentTurns(click * 0.72)).toBeLessThan(
      detentTurns(click) - detentTurns(click * 0.86),
    );
  });

  it('counts clicks', () => {
    expect(detentIndex(0)).toBe(0);
    expect(detentIndex(0.124)).toBe(0);
    expect(detentIndex(0.125)).toBe(1);
    expect(detentIndex(1)).toBe(CRANK_DETENTS);
  });
});

describe('dispense motion', () => {
  it('runs its stages in order', () => {
    expect(0).toBeLessThan(DISPENSE.drop);
    expect(DISPENSE.drop).toBeLessThan(DISPENSE.roll);
    expect(DISPENSE.roll).toBeLessThan(DISPENSE.bounce);
    expect(DISPENSE.bounce).toBeLessThan(DISPENSE.settle);
  });

  it('accelerates down the chute from the port to the mouth', () => {
    expect(rollShare(0, 1)).toBe(0);
    expect(rollShare(1, 1)).toBeCloseTo(1, 9);
    expect(rollShare(2, 1)).toBeCloseTo(1, 9);
    const early = rollShare(0.1, 1) - rollShare(0, 1);
    const late = rollShare(1, 1) - rollShare(0.9, 1);
    expect(late).toBeGreaterThan(early * 2);
  });

  it('falls from the mouth, hops lower each time and comes to rest', () => {
    const drop = 0.02;
    expect(bounceHeight(0, 1, drop)).toBeCloseTo(drop, 9);
    expect(bounceHeight(1, 1, drop)).toBe(0);
    const [first, second, third] = bounceContacts(1);
    expect(first).toBeDefined();
    expect(bounceHeight(first ?? 0, 1, drop)).toBeCloseTo(0, 6);
    expect(bounceHeight(second ?? 0, 1, drop)).toBeCloseTo(0, 6);
    expect(bounceHeight(third ?? 0, 1, drop)).toBeCloseTo(0, 6);
    const hop1 = bounceHeight(((first ?? 0) + (second ?? 0)) / 2, 1, drop);
    const hop2 = bounceHeight(((second ?? 0) + (third ?? 0)) / 2, 1, drop);
    expect(hop1).toBeLessThan(drop);
    expect(hop2).toBeLessThan(hop1);
    expect(hop2).toBeGreaterThan(0);
  });
});

describe('pop glow', () => {
  it('stays dark before the first twist and flashes on the second', () => {
    expect(popGlow(0)).toBe(0);
    expect(popGlow(POP.twist1 - 0.01)).toBe(0);
    expect(popGlow(POP.twist2 - 0.01)).toBeLessThan(0.15);
    expect(popGlow(POP.twist2 + 0.06)).toBeGreaterThan(2.5);
  });

  it('decays to a steady afterglow by the settle', () => {
    expect(popGlow(POP.settle)).toBeCloseTo(0.62, 2);
    expect(popGlow(POP.settle + 5)).toBe(0.62);
  });

  it('grows with rarity', () => {
    for (let i = 1; i < RARITIES.length; i++) {
      const lower = RARITY_GLOW[RARITIES[i - 1] ?? 'common'];
      const higher = RARITY_GLOW[RARITIES[i] ?? 'common'];
      expect(higher.size).toBeGreaterThan(lower.size);
      expect(higher.intensity).toBeGreaterThan(lower.intensity);
    }
  });
});
