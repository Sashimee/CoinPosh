import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { coinTiers, crateSpawn, offline, upgradeLines, venues } from './config/index.ts';
import {
  crateSpawnInterval,
  dropBufferTarget,
  dropSpacingTicks,
  dropSpawnsCrate,
  mintedCoinValue,
  pushTravelTicks,
  offlineCapHours,
  upgradeStatAt,
} from './effects.ts';
import { upgradeStat } from './formulas.ts';
import type { UpgradeStatId } from './types.ts';

function lineFor(stat: UpgradeStatId) {
  const line = upgradeLines.find((candidate) => candidate.effect.stat === stat);
  if (line === undefined) throw new Error(`Test needs a line granting ${stat}.`);
  return line;
}

const coinValueLine = lineFor('coinValue');
const oldMoney = lineFor('globalCoinValue');
const crateLine = lineFor('crateChance');
const courier = lineFor('globalCrateChance');
const dropRateLine = lineFor('dropRate');
const offlineLine = lineFor('offlineHours');
const pusherLine = lineFor('pusherSpeed');
const [copper, silver] = coinTiers;
const home = venues[0];

describe('upgradeStatAt', () => {
  it('is each line base at level 0 and grows by perLevel', () => {
    expect(upgradeStatAt({}, 'coinValue')).toBe(coinValueLine.effect.base);
    expect(upgradeStatAt({ coinValue: 3 }, 'coinValue')).toBe(upgradeStat(coinValueLine, 3));
  });

  it('multiplies every line that grants the stat', () => {
    const levels = { [crateLine.id]: 4, [courier.id]: 2 };
    expect(upgradeStatAt(levels, 'crateChance')).toBe(upgradeStat(crateLine, 4));
    expect(upgradeStatAt(levels, 'globalCrateChance')).toBe(upgradeStat(courier, 2));
    const stacked = [crateLine, { ...crateLine, id: 'stacked' }];
    expect(upgradeStatAt({ [crateLine.id]: 4, stacked: 2 }, 'crateChance', stacked)).toBeCloseTo(
      upgradeStat(crateLine, 4) * upgradeStat(crateLine, 2),
    );
  });

  it('refuses a level past the line maximum or a stat no line grants', () => {
    expect(() => upgradeStatAt({ coinValue: coinValueLine.maxLevel + 1 }, 'coinValue')).toThrow(
      /level must be an integer/,
    );
    expect(() => upgradeStatAt({}, 'coinValue', [])).toThrow(/No upgrade line grants/);
  });
});

describe('mintedCoinValue', () => {
  it('is the face value times the venue multiplier at level 0', () => {
    expect(mintedCoinValue(silver, home, {})).toBe(
      Math.floor(silver.value * home.coinValueMultiplier),
    );
  });

  it('grows with coinValue and globalCoinValue and never loses a coin to float error', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: coinValueLine.maxLevel }),
        fc.integer({ min: 0, max: oldMoney.maxLevel }),
        fc.constantFrom(...coinTiers),
        (level, global, tier) => {
          const exact =
            (tier.value *
              home.coinValueMultiplier *
              Math.round(upgradeStat(coinValueLine, level) * 1e6) *
              Math.round(upgradeStat(oldMoney, global) * 1e6)) /
            1e12;
          const value = mintedCoinValue(tier, home, {
            [coinValueLine.id]: level,
            [oldMoney.id]: global,
          });
          expect(value).toBe(Math.floor(exact + 1e-9));
          expect(value).toBeGreaterThanOrEqual(mintedCoinValue(tier, home, {}));
        },
      ),
    );
  });

  it('doubles a copper coin once coinValue reaches ×2', () => {
    const doubling = (2 - coinValueLine.effect.base) / coinValueLine.effect.perLevel;
    expect(mintedCoinValue(copper, home, { coinValue: doubling })).toBe(
      2 * mintedCoinValue(copper, home, {}),
    );
    expect(mintedCoinValue(copper, home, { coinValue: doubling - 1 })).toBe(
      mintedCoinValue(copper, home, {}),
    );
  });
});

describe('crate spawns', () => {
  it('spawns every dropsPerCrate drops at level 0, plus the FTUE crate', () => {
    expect(crateSpawnInterval({})).toBe(crateSpawn.dropsPerCrate);
    const spawned = Array.from({ length: 200 }, (_, i) => i + 1).filter((n) =>
      dropSpawnsCrate(n, {}),
    );
    expect(spawned).toEqual([crateSpawn.ftueScriptedDrop, 40, 80, 120, 160, 200]);
  });

  it('shortens the spacing as crateChance and globalCrateChance rise', () => {
    const max = { crateChance: crateLine.maxLevel };
    expect(crateSpawnInterval(max)).toBe(
      Math.round(crateSpawn.dropsPerCrate / upgradeStat(crateLine, crateLine.maxLevel)),
    );
    expect(crateSpawnInterval(max)).toBeLessThan(crateSpawnInterval({}));
    for (let level = 1; level <= crateLine.maxLevel; level++) {
      expect(crateSpawnInterval({ crateChance: level })).toBeLessThanOrEqual(
        crateSpawnInterval({ crateChance: level - 1 }),
      );
    }
    const both = { ...max, privateCourier: courier.maxLevel };
    expect(crateSpawnInterval(both)).toBeLessThan(crateSpawnInterval(max));
    expect(crateSpawnInterval(both)).toBeGreaterThanOrEqual(1);
  });

  it('refuses a drop count that is not a positive integer', () => {
    expect(() => dropSpawnsCrate(0, {})).toThrow(RangeError);
    expect(() => dropSpawnsCrate(1.5, {})).toThrow(RangeError);
  });
});

describe('dropBufferTarget', () => {
  it('is the base at level 0 and grows with dropRate, rounded up', () => {
    expect(dropBufferTarget(16, {})).toBe(16);
    expect(dropBufferTarget(16, { dropRate: dropRateLine.maxLevel })).toBe(
      Math.ceil(16 * upgradeStat(dropRateLine, dropRateLine.maxLevel)),
    );
    expect(dropBufferTarget(16, { dropRate: 1 })).toBe(
      Math.ceil(16 * upgradeStat(dropRateLine, 1)),
    );
  });

  it('refuses a negative or fractional base', () => {
    expect(() => dropBufferTarget(-1, {})).toThrow(RangeError);
    expect(() => dropBufferTarget(1.5, {})).toThrow(RangeError);
  });
});

describe('offlineCapHours', () => {
  it('starts at the base cap and reaches the hard maximum at the top level', () => {
    expect(offlineCapHours({})).toBe(offline.baseCapHours);
    expect(offlineCapHours({ offlineHours: 3 })).toBe(upgradeStat(offlineLine, 3));
    expect(offlineCapHours({ offlineHours: offlineLine.maxLevel })).toBe(offline.maxCapHours);
  });
});

describe('tick spacing', () => {
  it('keeps the base spacing at level 0', () => {
    expect(dropSpacingTicks(4, {})).toBe(4);
    expect(pushTravelTicks(90, {})).toBe(90);
  });

  it('shortens drop spacing with dropRate and travel time with pusherSpeed, never below one tick', () => {
    const fastDrops = { dropRate: dropRateLine.maxLevel };
    expect(dropSpacingTicks(100, fastDrops)).toBe(
      Math.floor(100 / upgradeStat(dropRateLine, dropRateLine.maxLevel)),
    );
    expect(dropSpacingTicks(4, fastDrops)).toBe(2);
    expect(dropSpacingTicks(1, fastDrops)).toBe(1);
    const fastPusher = { pusherSpeed: pusherLine.maxLevel };
    expect(pushTravelTicks(90, fastPusher)).toBe(
      Math.floor(90 / upgradeStat(pusherLine, pusherLine.maxLevel)),
    );
    expect(pushTravelTicks(90, fastPusher)).toBeLessThan(90);
    expect(pushTravelTicks(0, fastPusher)).toBe(0);
    for (let level = 1; level <= pusherLine.maxLevel; level++) {
      expect(pushTravelTicks(90, { pusherSpeed: level })).toBeLessThanOrEqual(
        pushTravelTicks(90, { pusherSpeed: level - 1 }),
      );
    }
  });

  it('refuses a negative or fractional base', () => {
    expect(() => dropSpacingTicks(-1, {})).toThrow(RangeError);
    expect(() => pushTravelTicks(1.5, {})).toThrow(RangeError);
  });
});
