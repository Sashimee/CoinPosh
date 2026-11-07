import { describe, expect, it } from 'vitest';
import { cascade, upgradeCost, upgradeLines, type UpgradeLineDef } from '@coinposh/economy';
import { affordableCount, comboView, decorumView, upgradeRow, upgradeRows } from './model.ts';

function line(id: string): UpgradeLineDef {
  const found = upgradeLines.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no upgrade line ${id}`);
  return found;
}

describe('comboView', () => {
  it('starts empty below the first tier', () => {
    const view = comboView(0, cascade);
    expect(view).toMatchObject({
      count: 0,
      tier: null,
      rank: 0,
      toNext: 3,
      fill: 0,
      multiplier: 1,
    });
    expect(view.next?.id).toBe('chic');
  });

  it('fills each tier band toward the next threshold', () => {
    const band = 1 / cascade.tiers.length;
    const chic = comboView(3, cascade);
    expect(chic.tier?.id).toBe('chic');
    expect(chic.rank).toBe(1);
    expect(chic.fill).toBeCloseTo(band);
    expect(comboView(8, cascade).fill).toBeCloseTo(band * 2 + band * (2 / 4));
  });

  it('tops out full at the last tier and floors fractional counts', () => {
    const top = comboView(40, cascade);
    expect(top.tier?.id).toBe('obscene');
    expect(top).toMatchObject({ next: null, toNext: 0, fill: 1, multiplier: 3 });
    expect(comboView(5.9, cascade).count).toBe(5);
    expect(comboView(-4, cascade).count).toBe(0);
  });
});

describe('decorumView', () => {
  it('crosses levels at the warning and critical marks', () => {
    expect(decorumView({ used: 59, capacity: 100, frozenSeconds: 0 }).level).toBe('calm');
    expect(decorumView({ used: 60, capacity: 100, frozenSeconds: 0 }).level).toBe('warning');
    expect(decorumView({ used: 85, capacity: 100, frozenSeconds: 0 }).level).toBe('critical');
  });

  it('is frozen whenever the Concierge timer runs, rounding seconds up', () => {
    expect(decorumView({ used: 10, capacity: 100, frozenSeconds: 0.2 })).toEqual({
      fraction: 0.1,
      level: 'frozen',
      frozenSeconds: 1,
    });
  });

  it('clamps the fraction and survives zero capacity', () => {
    expect(decorumView({ used: 250, capacity: 100, frozenSeconds: 0 }).fraction).toBe(1);
    expect(decorumView({ used: 5, capacity: 0, frozenSeconds: -3 })).toEqual({
      fraction: 0,
      level: 'calm',
      frozenSeconds: 0,
    });
  });
});

describe('upgradeRow', () => {
  it('prices the next level from the economy package', () => {
    const dropRate = line('dropRate');
    const row = upgradeRow(dropRate, 2, { coins: 0, goldBars: 0 });
    expect(row.cost).toBe(upgradeCost(dropRate, 2));
    expect(row.affordable).toBe(false);
    expect(row.current).toBeCloseTo(1.06);
    expect(row.nextValue).toBeCloseTo(1.09);
    expect(row.format).toBe('multiplier');
  });

  it('is affordable at exactly the price, in the line’s own currency', () => {
    const dropRate = line('dropRate');
    const price = upgradeCost(dropRate, 0);
    expect(upgradeRow(dropRate, 0, { coins: price, goldBars: 0 }).affordable).toBe(true);
    expect(upgradeRow(dropRate, 0, { coins: price - 1, goldBars: 10 ** 9 }).affordable).toBe(false);
    const global = upgradeLines.find((candidate) => candidate.currency === 'goldBars');
    if (!global) throw new Error('no gold bar upgrade line');
    expect(upgradeRow(global, 0, { coins: 10 ** 9, goldBars: 0 }).affordable).toBe(false);
  });

  it('caps at max level with no price', () => {
    const dropRate = line('dropRate');
    const row = upgradeRow(dropRate, dropRate.maxLevel + 5, { coins: 10 ** 12, goldBars: 0 });
    expect(row).toMatchObject({
      level: dropRate.maxLevel,
      maxed: true,
      cost: null,
      nextValue: null,
    });
    expect(row.affordable).toBe(false);
  });

  it('counts affordable rows for the dock badge', () => {
    const rows = upgradeRows(upgradeLines, {}, { coins: 40, goldBars: 0 });
    const expected = upgradeLines.filter(
      (candidate) => candidate.currency === 'coins' && upgradeCost(candidate, 0) <= 40,
    ).length;
    expect(affordableCount(rows)).toBe(expected);
    expect(affordableCount(upgradeRows(upgradeLines, {}, { coins: 0, goldBars: 0 }))).toBe(0);
  });
});
