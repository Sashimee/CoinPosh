import type { Rotation } from '@dimforge/rapier3d-deterministic-compat';
import { describe, expect, it } from 'vitest';
import { COIN } from '../coin.ts';
import { GRAVITY, TICK_RATE_HZ } from '../constants.ts';
import { Xoshiro128ss } from '../prng.ts';
import { loadRapier } from '../rapier.ts';
import { PusherTable, type TableCoin } from '../table/table.ts';
import { COIN_MATERIAL, configureTableWorld } from '../table/tuning.ts';
import { CoinContactFinder, NO_GROUP } from './contacts.ts';
import { FUSION_TUNING } from './tuning.ts';

const rapier = await loadRapier();
const FLAT: Rotation = { x: 0, y: 0, z: 0, w: 1 };
/** Centre distance of two flat coins resting rim to rim, skins touching. */
const RESTING = 2 * (COIN.radius + COIN_MATERIAL.contactSkin);

function coin(id: number, x: number, y = 0.04, z = -0.17, rotation: Rotation = FLAT): TableCoin {
  return { id, translation: { x, y, z }, rotation, sleeping: false };
}

function finder(): CoinContactFinder {
  return new CoinContactFinder(FUSION_TUNING.touchGap);
}

describe('CoinContactFinder', () => {
  it('pairs flat coins resting rim to rim', () => {
    expect(finder().find([coin(0, 0), coin(1, RESTING)], [0, 0])).toEqual([{ a: 0, b: 1 }]);
  });

  it('pairs coins up to the gap apart and no further', () => {
    const surfaces = 2 * COIN.radius;
    const near = [coin(0, 0), coin(1, surfaces + FUSION_TUNING.touchGap * 0.95)];
    const far = [coin(0, 0), coin(1, surfaces + FUSION_TUNING.touchGap * 1.05)];
    expect(finder().find(near, [0, 0])).toHaveLength(1);
    expect(finder().find(far, [0, 0])).toEqual([]);
  });

  it('pairs a coin stacked on another', () => {
    const pitch = 2 * (COIN.halfThickness + COIN_MATERIAL.contactSkin);
    expect(finder().find([coin(4, 0.05), coin(9, 0.05, 0.04 + pitch)], [2, 2])).toEqual([
      { a: 4, b: 9 },
    ]);
  });

  it('pairs a tilted coin leaning on a flat one by its exact shape', () => {
    const tilt = Math.sqrt(0.5);
    const onEdge: Rotation = { x: 0, y: 0, z: tilt, w: tilt };
    const edgeHalf = COIN.halfThickness + COIN_MATERIAL.contactSkin;
    const touching = coin(
      1,
      COIN.radius + edgeHalf + 0.0002,
      0.04 + COIN.radius - COIN.halfThickness,
      -0.17,
      onEdge,
    );
    const apart = coin(
      1,
      COIN.radius + edgeHalf + 0.002,
      0.04 + COIN.radius - COIN.halfThickness,
      -0.17,
      onEdge,
    );
    expect(finder().find([coin(0, 0), touching], [1, 1])).toHaveLength(1);
    expect(finder().find([coin(0, 0), apart], [1, 1])).toEqual([]);
  });

  it('never pairs coins in different groups or with no group', () => {
    const coins = [coin(0, 0), coin(1, RESTING), coin(2, 2 * RESTING), coin(3, 3 * RESTING)];
    expect(finder().find(coins, [0, 1, NO_GROUP, NO_GROUP])).toEqual([]);
  });

  it('returns pairs sorted by lower then higher id, whatever the coin order', () => {
    const coins = [
      coin(7, 2 * RESTING),
      coin(2, 0),
      coin(5, RESTING),
      coin(1, 0, 0.04, -0.17 + RESTING),
    ];
    expect(finder().find(coins, [0, 0, 0, 0])).toEqual([
      { a: 1, b: 2 },
      { a: 2, b: 5 },
      { a: 5, b: 7 },
    ]);
  });

  it('handles an empty table and grows past its first allocation', () => {
    const f = finder();
    expect(f.find([], [])).toEqual([]);
    const row = Array.from({ length: 40 }, (_, i) => coin(i, i * RESTING));
    expect(
      f.find(
        row,
        row.map(() => 0),
      ),
    ).toHaveLength(39);
  });

  it('finds the same pairs as a fresh finder on a table in play, whatever it saw before', () => {
    const world = new rapier.World(GRAVITY);
    try {
      configureTableWorld(world);
      const table = new PusherTable(rapier, world);
      const rng = Xoshiro128ss.fromSeed(0xbe7c4);
      const slices = FUSION_TUNING.sampleTicks;
      const longLived = finder();
      let compared = 0;
      let found = 0;
      for (let tick = 1; tick <= 20 * TICK_RATE_HZ; tick++) {
        if (tick % 4 === 0) {
          table.dropCoin((rng.nextInt(301) - 150) / 1000, rng);
        }
        table.step(tick);
        const coins = table.coins();
        const groups = coins.map(({ id }) => id % 3);
        const slice = tick % slices;
        const pairs = longLived.find(coins, groups, slice, slices);
        if (tick % 30 !== 0) {
          continue;
        }
        expect(pairs).toEqual(finder().find(coins, groups, slice, slices));
        const all = finder().find(coins, groups);
        expect(longLived.find(coins, groups)).toEqual(all);
        const sliced = Array.from({ length: slices }, (_, k) =>
          longLived.find(coins, groups, k, slices),
        ).flat();
        expect(sliced.sort((p, q) => p.a - q.a || p.b - q.b)).toEqual(all);
        compared += 1;
        found += all.length;
      }
      expect(compared).toBe(40);
      expect(found).toBeGreaterThan(100);
    } finally {
      world.free();
    }
  });

  it('rejects a groups array of the wrong length and a bad gap', () => {
    expect(() => finder().find([coin(0, 0)], [])).toThrow(/one group per coin/);
    expect(() => new CoinContactFinder(-0.001)).toThrow(RangeError);
    expect(() => new CoinContactFinder(Number.NaN)).toThrow(RangeError);
  });
});
