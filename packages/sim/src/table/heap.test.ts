import type { Vector, World } from '@dimforge/rapier3d-deterministic-compat';
import { economyConfig, openingHeap } from '@coinposh/economy';
import { COIN_TIERS } from '@coinposh/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { COIN } from '../coin.ts';
import { GRAVITY, TICK_RATE_HZ } from '../constants.ts';
import { StateHasher } from '../hash.ts';
import { Xoshiro128ss } from '../prng.ts';
import { loadRapier } from '../rapier.ts';
import { FUSION_TUNING } from '../mechanics/tuning.ts';
import type { MechanicsConfig } from '../mechanics/index.ts';
import { type CoinState, Sim } from '../sim.ts';
import { HEAP_TUNING, type HeapGeometry, type HeapPose, heapCapacity, heapPoses } from './heap.ts';
import { BACKBOARD, PLAYFIELD, PUSHER } from './layout.ts';
import { type FallEvent, PusherTable } from './table.ts';
import { configureTableWorld } from './tuning.ts';

const GEOMETRY: HeapGeometry = {
  upperLipZ: PUSHER.frontZ,
  reachZ: PUSHER.frontZ + PUSHER.stroke,
  upperY: PUSHER.height,
};
const SEED = 0x4ea9;
/** The Demo table's seed (apps/web main.ts TABLE_SEED), then more tables. */
const SEEDS = [0xc0196051, SEED, 1, 2, 3, 4, 5, 6, 7, 8];
/**
 * The Riviera camera's pitch below the horizontal on a 390 × 844 portrait phone and on a
 * landscape one (apps/web/src/scene/venues/riviera/layout.ts): 45° and 38°, as sin and
 * cos written out.
 */
const PITCHES = [
  { name: 'portrait 390 × 844', sin: Math.SQRT1_2, cos: Math.SQRT1_2 },
  { name: 'landscape', sin: 0.6156614753256583, cos: 0.7880107536067219 },
];

/** The sim worker's mechanics (apps/web simWorker/table-config.ts): fusion on, no tower. */
const DEMO_MECHANICS: MechanicsConfig<string> = {
  tiers: COIN_TIERS,
  fusion: {
    inputCount: economyConfig.fusion.inputCount,
    contactSeconds: economyConfig.fusion.contactSeconds,
  },
  tower: null,
};

const live: World[] = [];

afterEach(() => {
  for (const world of live.splice(0)) {
    world.free();
  }
});

async function createTable(): Promise<{ table: PusherTable; rng: Xoshiro128ss; world: World }> {
  const rapier = await loadRapier();
  const world = new rapier.World(GRAVITY);
  live.push(world);
  configureTableWorld(world);
  return { table: new PusherTable(rapier, world), rng: Xoshiro128ss.fromSeed(SEED), world };
}

/**
 * Every four coins, as a camera at `pitch` sees them orthographically, that read as a
 * ruled row: the middle two within `tolerance` of the points a third and two thirds of
 * the way between the outer two, which lie R to 3R apart per step. Brute force over all
 * pairs of outer coins.
 */
function ruledRows(
  poses: readonly HeapPose[],
  pitch: { sin: number; cos: number },
  tolerance: number,
): number[][] {
  const seen = poses.map(({ translation: t }: { translation: Vector }) => ({
    h: t.x,
    v: t.y * pitch.cos - t.z * pitch.sin,
  }));
  const near = (h: number, v: number, not: number[]): number[] =>
    seen.flatMap((p, i) =>
      !not.includes(i) && (p.h - h) * (p.h - h) + (p.v - v) * (p.v - v) <= tolerance * tolerance
        ? [i]
        : [],
    );
  const rows: number[][] = [];
  for (let a = 0; a < seen.length; a++) {
    for (let d = a + 1; d < seen.length; d++) {
      const pa = seen[a];
      const pd = seen[d];
      if (!pa || !pd) {
        continue;
      }
      const dh = pd.h - pa.h;
      const dv = pd.v - pa.v;
      const step = Math.sqrt(dh * dh + dv * dv) / 3;
      if (step < COIN.radius || step > 3 * COIN.radius) {
        continue;
      }
      const at = (k: number) => [pa.h + ((pd.h - pa.h) * k) / 3, pa.v + ((pd.v - pa.v) * k) / 3];
      const [h1 = 0, v1 = 0] = at(1);
      const [h2 = 0, v2 = 0] = at(2);
      for (const b of near(h1, v1, [a, d])) {
        for (const c of near(h2, v2, [a, d, b])) {
          rows.push([a, b, c, d]);
        }
      }
    }
  }
  return rows;
}

function run(table: PusherTable, from: number, ticks: number): FallEvent[] {
  const falls: FallEvent[] = [];
  for (let tick = from + 1; tick <= from + ticks; tick++) {
    falls.push(...table.step(tick));
  }
  return falls;
}

describe('opening heap layout', () => {
  const capacity = heapCapacity(GEOMETRY);

  it('holds both tiers and a second layer on the default table', () => {
    expect(capacity).toBeGreaterThan(100);
    expect(capacity).toBeLessThan(250);
  });

  it('lays the lower sheet first, its front coins overhanging the lip with their centres on the wood', () => {
    const poses = heapPoses(capacity, GEOMETRY, Xoshiro128ss.fromSeed(SEED));
    const lower = poses.filter((p) => p.translation.y < PUSHER.height);
    const firstUpper = poses.findIndex((p) => p.translation.y > PUSHER.height);
    expect(firstUpper).toBeGreaterThan(0);
    expect(poses.slice(0, firstUpper).every((p) => p.translation.y < PUSHER.height)).toBe(true);
    const front = Math.max(...lower.map((p) => p.translation.z));
    expect(front).toBeLessThan(PLAYFIELD.fieldFrontZ);
    expect(front + COIN.radius).toBeGreaterThan(PLAYFIELD.fieldFrontZ);
    const back = Math.min(...lower.map((p) => p.translation.z - COIN.radius));
    expect(back).toBeGreaterThan(GEOMETRY.reachZ + HEAP_TUNING.reachClearance - 0.001);
  });

  it('keeps every coin on the floor, ahead of the backboard, and apart from its layer', () => {
    for (const seed of SEEDS) {
      const poses = heapPoses(capacity, GEOMETRY, Xoshiro128ss.fromSeed(seed));
      for (const [i, a] of poses.entries()) {
        const { x, y, z } = a.translation;
        expect(Math.abs(x) + COIN.radius).toBeLessThan(PLAYFIELD.fieldHalfWidth);
        expect(z - COIN.radius).toBeGreaterThan(BACKBOARD.frontZ);
        expect(
          Math.abs(a.rotation.y * a.rotation.y + a.rotation.w * a.rotation.w - 1),
        ).toBeLessThan(1e-12);
        for (const b of poses.slice(i + 1)) {
          if (b.translation.y !== y) {
            continue;
          }
          const dx = b.translation.x - x;
          const dz = b.translation.z - z;
          expect(Math.sqrt(dx * dx + dz * dz)).toBeGreaterThanOrEqual(
            2 * COIN.radius + HEAP_TUNING.minGap - 1e-9,
          );
        }
      }
    }
  });

  it("keeps neighbours in a layer outside Contact Fusion's touch gap", () => {
    expect(HEAP_TUNING.minGap).toBeGreaterThan(FUSION_TUNING.touchGap);
  });

  it.each(PITCHES)('lays no four coins in a ruled row as a $name phone sees them', (pitch) => {
    for (const seed of SEEDS) {
      const poses = heapPoses(openingHeap.coins, GEOMETRY, Xoshiro128ss.fromSeed(seed));
      expect(ruledRows(poses, pitch, 0.001), `seed ${seed}`).toEqual([]);
    }
  });

  it('finds the ruled rows of a tiled heap, so the check above can fail', () => {
    const tiled: HeapPose[] = Array.from({ length: 8 }, (_, k) => ({
      translation: { x: -0.1 + k * 0.0285, y: 0.0016, z: 0.045 + (k % 2) * 0.0003 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    }));
    expect(ruledRows(tiled, PITCHES[0] ?? { sin: 1, cos: 0 }, 0.001)).toHaveLength(5);
  });

  /**
   * Upper-tier stacks nest evenly over its sheet instead: the block shakes them at every
   * stroke, and where they lie decides where a dropped coin lands.
   */
  it('piles coins several layers high on both tiers, most of the lower pile at the front', () => {
    const piledOn = (poses: readonly HeapPose[], floor: number, back: number, lip: number) =>
      poses.filter(
        ({ translation: t }) =>
          t.y > floor + 2 * COIN.halfThickness &&
          t.y < floor + PUSHER.height &&
          t.z > back &&
          t.z < lip,
      );
    for (const seed of SEEDS) {
      const poses = heapPoses(openingHeap.coins, GEOMETRY, Xoshiro128ss.fromSeed(seed));
      expect(new Set(poses.map((p) => p.translation.y)).size, `seed ${seed}`).toBeGreaterThan(4);
      const lower = piledOn(poses, 0, GEOMETRY.reachZ, PLAYFIELD.fieldFrontZ);
      const middle = (GEOMETRY.reachZ + PLAYFIELD.fieldFrontZ) / 2;
      const front = lower.filter(({ translation: t }) => t.z > middle).length;
      expect(front, `seed ${seed}`).toBeGreaterThan(lower.length - front);
      const upper = piledOn(poses, GEOMETRY.upperY, BACKBOARD.frontZ, GEOMETRY.upperLipZ);
      expect(upper.length, `seed ${seed}`).toBeGreaterThan(0);
    }
  });

  it('lays a heap of n coins as the first n of a bigger one', () => {
    const full = heapPoses(capacity, GEOMETRY, Xoshiro128ss.fromSeed(SEED));
    for (const n of [1, 23, openingHeap.coins, capacity - 1]) {
      expect(heapPoses(n, GEOMETRY, Xoshiro128ss.fromSeed(SEED))).toEqual(full.slice(0, n));
    }
  });

  it('leaves the keep-clear spots bare', () => {
    const spot = { x: 0.1, z: -0.17, radius: 0.016 };
    const poses = heapPoses(
      heapCapacity({ ...GEOMETRY, keepClear: [spot] }),
      { ...GEOMETRY, keepClear: [spot] },
      Xoshiro128ss.fromSeed(SEED),
    );
    expect(heapCapacity({ ...GEOMETRY, keepClear: [spot] })).toBeLessThan(capacity);
    for (const { translation } of poses) {
      const dx = translation.x - spot.x;
      const dz = translation.z - spot.z;
      expect(Math.sqrt(dx * dx + dz * dz)).toBeGreaterThan(spot.radius + COIN.radius);
    }
  });

  it('draws the same poses from the same seed and different ones from another', () => {
    const a = heapPoses(40, GEOMETRY, Xoshiro128ss.fromSeed(SEED));
    expect(heapPoses(40, GEOMETRY, Xoshiro128ss.fromSeed(SEED))).toEqual(a);
    expect(heapPoses(40, GEOMETRY, Xoshiro128ss.fromSeed(SEED + 1))).not.toEqual(a);
    expect(heapPoses(0, GEOMETRY, Xoshiro128ss.fromSeed(SEED))).toEqual([]);
  });

  it('rejects a count the heap cannot hold', () => {
    const rng = Xoshiro128ss.fromSeed(SEED);
    for (const count of [-1, 2.5, Number.NaN, capacity + 1]) {
      expect(() => heapPoses(count, GEOMETRY, rng)).toThrow(
        `Opening heap: count must be an integer in [0, ${capacity}], got ${count}`,
      );
    }
  });
});

describe('opening heap on the table', () => {
  it('places nothing when asked for more than the heap holds', async () => {
    const { table, rng } = await createTable();
    expect(() => table.placeHeap(heapCapacity(GEOMETRY) + 1, rng)).toThrow(RangeError);
    expect(table.coinCount).toBe(0);
  });

  it('stands on its own, then three drops across the chute tip coins over the front within 10 s', async () => {
    const { table, rng } = await createTable();
    const ids = table.placeHeap(heapCapacity(GEOMETRY), rng);
    expect(ids).toEqual(ids.map((_, i) => i));
    const idle = run(table, 0, 10 * TICK_RATE_HZ);
    expect(idle).toEqual([]);
    expect(table.coinCount).toBe(ids.length);
    const falls: FallEvent[] = [];
    for (const [i, x] of [-0.06, 0, 0.06].entries()) {
      table.dropCoin(x, rng);
      falls.push(...run(table, (10 + 2 * i) * TICK_RATE_HZ, 2 * TICK_RATE_HZ));
    }
    falls.push(...run(table, 16 * TICK_RATE_HZ, 4 * TICK_RATE_HZ));
    expect(falls.length).toBeGreaterThan(0);
    expect(falls.every((fall) => fall.edge === 'front')).toBe(true);
  });

  it.each(SEEDS)(
    'opens on seed %i with at least 5 coins over the front lip that hold for 2 s',
    async (seed) => {
      const sim = await Sim.create({ seed, mechanics: DEMO_MECHANICS, openingHeap });
      try {
        const overhanging = (coins: readonly CoinState[]): number[] =>
          coins
            .filter(
              ({ translation: t }) =>
                t.y < PUSHER.height &&
                t.z < PLAYFIELD.fieldFrontZ &&
                t.z + COIN.radius > PLAYFIELD.fieldFrontZ,
            )
            .map(({ id }) => id);
        const first = overhanging(sim.coins());
        expect(first.length).toBeGreaterThanOrEqual(5);
        const falls: FallEvent[] = [];
        while (sim.tick < 2 * TICK_RATE_HZ) {
          falls.push(...sim.step().falls);
        }
        expect(falls).toEqual([]);
        expect(overhanging(sim.coins())).toEqual(expect.arrayContaining(first));
      } finally {
        sim.dispose();
      }
    },
  );

  it('plays out identically from the same seed, and pins the hash', async () => {
    const play = async (): Promise<string> => {
      const { table, rng } = await createTable();
      table.placeHeap(heapCapacity(GEOMETRY), rng);
      run(table, 0, 3 * TICK_RATE_HZ);
      return table.hashInto(new StateHasher()).digest();
    };
    const hash = await play();
    expect(await play()).toBe(hash);
    // Changing this value breaks replay audits of input logs that open with a heap.
    expect(hash).toMatchInlineSnapshot(`"7ddf8b6ce2e04656"`);
  });
});
