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
import { COIN_MATERIAL, configureTableWorld, TABLE_SOLVER } from './tuning.ts';

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
    expect(lowest).toBeGreaterThan(restY);
    expect(peakAfterLanding - coin.translation.y).toBeLessThan(0.0005);
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

const UP = { x: 0, y: 1, z: 0 } as const;

function dot(a: Vec, b: Vec): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function unit(v: Vec): Vec | undefined {
  const length = Math.sqrt(dot(v, v));
  return length < 1e-12 ? undefined : { x: v.x / length, y: v.y / length, z: v.z / length };
}

function rejectFrom(v: Vec, axis: Vec): Vec {
  const along = dot(v, axis);
  return { x: v.x - along * axis.x, y: v.y - along * axis.y, z: v.z - along * axis.z };
}

function cross(a: Vec, b: Vec): Vec {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

/** Half the width of a coin whose face normal is `axis`, measured along the unit direction `n`. */
function halfExtent(axis: Vec, n: Vec): number {
  const along = Math.min(1, Math.abs(dot(axis, n)));
  return COIN.halfThickness * along + COIN.radius * Math.sqrt(1 - along * along);
}

const CUBE_STEPS = 6;
/**
 * Directions through the grid points on the upper half of a cube's surface. Overlap
 * is the same along n and -n, so a hemisphere covers them all.
 */
const HEMISPHERE_DIRECTIONS: readonly Vec[] = (() => {
  const directions: Vec[] = [];
  for (let y = 0; y <= CUBE_STEPS; y++) {
    for (let x = -CUBE_STEPS; x <= CUBE_STEPS; x++) {
      for (let z = -CUBE_STEPS; z <= CUBE_STEPS; z++) {
        const onSurface =
          y === CUBE_STEPS || Math.abs(x) === CUBE_STEPS || Math.abs(z) === CUBE_STEPS;
        const n = onSurface ? unit({ x, y, z }) : undefined;
        if (n) {
          directions.push(n);
        }
      }
    }
  }
  return directions;
})();
const NUDGES: readonly Vec[] = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
];

/**
 * Penetration depth of two coins: the shortest distance one has to move to separate
 * them. For two convex bodies that is the smallest overlap of their projections over
 * all directions (separating axis theorem), searched here over the face normals, the
 * centre line, the edge directions and a dense sphere of directions, then refined
 * locally. It is measured from the poses alone, independent of Rapier's own contact
 * depths (which misreport for thin cylinders), and is not capped by the coin's
 * thickness the way a point-inside test is.
 */
function penetrationDepth(a: TableCoin, b: TableCoin): number {
  const axisA = rotate(a.rotation, UP);
  const axisB = rotate(b.rotation, UP);
  const between = {
    x: b.translation.x - a.translation.x,
    y: b.translation.y - a.translation.y,
    z: b.translation.z - a.translation.z,
  };
  const overlap = (n: Vec): number =>
    halfExtent(axisA, n) + halfExtent(axisB, n) - Math.abs(dot(between, n));
  const candidates = [
    axisA,
    axisB,
    unit(between),
    unit(rejectFrom(between, axisA)),
    unit(rejectFrom(between, axisB)),
    unit(cross(axisA, axisB)),
    ...HEMISPHERE_DIRECTIONS,
  ];
  let best = Number.POSITIVE_INFINITY;
  let bestDirection: Vec = UP;
  for (const n of candidates) {
    if (!n) {
      continue;
    }
    const o = overlap(n);
    if (o <= 0) {
      return 0;
    }
    if (o < best) {
      best = o;
      bestDirection = n;
    }
  }
  let step = 0.05;
  while (step > 1e-6) {
    let improved = false;
    for (const nudge of NUDGES) {
      const n = unit({
        x: bestDirection.x + step * nudge.x,
        y: bestDirection.y + step * nudge.y,
        z: bestDirection.z + step * nudge.z,
      });
      if (!n) {
        continue;
      }
      const o = overlap(n);
      if (o <= 0) {
        return 0;
      }
      if (o < best) {
        best = o;
        bestDirection = n;
        improved = true;
      }
    }
    if (!improved) {
      step /= 2;
    }
  }
  return best;
}

interface OverlapSample {
  /** Pairs whose bounding spheres touch. */
  readonly near: number;
  readonly deepest: number;
  /** Pairs past OVERLAP_TOLERANCE, as "lowId-highId". */
  readonly pastTolerance: string[];
  readonly pastOneMm: string[];
}

/**
 * The overlap the pile is held to. Coins carry a contact skin and rest apart, and
 * Rapier lets a contact sink only 0.15 mm at the table's length unit (see
 * TABLE_SOLVER), so a settled pair sits well inside this.
 */
const OVERLAP_TOLERANCE = 0.0005;

function sampleOverlaps(coins: readonly TableCoin[]): OverlapSample {
  const reach = 2 * Math.sqrt(COIN.radius * COIN.radius + COIN.halfThickness * COIN.halfThickness);
  const sample = { near: 0, deepest: 0, pastTolerance: [] as string[], pastOneMm: [] as string[] };
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
      sample.deepest = Math.max(sample.deepest, depth);
      const pair = `${Math.min(a.id, b.id)}-${Math.max(a.id, b.id)}`;
      if (depth > OVERLAP_TOLERANCE) {
        sample.pastTolerance.push(pair);
      }
      if (depth > 0.001) {
        sample.pastOneMm.push(pair);
      }
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
  /** Overlap samples, once a second from FULL_TABLE_TICKS on. */
  readonly overlaps: OverlapSample[];
  /**
   * For every pair a sample caught past OVERLAP_TOLERANCE: how many ticks it took,
   * checked every tick from then on, to get back within it.
   */
  readonly releaseTicks: number[];
}

const FULL_TABLE_TICKS = 30 * TICK_RATE_HZ;

function onUpperTier(coin: { translation: { y: number } }): boolean {
  return coin.translation.y > PUSHER.height;
}

/**
 * Follows pairs caught past OVERLAP_TOLERANCE tick by tick until they are back within
 * it (or one coin has left the table), recording how long each took.
 */
class OverlapWatch {
  readonly releaseTicks: number[] = [];
  readonly #since = new Map<string, number>();

  watch(pairs: readonly string[], tick: number): void {
    for (const pair of pairs) {
      if (!this.#since.has(pair)) {
        this.#since.set(pair, tick);
      }
    }
  }

  update(table: PusherTable, tick: number): void {
    if (this.#since.size === 0) {
      return;
    }
    const byId = new Map(table.coins().map((coin) => [coin.id, coin]));
    for (const [pair, since] of this.#since) {
      const [a, b] = pair.split('-').map((id) => byId.get(Number(id)));
      if (!a || !b || penetrationDepth(a, b) <= OVERLAP_TOLERANCE) {
        this.releaseTicks.push(tick - since);
        this.#since.delete(pair);
      }
    }
  }

  /** Pairs still past the tolerance count as held until `tick`. */
  close(tick: number): void {
    for (const since of this.#since.values()) {
      this.releaseTicks.push(tick - since);
    }
    this.#since.clear();
  }
}

async function recordSession(seed = SEED, ticks = SESSION_TICKS): Promise<Session> {
  const rig = await createRig({}, seed);
  const hashes: string[] = [];
  const overlaps: OverlapSample[] = [];
  const watch = new OverlapWatch();
  const falls = { front: 0, left: 0, right: 0 };
  let upperTierPeak = 0;
  playSession(rig, ticks, (tickFalls) => {
    for (const fall of tickFalls) {
      falls[fall.edge] += 1;
    }
    watch.update(rig.table, rig.tick);
    if (rig.tick % TICK_RATE_HZ === 0) {
      upperTierPeak = Math.max(upperTierPeak, rig.table.coins().filter(onUpperTier).length);
      if (rig.tick >= FULL_TABLE_TICKS) {
        const sample = sampleOverlaps(rig.table.coins());
        overlaps.push(sample);
        watch.watch(sample.pastTolerance, rig.tick);
      }
    }
    if (rig.tick % HASH_INTERVAL === 0) {
      hashes.push(tableHash(rig));
    }
  });
  watch.close(rig.tick);
  return {
    hashes,
    falls,
    upperTierPeak,
    coins: rig.table.coins(),
    nextCoinId: rig.table.nextCoinId,
    overlaps,
    releaseTicks: watch.releaseTicks,
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

/** Rapier's allowed linear error, 0.005 length units, at the table's length unit. */
const ALLOWED_PENETRATION = 0.005 * TABLE_SOLVER.lengthUnit;

function flatCoinAt(id: number, x: number): TableCoin {
  return { id, translation: { x, y: COIN.halfThickness, z: 0 }, rotation: FLAT, sleeping: false };
}

/** Pairs still in `pick` of a sample one second after they were in it. */
function persistentPairs(
  overlaps: readonly OverlapSample[],
  pick: (sample: OverlapSample) => readonly string[],
): string[] {
  const persistent: string[] = [];
  for (const [i, sample] of overlaps.entries()) {
    const previous = overlaps[i - 1];
    if (previous) {
      const before = new Set(pick(previous));
      persistent.push(...pick(sample).filter((pair) => before.has(pair)));
    }
  }
  return persistent;
}

/** Most consecutive samples any one pair stays past OVERLAP_TOLERANCE. */
function longestPersistence(overlaps: readonly OverlapSample[]): number {
  let longest = 0;
  let runs = new Map<string, number>();
  for (const sample of overlaps) {
    const next = new Map<string, number>();
    for (const pair of sample.pastTolerance) {
      const run = (runs.get(pair) ?? 0) + 1;
      next.set(pair, run);
      longest = Math.max(longest, run);
    }
    runs = next;
  }
  return longest;
}

describe('contacts', () => {
  it('measures the full depth of two flat coins planted rim into rim', () => {
    const a = flatCoinAt(0, 0);
    const touching = 2 * COIN.radius;
    expect(penetrationDepth(a, flatCoinAt(1, touching + 0.0001))).toBe(0);
    expect(penetrationDepth(a, flatCoinAt(1, touching - 0.001))).toBeCloseTo(0.001, 6);
    expect(penetrationDepth(a, flatCoinAt(1, touching - 0.002))).toBeCloseTo(0.002, 6);
    // 3 mm into each other side by side, lifting one coin over the other (one
    // thickness, 2.6 mm) is the shorter way apart, so that is the true depth.
    expect(penetrationDepth(a, flatCoinAt(1, touching - 0.003))).toBeCloseTo(
      2 * COIN.halfThickness,
      6,
    );
  });

  it('rests two coins face to face a skin apart, and measures a planted one exactly', async () => {
    const rig = await createRig();
    const z = PLAYFIELD.fieldFrontZ - 0.04;
    rig.table.addCoin({ x: 0, y: COIN.halfThickness, z }, FLAT);
    rig.table.addCoin({ x: 0.004, y: 3 * COIN.halfThickness + 0.001, z }, FLAT);
    runTicks(rig, 2 * TICK_RATE_HZ);
    const [bottom, top] = rig.table.coins();
    if (!bottom || !top) {
      throw new Error(`expected two coins on the table, found ${rig.table.coinCount}`);
    }
    expect(penetrationDepth(bottom, top)).toBe(0);
    const gap = top.translation.y - bottom.translation.y - 2 * COIN.halfThickness;
    expect(gap).toBeGreaterThan(2 * COIN_MATERIAL.contactSkin - ALLOWED_PENETRATION);
    expect(gap).toBeLessThan(2 * COIN_MATERIAL.contactSkin + ALLOWED_PENETRATION);
    const sunk = {
      ...top,
      translation: { ...top.translation, y: top.translation.y - gap - 0.0005 },
    };
    expect(penetrationDepth(bottom, sunk)).toBeCloseTo(0.0005, 4);
  });

  it('keeps coins in the full, moving pile from sinking into each other', async () => {
    const { overlaps, releaseTicks } = await referenceSession();
    expect(overlaps).toHaveLength((SESSION_TICKS - FULL_TABLE_TICKS) / TICK_RATE_HZ + 1);
    // Measured on this session (31 samples, 504 to 760 touching pairs each): at most
    // 3 pairs past 0.5 mm and 2 past 1 mm per sample, the deepest 1.65 mm; 22 pairs
    // caught past 0.5 mm, each back within it after at most 8 ticks; 2 pair-samples
    // still past 0.5 mm a second later (none past 1 mm), and no pair in more than 2
    // samples in a row. Before the contact skin and the inner PGS iterations this
    // session had 3 to 20 pairs past 0.5 mm per sample and a pair held for 6 s.
    for (const sample of overlaps) {
      expect(sample.near).toBeGreaterThan(500);
      expect(sample.pastTolerance.length).toBeLessThanOrEqual(4);
      expect(sample.pastOneMm.length).toBeLessThanOrEqual(2);
      expect(sample.deepest).toBeLessThan(0.002);
    }
    expect(releaseTicks.length).toBeGreaterThan(0);
    expect(Math.max(...releaseTicks)).toBeLessThanOrEqual(TICK_RATE_HZ / 4);
    expect(persistentPairs(overlaps, (s) => s.pastTolerance).length).toBeLessThanOrEqual(4);
    expect(persistentPairs(overlaps, (s) => s.pastOneMm)).toEqual([]);
    expect(longestPersistence(overlaps)).toBeLessThanOrEqual(2);
  });
});

describe('determinism', () => {
  it('produces identical hashes for the same seed and drops', async () => {
    const first = await referenceSession();
    const second = await recordSession();
    expect(first.hashes).toHaveLength(SESSION_TICKS / HASH_INTERVAL);
    expect(second).toEqual(first);
    expect(new Set(first.hashes).size).toBe(first.hashes.length);
  });

  it('pins the final table hash so geometry, tuning or pusher changes are caught', async () => {
    const { hashes } = await referenceSession();
    // Changing this value breaks replay audits of every input log recorded before
    // the change. Update it only alongside a deliberate sim version bump.
    expect(hashes.at(-1)).toMatchInlineSnapshot(`"0f07d3e911f71f99"`);
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
