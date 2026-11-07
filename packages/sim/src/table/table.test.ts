import type { World } from '@dimforge/rapier3d-deterministic-compat';
import { afterEach, describe, expect, it } from 'vitest';
import { COIN } from '../coin.ts';
import { GRAVITY, TICK_RATE_HZ } from '../constants.ts';
import { StateHasher } from '../hash.ts';
import { Xoshiro128ss } from '../prng.ts';
import { loadRapier } from '../rapier.ts';
import { BACKBOARD, GUTTER_START_Z, PLAYFIELD, PUSHER, TABLE_INNER_HALF_WIDTH } from './layout.ts';
import { DEFAULT_PUSHER_MOTION } from './pusher.ts';
import { type FallEvent, PusherTable, type TableOptions } from './table.ts';
import { configureTableWorld, TABLE_SOLVER } from './tuning.ts';

const FLAT = { x: 0, y: 0, z: 0, w: 1 } as const;
const SEED = 0x7ab1e001;

interface Rig {
  readonly world: World;
  readonly table: PusherTable;
  readonly rng: Xoshiro128ss;
  tick: number;
  /** One tick: pusher, physics, fall detection. Returns that tick's falls. */
  step(): FallEvent[];
}

const live: World[] = [];

async function createRig(options: TableOptions = {}, seed = SEED): Promise<Rig> {
  const rapier = await loadRapier();
  const world = new rapier.World(GRAVITY);
  live.push(world);
  configureTableWorld(world);
  const table = new PusherTable(rapier, world, options);
  const rig: Rig = {
    world,
    table,
    rng: Xoshiro128ss.fromSeed(seed),
    tick: 0,
    step() {
      table.beforeStep();
      world.step();
      rig.tick += 1;
      return table.afterStep(rig.tick);
    },
  };
  return rig;
}

afterEach(() => {
  for (const world of live.splice(0)) {
    world.free();
  }
});

function runTicks(rig: Rig, ticks: number): FallEvent[] {
  const falls: FallEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    falls.push(...rig.step());
  }
  return falls;
}

function faceUp(rotation: { x: number; z: number }): number {
  return 1 - 2 * (rotation.x * rotation.x + rotation.z * rotation.z);
}

function onlyCoin(table: PusherTable): ReturnType<PusherTable['coins']>[number] {
  const [coin, ...rest] = table.coins();
  if (!coin || rest.length > 0) {
    throw new Error(`expected exactly one coin on the table, found ${table.coinCount}`);
  }
  return coin;
}

describe('PusherTable layout', () => {
  it('builds the world with the tuned solver settings', async () => {
    const { world } = await createRig();
    expect(world.integrationParameters.numSolverIterations).toBe(TABLE_SOLVER.numSolverIterations);
    expect(world.integrationParameters.lengthUnit).toBe(Math.fround(TABLE_SOLVER.lengthUnit));
  });

  it('keeps every drop over the upper tier and the gutters outside the pusher guides', () => {
    const maxDropX = 0.15;
    expect(maxDropX + COIN.radius).toBeLessThan(PLAYFIELD.fieldHalfWidth - PUSHER.sideClearance);
    expect(PLAYFIELD.gutterWidth).toBeGreaterThan(2 * COIN.radius);
    expect(TABLE_INNER_HALF_WIDTH).toBe(PLAYFIELD.fieldHalfWidth + PLAYFIELD.gutterWidth);
    expect(GUTTER_START_Z).toBeGreaterThanOrEqual(PUSHER.frontZ + DEFAULT_PUSHER_MOTION.stroke);
    expect(GUTTER_START_Z).toBeLessThan(PLAYFIELD.fieldFrontZ);
  });

  it('lands a dropped coin on the upper tier with one small hop, then lies flat and still', async () => {
    const rig = await createRig();
    rig.table.dropCoin(0.05, rig.rng);
    let landed = false;
    let lowest = Number.POSITIVE_INFINITY;
    let peakAfterLanding = Number.NEGATIVE_INFINITY;
    const restY = PUSHER.height + COIN.halfThickness;
    for (let i = 0; i < 3 * TICK_RATE_HZ; i++) {
      rig.step();
      const { y } = onlyCoin(rig.table).translation;
      lowest = Math.min(lowest, y);
      if (y < restY + 0.002) {
        landed = true;
      }
      if (landed) {
        peakAfterLanding = Math.max(peakAfterLanding, y);
      }
    }
    const coin = onlyCoin(rig.table);
    expect(lowest).toBeGreaterThan(restY - 0.0006);
    expect(peakAfterLanding - restY).toBeLessThan(0.002);
    expect(coin.translation.y).toBeCloseTo(restY, 3);
    expect(faceUp(coin.rotation)).toBeGreaterThan(0.9999);
  });

  it('rests a coin on the lower tier and lets it sleep when nothing touches it', async () => {
    const rig = await createRig();
    const id = rig.table.addCoin({ x: 0.1, y: 0.01, z: PLAYFIELD.fieldFrontZ - 0.03 }, FLAT);
    runTicks(rig, 4 * TICK_RATE_HZ);
    const coin = onlyCoin(rig.table);
    expect(coin.id).toBe(id);
    expect(coin.translation.y).toBeCloseTo(COIN.halfThickness, 3);
    expect(coin.sleeping).toBe(true);
  });

  it('keeps a coin on the upper tier awake and lets the backboard hold it while the block slides under', async () => {
    const rig = await createRig();
    rig.table.dropCoin(0, rig.rng);
    const zs: number[] = [];
    for (let i = 0; i < 4 * PUSHER.periodTicks; i++) {
      rig.step();
      zs.push(onlyCoin(rig.table).translation.z);
    }
    const coin = onlyCoin(rig.table);
    expect(coin.sleeping).toBe(false);
    expect(coin.translation.y).toBeGreaterThan(PUSHER.height);
    expect(Math.min(...zs)).toBeGreaterThan(BACKBOARD.frontZ + COIN.radius - 0.002);
  });
});

describe('pusher', () => {
  it('sweeps its front face through the configured stroke once per period', async () => {
    const rig = await createRig();
    const fronts: number[] = [];
    for (let i = 0; i < PUSHER.periodTicks; i++) {
      rig.step();
      fronts.push(rig.table.pusher.frontZ);
    }
    expect(Math.min(...fronts)).toBeCloseTo(PUSHER.frontZ, 9);
    expect(Math.max(...fronts)).toBeCloseTo(PUSHER.frontZ + PUSHER.stroke, 9);
    expect(rig.table.pusher.phase).toBe(0);
  });

  it('applies a new speed at once and a new stroke at the next retraction', async () => {
    const rig = await createRig();
    runTicks(rig, 30);
    rig.table.setPusherMotion({ stroke: 0.04, periodTicks: 120, pushFraction: 0.5 });
    expect(rig.table.pusher.motion.periodTicks).toBe(120);
    expect(rig.table.pusher.motion.stroke).toBe(PUSHER.stroke);
    runTicks(rig, 105);
    expect(rig.table.pusher.phase).toBe(0);
    const fronts: number[] = [];
    for (let i = 0; i < 120; i++) {
      rig.step();
      fronts.push(rig.table.pusher.frontZ);
    }
    expect(Math.max(...fronts)).toBeCloseTo(PUSHER.frontZ + 0.04, 9);
  });

  it('shoves a coin on the lower tier forward to at least its full reach', async () => {
    const rig = await createRig();
    rig.table.addCoin({ x: 0, y: COIN.halfThickness + 0.001, z: PUSHER.frontZ + 0.02 }, FLAT);
    runTicks(rig, PUSHER.periodTicks);
    const coin = onlyCoin(rig.table);
    expect(coin.translation.z).toBeGreaterThan(PUSHER.frontZ + PUSHER.stroke + COIN.radius - 0.002);
    expect(coin.translation.y).toBeCloseTo(COIN.halfThickness, 3);
  });
});

describe('fall detection', () => {
  it('reports coins leaving over the front edge and into each gutter, in coin id order', async () => {
    const rig = await createRig();
    const gutterX = PLAYFIELD.fieldHalfWidth + PLAYFIELD.gutterWidth / 2;
    const y = 0.01;
    const z = GUTTER_START_Z + 0.03;
    const right = rig.table.addCoin({ x: gutterX, y, z }, FLAT);
    const front = rig.table.addCoin({ x: 0, y, z: PLAYFIELD.fieldFrontZ + 0.02 }, FLAT);
    const left = rig.table.addCoin({ x: -gutterX, y, z }, FLAT);
    const stays = rig.table.addCoin({ x: 0, y, z }, FLAT);
    const falls = runTicks(rig, TICK_RATE_HZ);
    expect(falls.map(({ coinId, edge }) => ({ coinId, edge }))).toEqual([
      { coinId: right, edge: 'right' },
      { coinId: front, edge: 'front' },
      { coinId: left, edge: 'left' },
    ]);
    const [first] = falls;
    expect(falls.every((f) => f.tick === first?.tick)).toBe(true);
    expect(rig.table.coins().map((c) => c.id)).toEqual([stays]);
    expect(rig.table.nextCoinId).toBe(4);
  });

  it('tips a coin hanging over the front edge off and reports it once', async () => {
    const rig = await createRig();
    const id = rig.table.addCoin(
      { x: 0.02, y: COIN.halfThickness, z: PLAYFIELD.fieldFrontZ + COIN.radius * 0.4 },
      FLAT,
    );
    const falls = runTicks(rig, 2 * TICK_RATE_HZ);
    expect(falls).toHaveLength(1);
    expect(falls[0]).toMatchObject({ coinId: id, edge: 'front' });
    expect(rig.table.coinCount).toBe(0);
  });

  it('keeps a coin that rests well inside the edge', async () => {
    const rig = await createRig();
    rig.table.addCoin(
      { x: 0, y: COIN.halfThickness, z: PLAYFIELD.fieldFrontZ - COIN.radius * 0.6 },
      FLAT,
    );
    expect(runTicks(rig, 2 * TICK_RATE_HZ)).toEqual([]);
    expect(rig.table.coinCount).toBe(1);
  });
});

/** A scripted session: a coin every 6 ticks across the full drop range while fewer than 250 are on the table. */
function playSession(rig: Rig, ticks: number, onTick?: (falls: FallEvent[]) => void): void {
  for (let i = 0; i < ticks; i++) {
    if (rig.tick % 6 === 0 && rig.table.coinCount < 250) {
      rig.table.dropCoin((rig.rng.nextInt(301) - 150) / 1000, rig.rng);
    }
    const falls = rig.step();
    onTick?.(falls);
  }
}

function tableHash(rig: Rig): string {
  return rig.table.hashInto(new StateHasher().int(rig.tick)).digest();
}

const SESSION_TICKS = 60 * TICK_RATE_HZ;
const HASH_INTERVAL = 600;

interface Session {
  readonly hashes: string[];
  readonly falls: Record<FallEvent['edge'], number>;
  readonly upperTierPeak: number;
  readonly coins: ReturnType<PusherTable['coins']>;
}

function onUpperTier(coin: { translation: { y: number } }): boolean {
  return coin.translation.y > PUSHER.height;
}

async function recordSession(seed = SEED, ticks = SESSION_TICKS): Promise<Session> {
  const rig = await createRig({}, seed);
  const hashes: string[] = [];
  const falls = { front: 0, left: 0, right: 0 };
  let upperTierPeak = 0;
  playSession(rig, ticks, (tickFalls) => {
    for (const fall of tickFalls) {
      falls[fall.edge] += 1;
    }
    if (rig.tick % TICK_RATE_HZ === 0) {
      upperTierPeak = Math.max(upperTierPeak, rig.table.coins().filter(onUpperTier).length);
    }
    if (rig.tick % HASH_INTERVAL === 0) {
      hashes.push(tableHash(rig));
    }
  });
  return { hashes, falls, upperTierPeak, coins: rig.table.coins() };
}

let reference: Promise<Session> | undefined;
/** The scripted minute, played once and shared by the tests that inspect or compare against it. */
function referenceSession(): Promise<Session> {
  reference ??= recordSession();
  return reference;
}

describe('gameplay', () => {
  it('drains the upper tier over the lip and pays out mostly over the front edge', async () => {
    const { falls, upperTierPeak, coins } = await referenceSession();
    expect(upperTierPeak).toBeGreaterThan(80);
    expect(coins.filter(onUpperTier).length).toBeLessThan(upperTierPeak);
    expect(falls.front).toBeGreaterThan(20);
    expect(falls.front).toBeGreaterThan(2 * (falls.left + falls.right));
  });

  it('keeps every coin inside the cabinet: none behind the backboard, over a wall or bouncing high', async () => {
    const { coins } = await referenceSession();
    expect(coins.length).toBeGreaterThan(200);
    for (const coin of coins) {
      expect(coin.translation.z).toBeGreaterThan(BACKBOARD.frontZ);
      expect(Math.abs(coin.translation.x)).toBeLessThan(TABLE_INNER_HALF_WIDTH);
      expect(coin.translation.y).toBeLessThan(PUSHER.height + 0.03);
    }
  });
});

describe('determinism', () => {
  it('produces identical hashes for the same seed and drops', async () => {
    const first = (await referenceSession()).hashes;
    const second = (await recordSession()).hashes;
    expect(first).toHaveLength(SESSION_TICKS / HASH_INTERVAL);
    expect(second).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
  });

  it('pins the final table hash so geometry, tuning or pusher changes are caught', async () => {
    const { hashes } = await referenceSession();
    // Changing this value breaks replay audits of every input log recorded before
    // the change. Update it only alongside a deliberate sim version bump.
    expect(hashes.at(-1)).toMatchInlineSnapshot(`"0b9fbdafe76e2417"`);
  });

  it('stays identical when two tables are stepped interleaved in the same WASM instance', async () => {
    const expected = (await referenceSession()).hashes;
    const a = await createRig();
    const b = await createRig();
    for (let i = 0; i < 2 * HASH_INTERVAL; i++) {
      playSession(a, 1);
      playSession(b, 1);
    }
    expect(tableHash(a)).toBe(expected[1]);
    expect(tableHash(b)).toBe(expected[1]);
  });

  it('diverges for a different seed', async () => {
    const expected = (await referenceSession()).hashes;
    const other = await recordSession(SEED + 1, HASH_INTERVAL);
    expect(other.hashes[0]).not.toBe(expected[0]);
  });

  it('hashes the pusher motion, including a queued change', async () => {
    const a = await createRig();
    const b = await createRig();
    runTicks(a, 10);
    runTicks(b, 10);
    expect(tableHash(b)).toBe(tableHash(a));
    b.table.setPusherMotion({ ...DEFAULT_PUSHER_MOTION, stroke: 0.05 });
    expect(b.table.pusher.motion).toEqual(DEFAULT_PUSHER_MOTION);
    expect(tableHash(b)).not.toBe(tableHash(a));
  });
});
