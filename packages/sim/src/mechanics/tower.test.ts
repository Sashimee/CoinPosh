import { afterEach, describe, expect, it } from 'vitest';
import { StateHasher } from '../hash.ts';
import { Xoshiro128ss } from '../prng.ts';
import { COIN } from '../coin.ts';
import { PUSHER } from '../table/layout.ts';
import type { TableCoin } from '../table/table.ts';
import { COIN_MATERIAL } from '../table/tuning.ts';
import { type MechanicEvent, TableMechanics, type TowerToppleEvent } from './mechanics.ts';
import { MechanicsRig } from './rig.ts';
import type { MechanicTable } from './table.ts';
import { ChampagneTower } from './tower.ts';
import { TOWER_TUNING } from './tuning.ts';

const TIERS = ['copper', 'silver', 'gold'] as const;
type Tier = (typeof TIERS)[number];
const FUSION = { inputCount: 3, contactSeconds: 0.4 };
const AXIS = TOWER_TUNING.placement;
const DROP_EVERY = 20;

const live: MechanicsRig[] = [];

afterEach(() => {
  for (const rig of live.splice(0)) {
    rig.dispose();
  }
});

interface Feed {
  readonly rig: MechanicsRig;
  readonly mechanics: TableMechanics<Tier>;
  readonly events: MechanicEvent<Tier>[];
  /** Sway of the top after each capture, keyed by the height the capture reached. */
  readonly swayAt: Map<number, number>;
}

/**
 * Drops a gold coin (the top tier, so nothing fuses) every DROP_EVERY ticks at the
 * tower's x, within ±spread of it, for `ticks` ticks.
 */
async function feedTower(
  spread: number,
  seed: number,
  ticks: number,
  moving = true,
): Promise<Feed> {
  const rig = await MechanicsRig.create({ moving });
  live.push(rig);
  const mechanics = new TableMechanics(rig.rapier, rig.world, rig, {
    tiers: TIERS,
    fusion: FUSION,
  });
  const rng = Xoshiro128ss.fromSeed(seed);
  const events: MechanicEvent<Tier>[] = [];
  const swayAt = new Map<number, number>();
  let height = 0;
  let peak = 0;
  for (let i = 0; i < ticks; i++) {
    if (i % DROP_EVERY === 0) {
      const x = AXIS.x + (spread > 0 ? rng.nextRange(-spread, spread) : 0);
      mechanics.registerCoin(rig.dropCoin(x, rng), 'gold');
    }
    rig.step();
    const step = mechanics.step(rig.tick);
    events.push(...step);
    const tower = mechanics.tower;
    if (!tower) {
      throw new Error('feedTower: the table has no tower');
    }
    if (tower.coins.length !== height) {
      height = tower.coins.length;
      peak = 0;
    }
    peak = Math.max(peak, Math.sqrt(tower.sway.x * tower.sway.x + tower.sway.z * tower.sway.z));
    swayAt.set(height, peak);
  }
  return { rig, mechanics, events, swayAt };
}

function topples(events: readonly MechanicEvent<Tier>[]): TowerToppleEvent[] {
  return events.filter((e): e is TowerToppleEvent => e.kind === 'towerTopple');
}

describe('ChampagneTower', () => {
  it('stacks a coin dropped onto the pedestal and takes it off the table', async () => {
    const { rig, mechanics, events } = await feedTower(0, 1, DROP_EVERY);
    expect(events).toEqual([
      expect.objectContaining({ kind: 'towerCapture', coinId: 0, tier: 'gold', height: 1 }),
    ]);
    expect(rig.coinCount).toBe(0);
    expect(mechanics.tower?.coins.map(({ id }) => id)).toEqual([0]);
    expect(mechanics.tierOf(0)).toBe('gold');
  });

  it('builds a stack one coin per drop, each on the one below', async () => {
    const { mechanics, events } = await feedTower(0, 1, 10 * DROP_EVERY);
    const heights = events.flatMap((e) => (e.kind === 'towerCapture' ? [e.height] : []));
    expect(heights).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const tower = mechanics.tower;
    expect(tower?.pedestalTop).toBeCloseTo(PUSHER.height + TOWER_TUNING.pedestalHeight, 9);
    for (const { offset } of tower?.coins ?? []) {
      expect(Math.sqrt(offset.x * offset.x + offset.z * offset.z)).toBeLessThan(0.003);
    }
  });

  it('measures each capture in one tick against the stack as it stands after the last', async () => {
    const rig = await MechanicsRig.create();
    live.push(rig);
    const tower = new ChampagneTower(rig.rapier, rig.world);
    const removed: number[] = [];
    const table: MechanicTable = {
      coins: () => [],
      addCoin: () => {
        throw new Error('the tower adds no coin while it stands');
      },
      removeCoin: (id) => {
        removed.push(id);
      },
    };
    const resting = COIN.halfThickness + COIN_MATERIAL.contactSkin;
    const top = tower.state.pedestalTop;
    const at = (id: number, y: number): TableCoin => ({
      id,
      translation: { x: AXIS.x, y, z: AXIS.z },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      sleeping: false,
    });

    const sideBySide = tower.step(1, [at(0, top + resting), at(1, top + resting)], () => 0, table);
    expect(sideBySide.captures.map(({ coinId, height }) => [coinId, height])).toEqual([[0, 1]]);

    const stackTop = top + 2 * COIN.halfThickness;
    const onEachOther = tower.step(
      2,
      [at(2, stackTop + resting), at(3, stackTop + 3 * resting)],
      () => 0,
      table,
    );
    expect(onEachOther.captures.map(({ coinId, height }) => [coinId, height])).toEqual([
      [2, 2],
      [3, 3],
    ]);
    expect(removed).toEqual([0, 2, 3]);
    expect(tower.state.coins.map(({ id }) => id)).toEqual([0, 2, 3]);
  });

  it('leaves a coin that lands beside the pedestal on the table', async () => {
    const rig = await MechanicsRig.create();
    live.push(rig);
    const mechanics = new TableMechanics(rig.rapier, rig.world, rig, {
      tiers: TIERS,
      fusion: FUSION,
    });
    mechanics.registerCoin(rig.dropCoin(AXIS.x - 0.035, Xoshiro128ss.fromSeed(3)), 'gold');
    const events: MechanicEvent<Tier>[] = [];
    for (let i = 0; i < 60; i++) {
      rig.step();
      events.push(...mechanics.step(rig.tick));
    }
    expect(events).toEqual([]);
    expect(rig.coinCount).toBe(1);
  });

  it('sways further the taller it stands', async () => {
    const { swayAt } = await feedTower(0.004, 5, 34 * DROP_EVERY, false);
    const mean = (from: number, to: number): number => {
      let sum = 0;
      for (let h = from; h <= to; h++) {
        sum += swayAt.get(h) ?? Number.NaN;
      }
      return sum / (to - from + 1);
    };
    expect(mean(20, 30)).toBeGreaterThan(2 * mean(3, 10));
  });

  it('topples once fed past its height and releases its coins with their tiers', async () => {
    const { rig, mechanics, events } = await feedTower(
      0,
      1,
      (TOWER_TUNING.maxCoins + 2) * DROP_EVERY,
    );
    const [topple, ...more] = topples(events);
    expect(more).toEqual([]);
    expect(topple?.height).toBe(TOWER_TUNING.maxCoins + 1);
    expect(topple?.ids).toEqual(Array.from({ length: TOWER_TUNING.maxCoins + 1 }, (_, i) => i));
    const released = topple?.released ?? [];
    expect(new Set(released).size).toBe(released.length);
    for (const id of released) {
      expect(mechanics.tierOf(id)).toBe('gold');
    }
    expect(mechanics.tower?.coins).toEqual([]);
    expect(mechanics.tower?.cooldown).toBeGreaterThan(0);
    const onTable = new Set(rig.coins().map(({ id }) => id));
    expect(released.filter((id) => onTable.has(id)).length + rig.spilled).toBe(released.length);
  });

  it('catches nothing while the cascade spills, then stacks again', async () => {
    const { events } = await feedTower(0, 1, (TOWER_TUNING.maxCoins + 12) * DROP_EVERY);
    const [topple] = topples(events);
    if (!topple) {
      throw new Error('the tower never toppled');
    }
    const after = events.filter((e) => e.kind === 'towerCapture' && e.tick > topple.tick);
    expect(after.length).toBeGreaterThan(0);
    expect(after[0]?.tick).toBeGreaterThanOrEqual(topple.tick + TOWER_TUNING.toppleCooldownTicks);
  });

  it('topples a sloppily fed tower long before it is full', async () => {
    const { events } = await feedTower(0.007, 2, 40 * DROP_EVERY);
    const [first] = topples(events);
    expect(first?.height).toBeGreaterThanOrEqual(TOWER_TUNING.minToppleCoins);
    expect(first?.height).toBeLessThan(TOWER_TUNING.maxCoins);
  });

  it('wobbles and topples identically on every run', async () => {
    const run = async (): Promise<[MechanicEvent<Tier>[], string]> => {
      const { rig, mechanics, events } = await feedTower(0.007, 2, 40 * DROP_EVERY);
      const digest = mechanics.hashInto(rig.hashInto(new StateHasher())).digest();
      return [events, digest];
    };
    const [eventsA, digestA] = await run();
    const [eventsB, digestB] = await run();
    expect(topples(eventsA).length).toBeGreaterThan(0);
    expect(eventsB).toEqual(eventsA);
    expect(digestB).toBe(digestA);
  });

  it('refuses a placement that crowds the edge of the upper tier', async () => {
    const rig = await MechanicsRig.create();
    live.push(rig);
    const make = (x: number, z: number) => () =>
      new TableMechanics(rig.rapier, rig.world, rig, {
        tiers: TIERS,
        fusion: FUSION,
        tower: { x, z },
      });
    expect(make(0.17, AXIS.z)).toThrow(/Tower placement/);
    expect(make(0, PUSHER.frontZ)).toThrow(/Tower placement/);
    expect(make(0, -0.215)).toThrow(/Tower placement/);
    expect(make(Number.NaN, AXIS.z)).toThrow(/Tower placement/);
    expect(make(-0.05, AXIS.z)).not.toThrow();
  });
});
