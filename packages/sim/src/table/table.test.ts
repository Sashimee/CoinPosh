import type { RigidBody, World } from '@dimforge/rapier3d-deterministic-compat';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { COIN } from '../coin.ts';
import { FIXED_DT, GRAVITY, TICK_RATE_HZ } from '../constants.ts';
import { StateHasher } from '../hash.ts';
import { Xoshiro128ss } from '../prng.ts';
import { loadRapier } from '../rapier.ts';
import { BACKBOARD, GUTTER_START_Z, PLAYFIELD, PUSHER, TABLE_INNER_HALF_WIDTH } from './layout.ts';
import { DEFAULT_PUSHER_MOTION } from './pusher.ts';
import {
  type ContactEvent,
  type FallEvent,
  PusherTable,
  type TableCoin,
  type TableOptions,
} from './table.ts';
import { COIN_MATERIAL, CONTACT_EVENTS, configureTableWorld, TABLE_SOLVER } from './tuning.ts';

const FLAT = { x: 0, y: 0, z: 0, w: 1 } as const;
const SEED = 0x7ab1e001;
const SCALE = TABLE_SOLVER.worldScale;

interface Rig {
  readonly world: World;
  readonly table: PusherTable;
  readonly rng: Xoshiro128ss;
  tick: number;
  /** One tick: pusher, physics, fall detection. Returns that tick's falls. */
  step(): FallEvent[];
}

const live: World[] = [];

/** A rig the caller frees. */
async function buildRig(options: TableOptions = {}, seed = SEED): Promise<Rig> {
  const rapier = await loadRapier();
  const world = new rapier.World(GRAVITY);
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

/** A rig freed after the current test. */
async function createRig(options: TableOptions = {}, seed = SEED): Promise<Rig> {
  const rig = await buildRig(options, seed);
  live.push(rig.world);
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

  it('sweeps lanes of coins in front of the block forward and over the lip, reporting each fall', async () => {
    const rig = await createRig();
    const pitch = 2 * COIN.radius + 0.002;
    const start = new Map<number, number>();
    for (const x of [-0.08, 0, 0.08]) {
      for (let z = PUSHER.frontZ + COIN.radius + 0.004; z < PLAYFIELD.fieldFrontZ; z += pitch) {
        start.set(rig.table.addCoin({ x, y: COIN.halfThickness + 0.0005, z }, FLAT), z);
      }
    }
    const falls = runTicks(rig, 2 * PUSHER.periodTicks);
    expect(falls.length).toBeGreaterThanOrEqual(6);
    for (const fall of falls) {
      expect(fall.edge).toBe('front');
      expect(start.has(fall.coinId)).toBe(true);
    }
    const left = rig.table.coins();
    expect(left.length + falls.length).toBe(start.size);
    for (const coin of left) {
      expect(coin.translation.z, `coin ${coin.id}`).toBeGreaterThan(
        (start.get(coin.id) ?? Number.POSITIVE_INFINITY) + 0.03,
      );
    }
  });
});

describe('nudge', () => {
  async function restingRig(): Promise<Rig> {
    const rig = await createRig();
    rig.table.addCoin({ x: 0, y: COIN.halfThickness, z: 0.02 }, FLAT);
    rig.table.addCoin({ x: 0, y: PUSHER.height + COIN.halfThickness, z: -0.17 }, FLAT);
    runTicks(rig, TICK_RATE_HZ);
    return rig;
  }

  it('shoves every coin the way the cabinet is jolted, a few millimetres', async () => {
    for (const [direction, axis, sign] of [
      ['forward', 'z', 1],
      ['left', 'x', -1],
      ['right', 'x', 1],
    ] as const) {
      const rig = await restingRig();
      const control = await restingRig();
      rig.table.nudge(direction);
      runTicks(rig, TICK_RATE_HZ / 2);
      runTicks(control, TICK_RATE_HZ / 2);
      const still = control.table.coins();
      const after = rig.table.coins();
      expect(after).toHaveLength(2);
      after.forEach((coin, i) => {
        const moved = sign * (coin.translation[axis] - (still[i]?.translation[axis] ?? 0));
        expect(moved, `${direction}, coin ${coin.id}`).toBeGreaterThan(0.001);
        expect(moved, `${direction}, coin ${coin.id}`).toBeLessThan(0.012);
      });
    }
  });

  it('wakes sleeping coins and replays bit for bit', async () => {
    const a = await restingRig();
    const b = await restingRig();
    runTicks(a, 4 * TICK_RATE_HZ);
    runTicks(b, 4 * TICK_RATE_HZ);
    const lower = a.table.coins().find((coin) => coin.translation.y < PUSHER.height);
    expect(lower?.sleeping).toBe(true);
    a.table.nudge('left');
    b.table.nudge('left');
    expect(a.table.coins().every((coin) => !coin.sleeping)).toBe(true);
    runTicks(a, 30);
    runTicks(b, 30);
    expect(tableHash(b)).toBe(tableHash(a));
    const c = await restingRig();
    runTicks(c, 4 * TICK_RATE_HZ + 30);
    expect(tableHash(c)).not.toBe(tableHash(a));
  });

  it('rejects an unknown direction', async () => {
    const rig = await createRig();
    expect(() => {
      rig.table.nudge('back' as 'left');
    }).toThrow('PusherTable.nudge: unknown direction "back"');
  });
});

describe('contact events', () => {
  function contactsUntilQuiet(rig: Rig, ticks: number): ContactEvent[] {
    const contacts: ContactEvent[] = [];
    for (let i = 0; i < ticks; i++) {
      rig.step();
      contacts.push(...rig.table.contacts);
    }
    return contacts;
  }

  it('reports a dropped coin landing on the pusher, scaled by its closing speed', async () => {
    const rig = await createRig();
    const id = rig.table.dropCoin(0, rig.rng);
    const contacts = contactsUntilQuiet(rig, TICK_RATE_HZ);
    const [first] = contacts;
    expect(first).toMatchObject({ coinId: id, surface: 'pusher' });
    expect(first?.speed).toBeGreaterThan(1.2);
    expect(first?.strength).toBeCloseTo(
      Math.min(1, (first?.speed ?? 0) / CONTACT_EVENTS.fullSpeed),
      12,
    );
    expect(first?.position.y).toBeLessThan(PUSHER.height + 0.03);
    for (const [i, contact] of contacts.entries()) {
      expect(contact.strength).toBeGreaterThan(0);
      expect(contact.strength).toBeLessThanOrEqual(1);
      const next = contacts[i + 1];
      if (next) {
        expect(next.tick - contact.tick).toBeGreaterThanOrEqual(CONTACT_EVENTS.cooldownTicks);
      }
    }
  });

  it('names the floor and another coin, and reports contacts in coin id order', async () => {
    const rig = await createRig();
    const resting = rig.table.addCoin({ x: 0, y: COIN.halfThickness, z: 0.0 }, FLAT);
    runTicks(rig, 10);
    const onCoin = rig.table.addCoin({ x: 0, y: 0.05, z: 0.0 }, FLAT);
    const onFloor = rig.table.addCoin({ x: -0.1, y: 0.05, z: 0.0 }, FLAT);
    let seen: ContactEvent[] = [];
    for (let i = 0; i < TICK_RATE_HZ && seen.length === 0; i++) {
      rig.step();
      seen = rig.table.contacts.slice();
    }
    expect(seen.map(({ coinId, surface }) => ({ coinId, surface }))).toEqual([
      { coinId: onCoin, surface: 'coin' },
      { coinId: onFloor, surface: 'floor' },
    ]);
    expect(seen.every((contact) => contact.tick === rig.tick)).toBe(true);
    expect(resting).toBe(0);
  });

  it('reports nothing for coins at rest', async () => {
    const rig = await createRig();
    rig.table.addCoin({ x: 0, y: COIN.halfThickness, z: 0.0 }, FLAT);
    expect(contactsUntilQuiet(rig, TICK_RATE_HZ)).toEqual([]);
  });
});

describe('removeCoin', () => {
  it('takes a coin off without a fall and refuses an id that is not on the table', async () => {
    const rig = await createRig();
    const a = rig.table.addCoin({ x: 0, y: COIN.halfThickness, z: 0.0 }, FLAT);
    const b = rig.table.addCoin({ x: 0.05, y: COIN.halfThickness, z: 0.0 }, FLAT);
    rig.table.removeCoin(a);
    expect(rig.table.coins().map((coin) => coin.id)).toEqual([b]);
    expect(runTicks(rig, 10)).toEqual([]);
    expect(rig.table.nextCoinId).toBe(2);
    expect(() => {
      rig.table.removeCoin(a);
    }).toThrow('PusherTable.removeCoin: coin 0 is not on the table');
    expect(() => {
      rig.table.removeCoin(7);
    }).toThrow(RangeError);
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

const RIM = COIN_MATERIAL.rimRadius;

/**
 * Half the width of a coin whose face normal is `axis`, measured along the unit
 * direction `n`: the support of the collider, a cylinder shrunk by the rim radius
 * and swept by a sphere of that radius.
 */
function halfExtent(axis: Vec, n: Vec): number {
  const along = Math.min(1, Math.abs(dot(axis, n)));
  return (
    (COIN.halfThickness - RIM) * along + (COIN.radius - RIM) * Math.sqrt(1 - along * along) + RIM
  );
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
 * depths, and is not capped by the coin's thickness the way a point-inside test is.
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

/**
 * The deepest any pair may sink into another, on any tick. The separation pass (see
 * TABLE_SOLVER) holds every pair to 0.2 mm after a tick; this leaves room for the
 * difference between its measure and this file's.
 */
const OVERLAP_TOLERANCE = 0.0005;

/** Seeds besides SEED whose whole minute is checked for overlap and convergence. */
const EXTRA_SEEDS = [12345, 777, 424242, 2024];

/** Every pair of coins whose bounding spheres touch, with its penetration depth. */
function touchingPairs(coins: readonly TableCoin[]): { pair: string; depth: number }[] {
  const reach = 2 * Math.sqrt(COIN.radius * COIN.radius + COIN.halfThickness * COIN.halfThickness);
  const pairs: { pair: string; depth: number }[] = [];
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
      if (dx * dx + dy * dy + dz * dz <= reach * reach) {
        pairs.push({ pair: `${a.id}-${b.id}`, depth: penetrationDepth(a, b) });
      }
    }
  }
  return pairs;
}

/** Pair overlaps measured on every tick of a session, from the first drop to the end. */
class OverlapLog {
  ticks = 0;
  deepest = 0;
  /** Fewest touching pairs on any tick from FULL_TABLE_TICKS on. */
  fewestNearOnFullTable = Number.POSITIVE_INFINITY;
  /** Fewest coins on the table on any tick from FULL_TABLE_TICKS on. */
  fewestCoinsOnFullTable = Number.POSITIVE_INFINITY;

  record(coins: readonly TableCoin[], tick: number): void {
    const pairs = touchingPairs(coins);
    this.ticks += 1;
    for (const { depth } of pairs) {
      this.deepest = Math.max(this.deepest, depth);
    }
    if (tick >= FULL_TABLE_TICKS) {
      this.fewestNearOnFullTable = Math.min(this.fewestNearOnFullTable, pairs.length);
      this.fewestCoinsOnFullTable = Math.min(this.fewestCoinsOnFullTable, coins.length);
    }
  }
}

function tableHash(rig: Rig): string {
  return rig.table.hashInto(new StateHasher().int(rig.tick)).digest();
}

const SESSION_TICKS = 60 * TICK_RATE_HZ;
const HASH_INTERVAL = 600;
const FULL_TABLE_TICKS = 30 * TICK_RATE_HZ;

function onUpperTier(coin: { translation: { y: number } }): boolean {
  return coin.translation.y > PUSHER.height;
}

/** The scripted session, played forward only as far as a test asks. */
class Session {
  readonly hashes: string[] = [];
  readonly falls: Record<FallEvent['edge'], number> = { front: 0, left: 0, right: 0 };
  upperTierPeak = 0;
  /** Ticks on which the separation pass ran out of passes before it cleared every pair. */
  readonly unconverged: number[] = [];
  mostSeparationPasses = 0;
  readonly #rig: Rig;
  readonly #overlaps: OverlapLog | undefined;

  constructor(rig: Rig, overlaps?: OverlapLog) {
    this.#rig = rig;
    this.#overlaps = overlaps;
  }

  get rig(): Rig {
    return this.#rig;
  }

  get overlaps(): OverlapLog {
    if (!this.#overlaps) {
      throw new Error('this session was played without measuring overlaps');
    }
    return this.#overlaps;
  }

  advanceTo(ticks: number): this {
    const rig = this.#rig;
    playSession(rig, ticks - rig.tick, (tickFalls) => {
      for (const fall of tickFalls) {
        this.falls[fall.edge] += 1;
      }
      const { converged, passes } = rig.table.separation;
      if (!converged) {
        this.unconverged.push(rig.tick);
      }
      this.mostSeparationPasses = Math.max(this.mostSeparationPasses, passes);
      this.#overlaps?.record(rig.table.coins(), rig.tick);
      if (rig.tick % TICK_RATE_HZ === 0) {
        const upper = rig.table.coins().filter(onUpperTier).length;
        this.upperTierPeak = Math.max(this.upperTierPeak, upper);
      }
      if (rig.tick % HASH_INTERVAL === 0) {
        this.hashes.push(tableHash(rig));
      }
    });
    return this;
  }

  /** Everything the session produced that a replay has to reproduce exactly. */
  outcome(): object {
    const { table } = this.#rig;
    return {
      hashes: this.hashes,
      falls: this.falls,
      upperTierPeak: this.upperTierPeak,
      coins: table.coins(),
      nextCoinId: table.nextCoinId,
    };
  }
}

interface ScriptedMinute {
  /** Measures pair overlaps on every tick. */
  readonly reference: Session;
  readonly replica: Session;
}

let minute: Promise<ScriptedMinute> | undefined;

/**
 * Two independent plays of the scripted minute that live for the whole file and
 * advance only as far as a test asks. Playing the minute twice inside one test
 * risks the CI timeout on a 2-vCPU runner, so the comparison is spread over one
 * test per checkpoint rather than shortened.
 */
function scriptedMinute(): Promise<ScriptedMinute> {
  minute ??= Promise.all([buildRig(), buildRig()]).then(([reference, replica]) => ({
    reference: new Session(reference, new OverlapLog()),
    replica: new Session(replica),
  }));
  return minute;
}

async function referenceTo(ticks: number): Promise<Session> {
  return (await scriptedMinute()).reference.advanceTo(ticks);
}

afterAll(async () => {
  if (minute) {
    const { reference, replica } = await minute;
    reference.rig.world.free();
    replica.rig.world.free();
  }
});

const CHECKPOINT_TICKS = Array.from(
  { length: SESSION_TICKS / HASH_INTERVAL },
  (_, i) => (i + 1) * HASH_INTERVAL,
);

describe('determinism', () => {
  it.each(CHECKPOINT_TICKS)(
    'produces identical hashes up to tick %i for the same seed and drops',
    async (tick) => {
      const { replica } = await scriptedMinute();
      const expected = (await referenceTo(tick)).hashes;
      expect(expected).toHaveLength(tick / HASH_INTERVAL);
      expect(replica.advanceTo(tick).hashes).toEqual(expected);
    },
  );

  it('ends both plays of the minute with the same coins, falls and next coin id', async () => {
    const { replica } = await scriptedMinute();
    const reference = await referenceTo(SESSION_TICKS);
    expect(replica.advanceTo(SESSION_TICKS).outcome()).toEqual(reference.outcome());
    expect(new Set(reference.hashes).size).toBe(reference.hashes.length);
  });

  it('pins the final table hash so geometry, tuning or pusher changes are caught', async () => {
    const { hashes } = await referenceTo(SESSION_TICKS);
    // Changing this value breaks replay audits of every input log recorded before
    // the change. Update it only alongside a deliberate sim version bump.
    expect(hashes.at(-1)).toMatchInlineSnapshot(`"a4e6238cc93d4acc"`);
  });

  it('stays identical when two tables are stepped interleaved in the same WASM instance', async () => {
    const expected = (await referenceTo(2 * HASH_INTERVAL)).hashes;
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
    const expected = (await referenceTo(HASH_INTERVAL)).hashes;
    const other = new Session(await createRig({}, SEED + 1)).advanceTo(HASH_INTERVAL);
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

describe('gameplay', () => {
  it('drains the upper tier over the lip and pays out mostly over the front edge', async () => {
    const { falls, upperTierPeak, rig } = await referenceTo(SESSION_TICKS);
    expect(upperTierPeak).toBeGreaterThan(80);
    expect(rig.table.coins().filter(onUpperTier).length).toBeLessThan(upperTierPeak);
    expect(falls.front).toBeGreaterThan(20);
    expect(falls.front).toBeGreaterThan(2 * (falls.left + falls.right));
  });

  it('keeps every coin inside the cabinet: none behind the backboard, over a wall or bouncing high', async () => {
    const { table } = (await referenceTo(SESSION_TICKS)).rig;
    const coins = table.coins();
    expect(coins.length).toBeGreaterThan(200);
    // The table keeps paying out, so drops continue to the end; the last second of
    // them may still be in the air.
    const landedBefore = table.nextCoinId - TICK_RATE_HZ / 6;
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

/** A coin tilted about the z axis by the angle whose half has tangent `halfTan`. */
function tiltedZ(halfTan: number): Quat {
  const norm = Math.sqrt(halfTan * halfTan + 1);
  return { x: 0, y: 0, z: halfTan / norm, w: 1 / norm };
}

interface ImpactRun {
  readonly deepest: number;
  readonly hash: string;
  readonly top: TableCoin;
  readonly bottom: TableCoin;
}

/**
 * Drops a coin from 12 cm, about 1.5 m/s on impact, onto one resting on the lower
 * tier, `offset` metres off centre and tilted so its rim strikes first, and follows
 * the pair for two seconds.
 */
async function dropOntoRestingCoin(offset: number, tilt: number): Promise<ImpactRun> {
  const rig = await createRig();
  const z = PLAYFIELD.fieldFrontZ - 0.04;
  rig.table.addCoin({ x: 0, y: COIN.halfThickness, z }, FLAT);
  runTicks(rig, TICK_RATE_HZ / 2);
  rig.table.addCoin({ x: offset, y: 0.12, z }, tiltedZ(tilt));
  let deepest = 0;
  for (let i = 0; i < 2 * TICK_RATE_HZ; i++) {
    rig.step();
    for (const { depth } of touchingPairs(rig.table.coins())) {
      deepest = Math.max(deepest, depth);
    }
  }
  const [bottom, top] = rig.table.coins();
  if (!bottom || !top) {
    throw new Error(`expected two coins on the table, found ${rig.table.coinCount}`);
  }
  return { deepest, hash: tableHash(rig), top, bottom };
}

/** The body of the coin with this id, found in the world by its pose. */
function bodyOf(rig: Rig, id: number): RigidBody {
  const coin = rig.table.coins().find((c) => c.id === id);
  if (!coin) {
    throw new Error(`coin ${id} is not on the table`);
  }
  let found: RigidBody | undefined;
  rig.world.forEachRigidBody((body) => {
    const t = body.translation();
    if (
      t.x / SCALE === coin.translation.x &&
      t.y / SCALE === coin.translation.y &&
      t.z / SCALE === coin.translation.z
    ) {
      found = body;
    }
  });
  if (!found) {
    throw new Error(`no body in the world at coin ${id}'s pose`);
  }
  return found;
}

/** Sideways speed of a coin in m/s. */
function speedX(rig: Rig, id: number): number {
  return bodyOf(rig, id).linvel().x / SCALE;
}

function launch(rig: Rig, id: number, vx: number): void {
  bodyOf(rig, id).setLinvel({ x: vx * SCALE, y: 0, z: 0 }, true);
}

interface Collision {
  readonly deepest: number;
  readonly hash: string;
  /** Sideways speeds in m/s, of the left then the right coin, before every tick. */
  readonly speeds: (readonly [number, number])[];
  readonly left: TableCoin;
  readonly right: TableCoin;
}

/**
 * Lays two coins flat on the lower tier 10 cm apart, settles them, launches them
 * sideways at `leftSpeed` and `rightSpeed` m/s and follows them for a second.
 */
async function collideFlat(leftSpeed: number, rightSpeed: number): Promise<Collision> {
  const rig = await createRig();
  const z = PLAYFIELD.fieldFrontZ - 0.04;
  const left = rig.table.addCoin({ x: -0.05, y: COIN.halfThickness, z }, FLAT);
  const right = rig.table.addCoin({ x: 0.05, y: COIN.halfThickness, z }, FLAT);
  runTicks(rig, TICK_RATE_HZ / 2);
  launch(rig, left, leftSpeed);
  launch(rig, right, rightSpeed);
  let deepest = 0;
  const speeds: (readonly [number, number])[] = [];
  for (let i = 0; i < TICK_RATE_HZ; i++) {
    speeds.push([speedX(rig, left), speedX(rig, right)]);
    rig.step();
    const [a, b] = rig.table.coins();
    if (!a || !b) {
      throw new Error(`expected two coins on the table, found ${rig.table.coinCount}`);
    }
    expect(a.translation.x).toBeLessThan(b.translation.x);
    for (const { depth } of touchingPairs([a, b])) {
      deepest = Math.max(deepest, depth);
    }
  }
  const [a, b] = rig.table.coins();
  if (!a || !b) {
    throw new Error(`expected two coins on the table, found ${rig.table.coinCount}`);
  }
  return { deepest, hash: tableHash(rig), speeds, left: a, right: b };
}

function speedsBefore(run: Collision, tick: number): readonly [number, number] {
  const speeds = run.speeds[tick];
  if (!speeds) {
    throw new Error(`no speeds recorded before tick ${tick} of ${run.speeds.length}`);
  }
  return speeds;
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

  it('measures the rounded rim: coins meeting corner to corner touch where sharp ones would overlap', () => {
    const a = flatCoinAt(0, 0);
    // The second coin sits up and to the side so the two rims meet on a 45 degree
    // diagonal, `gap` apart. Sharp corners would already overlap by (2 - sqrt 2)
    // rim radii there, 0.29 mm.
    const placed = (gap: number): TableCoin => {
      const along = (2 * RIM + gap) / Math.SQRT2;
      const x = 2 * (COIN.radius - RIM) + along;
      const y = COIN.halfThickness + 2 * (COIN.halfThickness - RIM) + along;
      return { ...flatCoinAt(1, x), translation: { x, y, z: 0 } };
    };
    expect(penetrationDepth(a, placed(0.00005))).toBe(0);
    expect(penetrationDepth(a, placed(-0.0002))).toBeCloseTo(0.0002, 5);
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

  it('lands a fast coin striking another rim first without sinking into it, the same way every run', async () => {
    const cases = [
      [0, 0.3],
      [0.008, 0.5],
      [0.016, -0.4],
      [0.024, 0.2],
    ] as const;
    for (const [offset, tilt] of cases) {
      const run = await dropOntoRestingCoin(offset, tilt);
      expect(run.deepest).toBeLessThan(OVERLAP_TOLERANCE);
      expect(run.top.translation.y).toBeLessThan(run.bottom.translation.y + 3 * COIN.halfThickness);
      expect((await dropOntoRestingCoin(offset, tilt)).hash).toBe(run.hash);
    }
  });

  it('hands a coin sliding fast along the floor into a resting one its momentum, without sinking into it', async () => {
    const run = await collideFlat(1.5, 0);
    // The striker's first hit along its path is the floor it slides on, which is not
    // closing; the brake has to look past it to find the coin ahead.
    expect(run.deepest).toBeLessThan(OVERLAP_TOLERANCE);
    const struck = run.speeds.findIndex(([, right]) => right > 0.5);
    expect(struck).toBeGreaterThan(0);
    const [before] = speedsBefore(run, struck - 1);
    const [left, right] = speedsBefore(run, struck);
    expect(before).toBeGreaterThan(1.2);
    // Floor friction takes about 0.06 m/s a tick from each coin.
    expect(left + right).toBeGreaterThan(0.85 * before);
    expect(left + right).toBeLessThan(before);
    expect(right).toBeGreaterThan(0.4 * before);
    expect(run.right.translation.x).toBeGreaterThan(0.06);
    expect((await collideFlat(1.5, 0)).hash).toBe(run.hash);
  });

  it('stops two fast coins sliding into each other rim to rim without either passing through', async () => {
    const run = await collideFlat(2.5, -2.5);
    expect(run.deepest).toBeLessThan(OVERLAP_TOLERANCE);
    const met = run.speeds.findIndex(([left]) => left < 1);
    expect(met).toBeGreaterThan(0);
    const [left, right] = speedsBefore(run, met);
    expect(Math.abs(left + right)).toBeLessThan(0.1);
    for (const coin of [run.left, run.right]) {
      expect(coin.translation.y).toBeLessThan(3 * COIN.halfThickness + 0.001);
    }
    expect((await collideFlat(2.5, -2.5)).hash).toBe(run.hash);
  });

  it('keeps coins in the full, moving pile from sinking into each other, checked every tick', async () => {
    const overlaps = (await referenceTo(SESSION_TICKS)).overlaps;
    // Every pair on every tick of the minute, over 380 touching pairs a tick once the
    // table is full. The 12 cm stroke pushes more coins over the lip than the 8 cm one
    // did, so the script levels off near 190 coins rather than more, and the pile holds
    // fewer pairs than the 400 it used to; but at over two touching pairs per coin every
    // coin still rests against its neighbours. Measured over this seed and EXTRA_SEEDS:
    // 0.29 mm deepest, 393 to 444 pairs and 188 to 198 coins fewest.
    expect(overlaps.ticks).toBe(SESSION_TICKS);
    expect(overlaps.fewestCoinsOnFullTable).toBeGreaterThan(180);
    expect(overlaps.fewestNearOnFullTable).toBeGreaterThan(380);
    expect(overlaps.fewestNearOnFullTable / overlaps.fewestCoinsOnFullTable).toBeGreaterThan(2);
    expect(overlaps.deepest).toBeLessThan(OVERLAP_TOLERANCE);
  });

  it('clears every pair within its passes on every tick of the minute', async () => {
    const session = await referenceTo(SESSION_TICKS);
    expect(session.unconverged).toEqual([]);
    expect(session.mostSeparationPasses).toBeLessThan(TABLE_SOLVER.separationPasses);
  });

  describe.each(EXTRA_SEEDS)('on seed %i', (seed) => {
    let session: Promise<Session> | undefined;
    const sessionTo = async (ticks: number): Promise<Session> => {
      session ??= buildRig({}, seed).then((rig) => new Session(rig, new OverlapLog()));
      return (await session).advanceTo(ticks);
    };
    afterAll(async () => {
      (await session)?.rig.world.free();
    });

    // The minute is played across one test per checkpoint, like the scripted one, so
    // no single test risks the timeout.
    it.each(CHECKPOINT_TICKS)(
      'keeps every pair apart and the separation converged up to tick %i',
      async (tick) => {
        const { overlaps, unconverged } = await sessionTo(tick);
        expect(overlaps.ticks).toBe(tick);
        expect(unconverged).toEqual([]);
        expect(overlaps.deepest).toBeLessThan(OVERLAP_TOLERANCE);
        if (tick > FULL_TABLE_TICKS) {
          expect(overlaps.fewestCoinsOnFullTable).toBeGreaterThan(180);
          expect(overlaps.fewestNearOnFullTable).toBeGreaterThan(380);
          expect(overlaps.fewestNearOnFullTable / overlaps.fewestCoinsOnFullTable).toBeGreaterThan(
            2,
          );
        }
      },
    );
  });
});
