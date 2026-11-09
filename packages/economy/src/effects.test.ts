import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { cascade, coinTiers, crateSpawn, offline, upgradeLines, venues } from './config/index.ts';
import {
  cascadeCreditMicros,
  cascadeWindowTicks,
  crateSpawnInterval,
  creditMintMicros,
  dropBufferTarget,
  dropSpacingTicks,
  dropSpawnsCrate,
  extendCascade,
  MINT_MICROS_PER_COIN,
  mintedCoinMicros,
  mintedCoinValue,
  pushTravelTicks,
  repriceReserved,
  offlineCapHours,
  upgradeStatAt,
} from './effects.ts';
import { upgradeStat } from './formulas.ts';
import type { CoinTierDef, UpgradeStatId } from './types.ts';

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

/** Mints `count` coins of `tier` from a zero carry and returns each credited value. */
function mintRun(
  count: number,
  levels: Record<string, number>,
  tier: CoinTierDef = copper,
): number[] {
  const micros = mintedCoinMicros(tier, home, levels);
  let carry = 0;
  return Array.from({ length: count }, () => {
    const credit = creditMintMicros(micros, carry);
    carry = credit.carry;
    return credit.value;
  });
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

describe('carried mint value', () => {
  it('pays every coinValue level over five copper drops: L0..L5 → 5, 6, 7, 8, 9, 10', () => {
    expect([0, 1, 2, 3, 4, 5].map((level) => sum(mintRun(5, { coinValue: level })))).toEqual([
      5, 6, 7, 8, 9, 10,
    ]);
    expect(mintRun(5, { coinValue: 1 })).toEqual([1, 1, 1, 1, 2]);
    expect(mintRun(5, { coinValue: 2 })).toEqual([1, 1, 2, 1, 2]);
  });

  it('credits the floor of everything minted over any run, so the carry stays under one coin', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: coinValueLine.maxLevel }),
        fc.integer({ min: 0, max: oldMoney.maxLevel }),
        fc.constantFrom(...coinTiers),
        fc.integer({ min: 1, max: 200 }),
        (level, global, tier, count) => {
          const levels = { [coinValueLine.id]: level, [oldMoney.id]: global };
          const micros = mintedCoinMicros(tier, home, levels);
          expect(sum(mintRun(count, levels, tier))).toBe(
            Math.floor((micros * count) / MINT_MICROS_PER_COIN),
          );
        },
      ),
    );
  });

  it('is exact for the configured coinValue steps (no float drift in the millionths)', () => {
    expect(mintedCoinMicros(copper, home, { coinValue: 1 })).toBe(
      Math.round(copper.value * home.coinValueMultiplier * 1.2 * MINT_MICROS_PER_COIN),
    );
  });

  it('rejects a negative mint and a carry outside [0, one coin)', () => {
    expect(() => creditMintMicros(-1, 0)).toThrow(/micros must be an integer/);
    expect(() => creditMintMicros(0.5, 0)).toThrow(/micros must be an integer/);
    expect(() => creditMintMicros(1, -1)).toThrow(/carry must be an integer/);
    expect(() => creditMintMicros(1, MINT_MICROS_PER_COIN)).toThrow(/carry must be an integer/);
  });
});

describe('repriceReserved', () => {
  const base = mintedCoinMicros(copper, home, {});

  it('credits reserved coins only the raise, through the carry', () => {
    const reserved = Array.from({ length: 5 }, () => ({ value: 1, micros: base }));
    const l1 = mintedCoinMicros(copper, home, { coinValue: 1 });
    const once = repriceReserved(reserved, l1, 0);
    expect(once.reserved.map((coin) => coin.value)).toEqual([1, 1, 1, 1, 2]);
    expect(once.carry).toBe(0);
    expect(repriceReserved(once.reserved, l1, once.carry)).toEqual(once);
  });

  it('matches minting the same coins fresh at the new level', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: coinValueLine.maxLevel }),
        fc.integer({ min: 1, max: 40 }),
        (level, count) => {
          const reserved = Array.from({ length: count }, () => ({ value: 1, micros: base }));
          const repriced = repriceReserved(
            reserved,
            mintedCoinMicros(copper, home, { coinValue: level }),
            0,
          );
          expect(repriced.reserved.map((coin) => coin.value)).toEqual(
            mintRun(count, { coinValue: level }),
          );
        },
      ),
    );
  });

  it('refuses to lower a reserved coin', () => {
    const l2 = mintedCoinMicros(copper, home, { coinValue: 2 });
    expect(() => repriceReserved([{ value: 1, micros: l2 }], base, 0)).toThrow(/cannot drop/);
  });
});

describe('cascade chain', () => {
  const window = cascadeWindowTicks(60);

  /** Credits a run of front falls of `value`-coins `gap` ticks apart from a zero carry. */
  function chainRun(count: number, gap: number, value = 1): number[] {
    let chain = null;
    let carry = 0;
    const credited: number[] = [];
    for (let i = 0; i < count; i++) {
      chain = extendCascade(chain, i * gap, window);
      const credit = creditMintMicros(cascadeCreditMicros(value, chain.count), carry);
      carry = credit.carry;
      credited.push(credit.value);
    }
    return credited;
  }

  it('spans the configured window in 60 Hz ticks', () => {
    expect(window).toBe(Math.ceil((cascade.windowMs * 60) / 1000));
    expect(() => cascadeWindowTicks(0)).toThrow(/ticks per second/);
  });

  it('grows inside the window, including at its last tick, and restarts after it', () => {
    const first = extendCascade(null, 100, window);
    expect(first).toEqual({ lastTick: 100, count: 1 });
    const edge = extendCascade(first, 100 + window, window);
    expect(edge.count).toBe(2);
    expect(extendCascade(edge, 100 + 2 * window + 1, window)).toEqual({
      lastTick: 100 + 2 * window + 1,
      count: 1,
    });
  });

  it('starts a new chain for a tick before the last one, however close', () => {
    const chain = { lastTick: 1_000, count: 25 };
    expect(extendCascade(chain, 999, window)).toEqual({ lastTick: 999, count: 1 });
    expect(extendCascade(chain, 0, window)).toEqual({ lastTick: 0, count: 1 });
    expect(extendCascade(chain, 1_000, window)).toEqual({ lastTick: 1_000, count: 26 });
  });

  it('cannot be kept alive with ever-decreasing ticks', () => {
    let chain = extendCascade(null, 10_000, window);
    for (let tick = 9_999; tick > 9_900; tick--) chain = extendCascade(chain, tick, window);
    expect(chain.count).toBe(1);
  });

  it('pays 10 chained copper falls 11: ×1 ×1 then Chic ×1.1, Lavish ×1.25, Opulent ×1.5', () => {
    const credited = chainRun(10, 1);
    expect(sum(credited)).toBe(Math.floor(2 + 3 * 1.1 + 4 * 1.25 + 1.5));
    expect(sum(credited)).toBe(11);
  });

  it('pays 10 copper falls 10 when every one starts a new chain', () => {
    expect(sum(chainRun(10, window + 1))).toBe(10);
  });

  it('credits the floor of every multiplied value over a run, never less than the coins', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 60 }),
        fc.constantFrom(...coinTiers.map((tier) => tier.value)),
        (count, value) => {
          const credited = chainRun(count, 1, value);
          let exact = 0;
          for (let i = 1; i <= count; i++) exact += cascadeCreditMicros(value, i);
          expect(sum(credited)).toBe(Math.floor(exact / MINT_MICROS_PER_COIN));
          expect(credited.every((paid) => paid >= value)).toBe(true);
        },
      ),
    );
  });

  it('rejects a non-integer coin value', () => {
    expect(() => cascadeCreditMicros(1.5, 1)).toThrow(/value must be an integer/);
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
