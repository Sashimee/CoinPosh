import type { World } from '@dimforge/rapier3d-deterministic-compat';
import { afterEach, describe, expect, it } from 'vitest';
import { COIN } from '../coin.ts';
import { GRAVITY, TICK_RATE_HZ } from '../constants.ts';
import { StateHasher } from '../hash.ts';
import { Xoshiro128ss } from '../prng.ts';
import { loadRapier } from '../rapier.ts';
import { PUSHER } from './layout.ts';
import { PusherTable } from './table.ts';
import { COIN_MATERIAL, configureTableWorld } from './tuning.ts';

/** The Demo table's seed and opening pour: 160 coins at 40 a second, golden-ratio spread. */
const DEMO_SEED = 0xc0196051;
const POUR_COINS = 160;
const POUR_SPREAD_MM = 135;
const STROKES = 10;
const SECONDS = (STROKES * PUSHER.periodTicks) / TICK_RATE_HZ;

const live: World[] = [];

afterEach(() => {
  for (const world of live.splice(0)) {
    world.free();
  }
});

async function createTable(): Promise<PusherTable> {
  const rapier = await loadRapier();
  const world = new rapier.World(GRAVITY);
  live.push(world);
  configureTableWorld(world);
  return new PusherTable(rapier, world);
}

function pourDrops(): Map<number, number[]> {
  const drops = new Map<number, number[]>();
  for (let i = 0; i < POUR_COINS; i++) {
    const tick = Math.floor(i * 1.5) + 1;
    const spread = i * 0.6180339887498949;
    const mm = Math.round(((spread - Math.floor(spread)) * 2 - 1) * POUR_SPREAD_MM);
    drops.set(tick, [...(drops.get(tick) ?? []), mm / 1000]);
  }
  return drops;
}

interface PourRun {
  /** Coins that went from the pusher's top down to the lower floor, per stroke. */
  readonly topToFloor: number[];
  readonly firstFrontFallTick: number | undefined;
  readonly frontFalls: number;
  readonly hashes: string[];
}

/** The Demo opening pour with nobody playing afterwards, hashed at the end of each stroke. */
async function idlePour(): Promise<PourRun> {
  const table = await createTable();
  const rng = Xoshiro128ss.fromSeed(DEMO_SEED);
  const drops = pourDrops();
  const onTop = new Set<number>();
  const topToFloor: number[] = [];
  const hashes: string[] = [];
  let firstFrontFallTick: number | undefined;
  let frontFalls = 0;
  let stroke = 0;
  for (let tick = 1; tick <= SECONDS * TICK_RATE_HZ; tick++) {
    for (const x of drops.get(tick) ?? []) {
      table.dropCoin(x, rng);
    }
    for (const fall of table.step(tick)) {
      onTop.delete(fall.coinId);
      if (fall.edge === 'front') {
        frontFalls += 1;
        firstFrontFallTick ??= tick;
      }
    }
    for (const coin of table.coins()) {
      const { y, z } = coin.translation;
      if (y > PUSHER.height + COIN.halfThickness / 2 && z < table.pusher.frontZ) {
        onTop.add(coin.id);
      } else if (onTop.has(coin.id) && y < PUSHER.height / 2) {
        onTop.delete(coin.id);
        stroke += 1;
      }
    }
    if (tick % PUSHER.periodTicks === 0) {
      topToFloor.push(stroke);
      stroke = 0;
      hashes.push(table.hashInto(new StateHasher().int(tick)).digest());
    }
  }
  return { topToFloor, firstFrontFallTick, frontFalls, hashes };
}

let reference: Promise<PourRun> | undefined;
function referencePour(): Promise<PourRun> {
  reference ??= idlePour();
  return reference;
}

describe('the pusher walks the Demo opening heap forward with no drops', () => {
  it('brings a coin down from the pusher top in every three strokes', async () => {
    const { topToFloor } = await referencePour();
    expect(topToFloor).toHaveLength(STROKES);
    for (let i = 0; i + 3 <= STROKES; i++) {
      const window = topToFloor.slice(i, i + 3).reduce((a, b) => a + b, 0);
      expect(window, `strokes ${i + 1}-${i + 3}: ${topToFloor.join(' ')}`).toBeGreaterThanOrEqual(
        1,
      );
    }
  });

  it('drops a coin over the front lip within 30 s', async () => {
    const { firstFrontFallTick, frontFalls } = await referencePour();
    expect(firstFrontFallTick).toBeDefined();
    expect(firstFrontFallTick ?? Infinity).toBeLessThanOrEqual(30 * TICK_RATE_HZ);
    expect(frontFalls).toBeGreaterThan(1);
  });

  it('replays to the same hash at every stroke', async () => {
    const { hashes } = await referencePour();
    expect((await idlePour()).hashes).toEqual(hashes);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('pins the hash after ten strokes so cam, friction or heap changes are caught', async () => {
    const { hashes } = await referencePour();
    // Changing this value breaks replay audits of every input log recorded before
    // the change. Update it only alongside a deliberate sim version bump.
    expect(hashes.at(-1)).toMatchInlineSnapshot(`"5b420482402c76f6"`);
  });
});

describe('a lone coin on the pusher top', () => {
  it('creeps forward a few millimetres every stroke, steadily', async () => {
    const table = await createTable();
    table.addCoin(
      { x: 0, y: PUSHER.height + COIN.halfThickness + COIN_MATERIAL.contactSkin, z: -0.18 },
      { x: 0, y: 0, z: 0, w: 1 },
    );
    const zs: number[] = [];
    for (let tick = 1; tick <= 6 * PUSHER.periodTicks; tick++) {
      table.step(tick);
      if (tick % PUSHER.periodTicks === 0) {
        zs.push(table.coins()[0]?.translation.z ?? Number.NaN);
      }
    }
    const creep = zs.slice(1).map((z, i) => z - (zs[i] ?? Number.NaN));
    for (const step of creep) {
      expect(step, `creep per stroke in m: ${creep.join(' ')}`).toBeGreaterThan(0.002);
      expect(step).toBeLessThan(0.005);
    }
  });
});
