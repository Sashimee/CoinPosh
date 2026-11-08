import type { World } from '@dimforge/rapier3d-deterministic-compat';
import { afterEach, describe, expect, it } from 'vitest';
import { COIN } from '../coin.ts';
import { GRAVITY, TICK_RATE_HZ } from '../constants.ts';
import { StateHasher } from '../hash.ts';
import { Xoshiro128ss } from '../prng.ts';
import { loadRapier } from '../rapier.ts';
import { FUSION_TUNING } from '../mechanics/tuning.ts';
import { HEAP_TUNING, type HeapGeometry, heapCapacity, heapPoses } from './heap.ts';
import { BACKBOARD, PLAYFIELD, PUSHER } from './layout.ts';
import { type FallEvent, PusherTable } from './table.ts';
import { configureTableWorld } from './tuning.ts';

const GEOMETRY: HeapGeometry = {
  upperLipZ: PUSHER.frontZ,
  reachZ: PUSHER.frontZ + PUSHER.stroke,
  upperY: PUSHER.height,
};
const SEED = 0x4ea9;

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

  it('lays the lower sheet first, front row overhanging the lip with its centre on the wood', () => {
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
    const poses = heapPoses(capacity, GEOMETRY, Xoshiro128ss.fromSeed(SEED));
    const minGap = HEAP_TUNING.gap - 2 * Math.SQRT2 * HEAP_TUNING.jitter;
    for (const [i, a] of poses.entries()) {
      const { x, y, z } = a.translation;
      expect(Math.abs(x) + COIN.radius).toBeLessThan(PLAYFIELD.fieldHalfWidth);
      expect(z - COIN.radius).toBeGreaterThan(BACKBOARD.frontZ);
      expect(Math.abs(a.rotation.y * a.rotation.y + a.rotation.w * a.rotation.w - 1)).toBeLessThan(
        1e-12,
      );
      for (const b of poses.slice(i + 1)) {
        if (b.translation.y !== y) {
          continue;
        }
        const dx = b.translation.x - x;
        const dz = b.translation.z - z;
        expect(Math.sqrt(dx * dx + dz * dz)).toBeGreaterThan(2 * COIN.radius + minGap);
      }
    }
  });

  it("keeps neighbours in a layer outside Contact Fusion's touch gap, however they are jittered", () => {
    expect(HEAP_TUNING.gap - 2 * Math.SQRT2 * HEAP_TUNING.jitter).toBeGreaterThan(
      FUSION_TUNING.touchGap,
    );
  });

  it("lays only the two tiers' first layer without the second layer", () => {
    const single = { ...GEOMETRY, secondLayer: false };
    const poses = heapPoses(heapCapacity(single), single, Xoshiro128ss.fromSeed(SEED));
    const heights = new Set(poses.map((p) => p.translation.y));
    expect(heights.size).toBe(2);
    expect(Math.max(...heights) - Math.min(...heights)).toBeCloseTo(PUSHER.height, 9);
    expect(poses.length).toBeLessThan(capacity);
    expect(heapPoses(poses.length, GEOMETRY, Xoshiro128ss.fromSeed(SEED))).toEqual(poses);
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

  it('stands on its own, then a single centre drop tips coins over the front within 10 s', async () => {
    const { table, rng } = await createTable();
    const ids = table.placeHeap(heapCapacity(GEOMETRY), rng);
    expect(ids).toEqual(ids.map((_, i) => i));
    const idle = run(table, 0, 10 * TICK_RATE_HZ);
    expect(idle).toEqual([]);
    expect(table.coinCount).toBe(ids.length);
    table.dropCoin(0, rng);
    const falls = run(table, 10 * TICK_RATE_HZ, 10 * TICK_RATE_HZ);
    expect(falls.length).toBeGreaterThan(0);
    expect(falls.every((fall) => fall.edge === 'front')).toBe(true);
  });

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
    expect(hash).toMatchInlineSnapshot(`"0fc753f7a3ec127f"`);
  });
});
