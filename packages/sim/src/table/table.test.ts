import type { World } from '@dimforge/rapier3d-deterministic-compat';
import { afterEach, describe, expect, it } from 'vitest';
import { COIN } from '../coin.ts';
import { FIXED_DT, GRAVITY, TICK_RATE_HZ } from '../constants.ts';
import { StateHasher } from '../hash.ts';
import { Xoshiro128ss } from '../prng.ts';
import { loadRapier } from '../rapier.ts';
import { BACKBOARD, GUTTER_START_Z, PLAYFIELD, PUSHER, TABLE_INNER_HALF_WIDTH } from './layout.ts';
import { DEFAULT_PUSHER_MOTION } from './pusher.ts';
import { type FallEvent, PusherTable, type TableCoin, type TableOptions } from './table.ts';
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
      rig.tick += 1;
      return table.step(rig.tick);
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
    const scale = TABLE_SOLVER.worldScale;
    expect(world.integrationParameters.numSolverIterations).toBe(TABLE_SOLVER.numSolverIterations);
    expect(world.integrationParameters.lengthUnit).toBe(
      Math.fround(TABLE_SOLVER.lengthUnit * scale),
    );
    expect(world.timestep).toBe(Math.fround(FIXED_DT / TABLE_SOLVER.substeps));
    expect(world.gravity.y).toBeCloseTo(GRAVITY.y * scale, 5);
  });

  it('reports coin poses in metres although the world runs at its own scale', async () => {
    const rig = await createRig();
    const placed = { x: 0.1, y: 0.01, z: PLAYFIELD.fieldFrontZ - 0.03 };
    rig.table.addCoin(placed, FLAT);
    const before = onlyCoin(rig.table).translation;
    expect(before.x).toBeCloseTo(placed.x, 6);
    expect(before.y).toBeCloseTo(placed.y, 6);
    expect(before.z).toBeCloseTo(placed.z, 6);
    runTicks(rig, 2 * TICK_RATE_HZ);
    const after = onlyCoin(rig.table).translation;
    expect(after.x).toBeCloseTo(placed.x, 3);
    expect(after.y).toBeCloseTo(COIN.halfThickness, 3);
    expect(after.z).toBeCloseTo(placed.z, 3);
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

type Vec = TableCoin['translation'];
type Quat = TableCoin['rotation'];

function rotate(q: Quat, v: Vec): Vec {
  const ix = q.w * v.x + q.y * v.z - q.z * v.y;
  const iy = q.w * v.y + q.z * v.x - q.x * v.z;
  const iz = q.w * v.z + q.x * v.y - q.y * v.x;
  const iw = -q.x * v.x - q.y * v.y - q.z * v.z;
  return {
    x: ix * q.w - iw * q.x - iy * q.z + iz * q.y,
    y: iy * q.w - iw * q.y - iz * q.x + ix * q.z,
    z: iz * q.w - iw * q.z - ix * q.y + iy * q.x,
  };
}

/** Signed depth of a point, in a coin's own frame, inside it: positive inside, negative outside. */
function depthInCoin(p: Vec): number {
  const dr = Math.sqrt(p.x * p.x + p.z * p.z) - COIN.radius;
  const dy = Math.abs(p.y) - COIN.halfThickness;
  if (dr <= 0 && dy <= 0) {
    return Math.min(-dr, -dy);
  }
  const outR = Math.max(dr, 0);
  const outY = Math.max(dy, 0);
  return -Math.sqrt(outR * outR + outY * outY);
}

const GRID_ACROSS = 24;
const GRID_THROUGH = 4;
/** Grid points on the faces and rim must count as part of the coin despite rounding. */
const SURFACE_TOLERANCE = 1e-9;

/**
 * How deep any of a grid of points filling coin `a` sits inside coin `b`. Every point
 * of `a` has to leave `b` to separate them, so this is a lower bound on the
 * penetration depth, measured from the poses alone and independent of Rapier's own
 * contact depths (which misreport for thin cylinders).
 */
function sampledDepth(a: TableCoin, b: TableCoin): number {
  const inverse = { x: -b.rotation.x, y: -b.rotation.y, z: -b.rotation.z, w: b.rotation.w };
  let deepest = 0;
  for (let i = 0; i <= GRID_ACROSS; i++) {
    for (let j = 0; j <= GRID_ACROSS; j++) {
      for (let k = 0; k <= GRID_THROUGH; k++) {
        const local = {
          x: COIN.radius * ((2 * i) / GRID_ACROSS - 1),
          y: COIN.halfThickness * ((2 * k) / GRID_THROUGH - 1),
          z: COIN.radius * ((2 * j) / GRID_ACROSS - 1),
        };
        if (depthInCoin(local) < -SURFACE_TOLERANCE) {
          continue;
        }
        const w = rotate(a.rotation, local);
        const inB = rotate(inverse, {
          x: a.translation.x + w.x - b.translation.x,
          y: a.translation.y + w.y - b.translation.y,
          z: a.translation.z + w.z - b.translation.z,
        });
        deepest = Math.max(deepest, depthInCoin(inB));
      }
    }
  }
  return deepest;
}

function penetrationDepth(a: TableCoin, b: TableCoin): number {
  return Math.max(sampledDepth(a, b), sampledDepth(b, a));
}

interface OverlapSample {
  /** Pairs whose bounding spheres touch. */
  readonly near: number;
  readonly deeperThan02mm: number;
  readonly deeperThan05mm: number;
  readonly deeperThan1mm: number;
}

function sampleOverlaps(coins: readonly TableCoin[]): OverlapSample {
  const reach = 2 * Math.sqrt(COIN.radius * COIN.radius + COIN.halfThickness * COIN.halfThickness);
  const sample = { near: 0, deeperThan02mm: 0, deeperThan05mm: 0, deeperThan1mm: 0 };
  for (let i = 0; i < coins.length; i++) {
    for (let j = i + 1; j < coins.length; j++) {
      const a = coins[i];
      const b = coins[j];
      if (!a || !b) {
        throw new Error(`coin list changed while sampling overlaps at ${i}, ${j}`);
      }
      const dx = a.translation.x - b.translation.x;
      const dy = a.translation.y - b.translation.y;
      const dz = a.translation.z - b.translation.z;
      if (dx * dx + dy * dy + dz * dz > reach * reach) {
        continue;
      }
      sample.near += 1;
      const depth = penetrationDepth(a, b);
      sample.deeperThan02mm += depth > 0.0002 ? 1 : 0;
      sample.deeperThan05mm += depth > 0.0005 ? 1 : 0;
      sample.deeperThan1mm += depth > 0.001 ? 1 : 0;
    }
  }
  return sample;
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
  readonly nextCoinId: number;
  /** Overlap samples, every HASH_INTERVAL once the table is full. */
  readonly overlaps: OverlapSample[];
}

const FULL_TABLE_TICKS = 30 * TICK_RATE_HZ;

function onUpperTier(coin: { translation: { y: number } }): boolean {
  return coin.translation.y > PUSHER.height;
}

async function recordSession(seed = SEED, ticks = SESSION_TICKS): Promise<Session> {
  const rig = await createRig({}, seed);
  const hashes: string[] = [];
  const overlaps: OverlapSample[] = [];
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
      if (rig.tick >= FULL_TABLE_TICKS) {
        overlaps.push(sampleOverlaps(rig.table.coins()));
      }
    }
  });
  return {
    hashes,
    falls,
    upperTierPeak,
    coins: rig.table.coins(),
    nextCoinId: rig.table.nextCoinId,
    overlaps,
  };
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
    const { coins, nextCoinId } = await referenceSession();
    expect(coins.length).toBeGreaterThan(200);
    // The table keeps paying out, so drops continue to the end; the last second of
    // them may still be in the air.
    const landedBefore = nextCoinId - TICK_RATE_HZ / 6;
    for (const coin of coins) {
      expect(coin.translation.z).toBeGreaterThan(BACKBOARD.frontZ);
      expect(Math.abs(coin.translation.x)).toBeLessThan(TABLE_INNER_HALF_WIDTH);
      if (coin.id < landedBefore) {
        expect(coin.translation.y).toBeLessThan(PUSHER.height + 0.03);
      }
    }
  });
});

/** Rapier's allowed linear error at the table's length unit (see SOLVER). */
const ALLOWED_PENETRATION = 0.0001;

describe('contacts', () => {
  it('measures no overlap for two coins resting face to face, and a planted one exactly', async () => {
    const rig = await createRig();
    const z = PLAYFIELD.fieldFrontZ - 0.04;
    rig.table.addCoin({ x: 0, y: COIN.halfThickness, z }, FLAT);
    rig.table.addCoin({ x: 0.004, y: 3 * COIN.halfThickness + 0.001, z }, FLAT);
    runTicks(rig, 2 * TICK_RATE_HZ);
    const [bottom, top] = rig.table.coins();
    if (!bottom || !top) {
      throw new Error(`expected two coins on the table, found ${rig.table.coinCount}`);
    }
    const resting = penetrationDepth(bottom, top);
    expect(resting).toBeLessThan(ALLOWED_PENETRATION);
    expect(top.translation.y - bottom.translation.y).toBeGreaterThan(
      2 * COIN.halfThickness - ALLOWED_PENETRATION,
    );
    const sunk = { ...top, translation: { ...top.translation, y: top.translation.y - 0.0005 } };
    expect(penetrationDepth(bottom, sunk) - resting).toBeCloseTo(0.0005, 5);
  });

  it('keeps coins in the full, moving pile from sinking into each other', async () => {
    const { overlaps } = await referenceSession();
    expect(overlaps).toHaveLength((SESSION_TICKS - FULL_TABLE_TICKS) / HASH_INTERVAL + 1);
    for (const sample of overlaps) {
      expect(sample.near).toBeGreaterThan(500);
      // Measured on this session: 4 to 5% of 650 to 950 touching pairs past 0.5 mm
      // and at most 10 past 1 mm, against about 414 past 0.5 mm (half of all
      // touching pairs) at true scale with soft contacts. The bounds leave room for a
      // reseeded or retuned table, not for a return to that.
      expect(sample.deeperThan05mm / sample.near).toBeLessThan(0.08);
      expect(sample.deeperThan1mm).toBeLessThanOrEqual(20);
      expect(sample.deeperThan02mm / sample.near).toBeLessThan(0.2);
    }
  });
});

describe('determinism', () => {
  it('produces identical hashes for the same seed and drops', async () => {
    const first = (await referenceSession()).hashes;
    const second = (await recordSession(SEED, FULL_TABLE_TICKS)).hashes;
    expect(first).toHaveLength(SESSION_TICKS / HASH_INTERVAL);
    expect(second).toHaveLength(FULL_TABLE_TICKS / HASH_INTERVAL);
    expect(second).toEqual(first.slice(0, second.length));
    expect(new Set(first).size).toBe(first.length);
  });

  it('pins the final table hash so geometry, tuning or pusher changes are caught', async () => {
    const { hashes } = await referenceSession();
    // Changing this value breaks replay audits of every input log recorded before
    // the change. Update it only alongside a deliberate sim version bump.
    expect(hashes.at(-1)).toMatchInlineSnapshot(`"a6b699fde99f393b"`);
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
