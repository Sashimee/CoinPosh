import { upgradeCost, upgradeLines } from '@coinposh/economy';
import { describe, expect, it } from 'vitest';
import { upgradeRow } from '../app/model.ts';
import { dockAffordableCount } from './hud.ts';

const RICH = 1e15;
const familyOffice = upgradeLines.filter((line) => line.scope === 'global');
const venue = upgradeLines.filter((line) => line.scope === 'venue');

describe('dockAffordableCount', () => {
  it('ignores Family Office lines that Gold Bars can afford', () => {
    expect(familyOffice.length).toBeGreaterThan(0);
    const wallet = { coins: 0, goldBars: RICH };
    expect(familyOffice.every((line) => upgradeRow(line, 0, wallet).affordable)).toBe(true);
    expect(dockAffordableCount({ ...wallet, upgradeLevels: {} })).toBe(0);
  });

  it('counts each affordable venue line the sheet lists', () => {
    expect(dockAffordableCount({ coins: RICH, goldBars: RICH, upgradeLevels: {} })).toBe(
      venue.length,
    );
  });

  it('counts only what spendable coins can buy, not coins still in the drop rail', () => {
    const cheapest = Math.min(...venue.map((line) => upgradeCost(line, 0)));
    const shown = cheapest + 4;
    expect(
      dockAffordableCount({
        coins: shown,
        spendableCoins: cheapest - 5,
        goldBars: 0,
        upgradeLevels: {},
      }),
    ).toBe(0);
    expect(
      dockAffordableCount({
        coins: shown,
        spendableCoins: cheapest,
        goldBars: 0,
        upgradeLevels: {},
      }),
    ).toBeGreaterThan(0);
  });

  it('drops maxed venue lines and shows nothing on an empty wallet', () => {
    const [first] = venue;
    if (!first) throw new Error('packages/economy defines no venue upgrade line');
    const levels = { [first.id]: first.maxLevel };
    expect(dockAffordableCount({ coins: RICH, goldBars: 0, upgradeLevels: levels })).toBe(
      venue.length - 1,
    );
    expect(dockAffordableCount({ coins: 0, goldBars: 0, upgradeLevels: {} })).toBe(0);
  });
});
