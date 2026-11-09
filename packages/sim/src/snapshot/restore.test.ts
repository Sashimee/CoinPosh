import { afterEach, describe, expect, it } from 'vitest';
import { COIN } from '../coin.ts';
import { SIM_VERSION } from '../constants.ts';
import type { SimInput } from '../inputs.ts';
import type { MechanicsConfig } from '../mechanics/index.ts';
import { type RestoreEntry, Sim, type SimOptions } from '../sim.ts';
import { PUSHER } from '../table/index.ts';
import settledTable from './fixtures/settled-table.json' with { type: 'json' };
import { type CoinPose, type SimTableSnapshot, SIM_SNAPSHOT_VERSION } from './snapshot.ts';
import { validateSnapshot } from './validate.ts';

const SEED = 0xc0195051;

/** What apps/web's sim worker runs (SIM_MECHANICS there): tiers, no fusion, no tower. */
const WORKER_MECHANICS: MechanicsConfig<string> = {
  tiers: ['copper', 'silver', 'gold', 'platinum', 'diamond', 'heirloom'],
  fusion: null,
  tower: null,
};

const FUSING_MECHANICS: MechanicsConfig<string> = {
  tiers: ['copper', 'silver', 'gold'],
  fusion: { inputCount: 3, contactSeconds: 0.4 },
  tower: null,
};

/** A drop every 12 ticks, wandering across the middle 80 mm of the table. */
function steadyDrops(tick: number): SimInput[] {
  return tick % 12 === 0 ? [{ kind: 'dropCoin', xMm: ((tick * 13) % 81) - 40 }] : [];
}

function parsePose(coin: (typeof settledTable.coins)[number]): CoinPose {
  const [px, py, pz] = coin.p;
  const [qx, qy, qz, qw] = coin.q;
  if (
    px === undefined ||
    py === undefined ||
    pz === undefined ||
    qx === undefined ||
    qy === undefined ||
    qz === undefined ||
    qw === undefined ||
    (coin.rest !== 'asleep' && coin.rest !== 'awake')
  ) {
    throw new Error(`settled-table.json: coin ${coin.id} is malformed; regenerate the fixture`);
  }
  return { id: coin.id, p: [px, py, pz], q: [qx, qy, qz, qw], rest: coin.rest };
}

/**
 * The scripted Demo table settled: the worker's 110-coin heap, 10 s of steadyDrops,
 * 10 s idle, then on to tick 180 of the pusher cycle, snapshotted with SIM_VERSION 7.
 */
const SETTLED: SimTableSnapshot = {
  version: SIM_SNAPSHOT_VERSION,
  pusherTickInCycle: settledTable.pusherTickInCycle,
  coins: settledTable.coins.map(parsePose),
};

const live: Sim[] = [];

afterEach(() => {
  for (const sim of live.splice(0)) {
    sim.dispose();
  }
});

async function create(options: SimOptions): Promise<Sim> {
  const sim = await Sim.create(options);
  live.push(sim);
  return sim;
}

function asEntries(snapshot: SimTableSnapshot): RestoreEntry[] {
  return snapshot.coins.map((pose) => ({ kind: 'pose', pose }));
}

function restore(snapshot: SimTableSnapshot): Promise<Sim> {
  return create({
    seed: SEED,
    mechanics: WORKER_MECHANICS,
    restore: { pusherTickInCycle: snapshot.pusherTickInCycle, coins: asEntries(snapshot) },
  });
}

function heapSlots(count: number): RestoreEntry[] {
  return Array.from({ length: count }, (_, slot) => ({ kind: 'heapSlot', slot }));
}

function norm(...components: number[]): number {
  return Math.sqrt(components.reduce((sum, c) => sum + c * c, 0));
}

/** Steps `ticks` ticks of `inputsAt` and returns the hash every `every` ticks. */
function play(
  sim: Sim,
  ticks: number,
  every: number,
  inputsAt: (tick: number) => SimInput[] = () => [],
): string[] {
  const hashes: string[] = [];
  for (let i = 1; i <= ticks; i++) {
    sim.step(inputsAt(sim.tick));
    if (i % every === 0) {
      hashes.push(sim.hash());
    }
  }
  return hashes;
}

describe('Sim.snapshot', () => {
  it('quantizes the table: whole 10 µm units, canonical int16 rotations, rest states, the pusher tick', async () => {
    const sim = await create({
      seed: SEED,
      mechanics: WORKER_MECHANICS,
      openingHeap: { coins: 110 },
    });
    play(sim, 300, 300, steadyDrops);
    const snapshot = sim.snapshot();
    const coins = sim.coins();
    expect(snapshot.version).toBe(SIM_SNAPSHOT_VERSION);
    expect(snapshot.pusherTickInCycle).toBe(300 % PUSHER.periodTicks);
    expect(snapshot.coins.map((pose) => pose.id)).toEqual(coins.map((coin) => coin.id));
    snapshot.coins.forEach((pose, i) => {
      const coin = coins[i];
      if (!coin) {
        throw new Error(`coin ${pose.id} is missing`);
      }
      const t = coin.translation;
      [t.x, t.y, t.z].forEach((v, k) => {
        expect(Math.abs((pose.p[k] ?? Number.NaN) * 1e-5 - v)).toBeLessThanOrEqual(5e-6 + 1e-12);
      });
      const [x, y, z, w] = pose.q;
      expect(w).toBeGreaterThanOrEqual(0);
      expect(Math.abs(norm(x, y, z, w) / 32767 - 1)).toBeLessThan(1e-3);
      expect(pose.rest).toBe(coin.sleeping ? 'asleep' : 'awake');
    });
    expect(snapshot.coins.some((pose) => pose.rest === 'asleep')).toBe(true);
    expect(snapshot.coins.some((pose) => pose.rest === 'awake')).toBe(true);
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(validateSnapshot(snapshot).dropped).toEqual([]);
  });
});

describe('Sim.create({ restore })', () => {
  it('replays a restored table bit for bit for a minute, from the snapshot or its JSON', async () => {
    const source = await create({
      seed: SEED,
      mechanics: WORKER_MECHANICS,
      openingHeap: { coins: 110 },
    });
    play(source, 600, 600, steadyDrops);
    const snapshot = source.snapshot();
    const parsed = JSON.parse(JSON.stringify(snapshot)) as SimTableSnapshot;
    const a = await restore(snapshot);
    const b = await restore(parsed);
    expect(a.tick).toBe(0);
    expect(a.coinCount).toBe(snapshot.coins.length);
    expect(b.hash()).toBe(a.hash());
    expect(b.snapshot()).toEqual(a.snapshot());
    const expected = play(a, 3600, 600, steadyDrops);
    expect(play(b, 3600, 600, steadyDrops)).toEqual(expected);
    expect(new Set(expected).size).toBe(expected.length);
  });

  it('pins the hash of the settled fixture restored, so restore changes are caught', async () => {
    expect(SIM_VERSION).toBe(7);
    expect(validateSnapshot(SETTLED).dropped).toEqual([]);
    const sim = await restore(SETTLED);
    expect(sim.hash()).toMatchInlineSnapshot(`"bb870ee1fb671645"`);
    const [atSecond] = play(sim, 60, 60, steadyDrops);
    expect(atSecond).toMatchInlineSnapshot(`"c01adfd9be924908"`);
    const [atMinute] = play(sim, 3540, 3540, steadyDrops);
    expect(atMinute).toMatchInlineSnapshot(`"c2fef5284a571c67"`);
  });

  it('restores the settled fixture so a coin at rest snapshots back to exactly its pose', async () => {
    const sim = await restore(SETTLED);
    const again = sim.snapshot();
    expect(again.pusherTickInCycle).toBe(SETTLED.pusherTickInCycle);
    const asleep = SETTLED.coins.filter((pose) => pose.rest === 'asleep');
    expect(asleep.length).toBeGreaterThan(SETTLED.coins.length / 2);
    SETTLED.coins.forEach((pose, i) => {
      if (pose.rest === 'asleep') {
        expect(again.coins[i], `coin ${pose.id}`).toEqual({ ...pose, id: i });
      }
    });
  });

  /**
   * The design's restore stability property (92-table-persistence 1.4), measured against
   * the table the snapshot was taken from, played on beside it. A working table never
   * lies wholly still: each turn of the block wakes part of the pile, which then moves
   * there too, and moving piles part ways by chaos alone. So a coin asleep throughout on
   * the table played on must stay within 1 mm of it on the restored one, and the rest
   * within 5 mm; so must a coin touching one that restores awake, which restores without
   * the velocity it had, as the design asks, and settles from rest instead.
   */
  it.each([0, 60, 120, 180])(
    'restores a table with the pusher at tick %i of its cycle so that over 2 s nothing falls and still coins end within 1 mm of the table played on',
    async (tickInCycle) => {
      const table = await restore(SETTLED);
      while (table.snapshot().pusherTickInCycle !== tickInCycle || table.tick === 0) {
        table.step();
      }
      const snapshot = table.snapshot();
      const sim = await restore(snapshot);
      const awake = sim.coins().filter((_, i) => snapshot.coins[i]?.rest === 'awake');
      const touch = 2 * COIN.radius + 0.001;
      const stirred = new Set<number>();
      for (let tick = 0; tick < 120; tick++) {
        expect(sim.step().falls, `restored, tick ${sim.tick}`).toEqual([]);
        expect(table.step().falls, `played on, tick ${table.tick}`).toEqual([]);
        for (const coin of table.coins()) {
          if (!coin.sleeping) {
            stirred.add(coin.id);
          }
        }
      }
      const there = new Map(table.coins().map((coin) => [coin.id, coin.translation]));
      let still = 0;
      sim.coins().forEach((coin, i) => {
        const pose = snapshot.coins[i];
        if (pose?.rest !== 'asleep') {
          return;
        }
        const t = there.get(pose.id);
        if (!t) {
          throw new Error(`coin ${pose.id} left the table played on`);
        }
        const [px = 0, py = 0, pz = 0] = pose.p.map((v) => v * 1e-5);
        const touched = awake.some(
          ({ translation: a }) => norm(a.x - px, a.y - py, a.z - pz) < touch,
        );
        const strict = !touched && !stirred.has(pose.id);
        still += strict ? 1 : 0;
        const { x, y, z } = coin.translation;
        expect(
          norm(x - t.x, y - t.y, z - t.z),
          `coin ${i}${touched ? ', touching an awake coin' : ''}${stirred.has(pose.id) ? ', woken on the table played on' : ''}`,
        ).toBeLessThan(strict ? 0.001 : 0.005);
      });
      expect(still).toBeGreaterThan(snapshot.coins.length / 4);
    },
  );

  it.each<[string, MechanicsConfig<string> | undefined]>([
    ['no mechanics', undefined],
    ["the worker's mechanics", WORKER_MECHANICS],
    ['fusion', FUSING_MECHANICS],
  ])(
    'lays the same table as openingHeap from every heap slot in order, with %s',
    async (_, mechanics) => {
      const coins = Sim.heapCapacity(mechanics);
      const options = { seed: SEED, ...(mechanics ? { mechanics } : {}) };
      const heap = await create({ ...options, openingHeap: { coins } });
      const slots = await create({
        ...options,
        restore: { pusherTickInCycle: 0, coins: heapSlots(coins) },
      });
      expect(slots.hash()).toBe(heap.hash());
      expect(slots.snapshot()).toEqual(heap.snapshot());
      expect(play(slots, 600, 300, steadyDrops)).toEqual(play(heap, 600, 300, steadyDrops));
    },
  );

  it('gives restored coins the tier each entry asks for, the lowest by default', async () => {
    const [first, second] = SETTLED.coins;
    if (!first || !second) {
      throw new Error('the fixture is empty');
    }
    const sim = await create({
      seed: SEED,
      mechanics: WORKER_MECHANICS,
      restore: {
        pusherTickInCycle: SETTLED.pusherTickInCycle,
        coins: [
          { kind: 'pose', pose: first, tier: 'gold' },
          { kind: 'pose', pose: second },
          { kind: 'heapSlot', slot: 0, tier: 'diamond' },
        ],
      },
    });
    expect(sim.coins().map((coin) => coin.tier)).toEqual(['gold', 'copper', 'diamond']);
    const heap = await create({
      seed: SEED,
      mechanics: WORKER_MECHANICS,
      openingHeap: { coins: 3, tier: 'silver' },
    });
    const slots = await create({
      seed: SEED,
      mechanics: WORKER_MECHANICS,
      restore: {
        pusherTickInCycle: 0,
        coins: heapSlots(3).map((entry) => ({ ...entry, tier: 'silver' })),
      },
    });
    expect(slots.hash()).toBe(heap.hash());
  });

  it('restores a mix of poses and heap slots deterministically, lifting the slots poses cover', async () => {
    const lower = SETTLED.coins.filter((pose) => pose.p[1] * 1e-5 < PUSHER.height);
    const entries: RestoreEntry[] = [
      ...lower.map((pose): RestoreEntry => ({ kind: 'pose', pose })),
      ...heapSlots(40),
    ];
    const restoreMix = (): Promise<Sim> =>
      create({
        seed: SEED,
        mechanics: WORKER_MECHANICS,
        restore: { pusherTickInCycle: SETTLED.pusherTickInCycle, coins: entries },
      });
    const a = await restoreMix();
    const b = await restoreMix();
    expect(a.coinCount).toBe(entries.length);
    expect(b.hash()).toBe(a.hash());
    const heap = await create({
      seed: SEED,
      mechanics: WORKER_MECHANICS,
      openingHeap: { coins: 40 },
    });
    const laid = heap.coins();
    const slots = a.coins().slice(lower.length);
    const lifted = slots.filter(
      (coin, slot) => coin.translation.y > (laid[slot]?.translation.y ?? Infinity) + 1e-6,
    );
    expect(lifted.length).toBeGreaterThan(0);
    for (const coin of slots) {
      expect(coin.sleeping, `heap slot coin ${coin.id}`).toBe(false);
    }
    expect(play(b, 600, 300, steadyDrops)).toEqual(play(a, 600, 300, steadyDrops));
  });

  it('lifts a heap slot clear of the pose lying in it and lets it settle within 2 s', async () => {
    const heap = await create({ seed: SEED, openingHeap: { coins: 1 } });
    const [slotPose] = heap.snapshot().coins;
    if (!slotPose) {
      throw new Error('the heap laid no coin');
    }
    const sim = await create({
      seed: SEED,
      restore: {
        pusherTickInCycle: 0,
        coins: [
          { kind: 'pose', pose: { ...slotPose, rest: 'asleep' } },
          { kind: 'heapSlot', slot: 0 },
        ],
      },
    });
    const [under, over] = sim.coins();
    if (!under || !over) {
      throw new Error('the restore laid too few coins');
    }
    expect(over.translation.y).toBeGreaterThan(under.translation.y + 0.002);
    expect(over.sleeping).toBe(false);
    let settledAt = -1;
    for (let tick = 0; tick < 120; tick++) {
      expect(sim.step().falls).toEqual([]);
      if (settledAt < 0 && sim.coins()[1]?.sleeping) {
        settledAt = sim.tick;
      }
    }
    expect(settledAt, 'the lifted coin is still moving after 120 ticks').toBeGreaterThan(0);
    expect(sim.coinCount).toBe(2);
    expect(sim.snapshot().coins.map((pose) => pose.rest)).toEqual(['asleep', 'asleep']);
  });

  describe('refuses', () => {
    const [pose] = SETTLED.coins;
    const restoreWith = (
      coins: readonly RestoreEntry[],
      extra: Partial<SimOptions> = {},
      pusherTickInCycle = 0,
    ): Promise<Sim> =>
      create({
        seed: SEED,
        mechanics: WORKER_MECHANICS,
        restore: { pusherTickInCycle, coins },
        ...extra,
      });

    it('a Sim with a Champagne Tower, and restore together with openingHeap', async () => {
      await expect(
        restoreWith([], { mechanics: { tiers: ['copper'], fusion: null } }),
      ).rejects.toThrow(/restore refuses a Sim with a Champagne Tower/);
      await expect(restoreWith([], { openingHeap: { coins: 3 } })).rejects.toThrow(
        /restore and openingHeap are mutually exclusive/,
      );
    });

    it('a heap slot outside the heap or repeated, and an unknown entry kind', async () => {
      const capacity = Sim.heapCapacity(WORKER_MECHANICS);
      for (const slot of [-1, capacity, 1.5, Number.NaN]) {
        await expect(restoreWith([{ kind: 'heapSlot', slot }])).rejects.toThrow(
          new RegExp(`restore.coins\\[0\\].slot must be an integer in \\[0, ${capacity}\\)`),
        );
      }
      await expect(restoreWith([{ kind: 'heapSlot', slot: capacity - 1 }])).resolves.toBeInstanceOf(
        Sim,
      );
      await expect(
        restoreWith([
          { kind: 'heapSlot', slot: 3 },
          { kind: 'heapSlot', slot: 3 },
        ]),
      ).rejects.toThrow(/restore.coins\[1\] repeats heap slot 3/);
      await expect(
        restoreWith([{ kind: 'stack', slot: 0 } as unknown as RestoreEntry]),
      ).rejects.toThrow(/restore.coins\[0\].kind must be "pose" or "heapSlot", got "stack"/);
      await expect(restoreWith('nope' as unknown as RestoreEntry[])).rejects.toThrow(
        /restore.coins must be an array/,
      );
    });

    it('any pose validateSnapshot would drop, naming the coin and the reason', async () => {
      if (!pose) {
        throw new Error('the fixture is empty');
      }
      const tick = SETTLED.pusherTickInCycle;
      await expect(
        restoreWith([{ kind: 'pose', pose: { ...pose, p: [0, 22001, 0] } }], {}, tick),
      ).rejects.toThrow(`(${pose.id}: out_of_bounds)`);
      await expect(
        restoreWith(
          [
            { kind: 'pose', pose },
            { kind: 'pose', pose: { ...pose, id: 900 } },
          ],
          {},
          tick,
        ),
      ).rejects.toThrow('(900: overlap)');
      await expect(
        restoreWith([{ kind: 'pose', pose: { ...pose, rest: 'frozen' } }], {}, tick),
      ).rejects.toThrow(`(${pose.id}: frozen_unsupported)`);
      await expect(
        restoreWith(
          [
            { kind: 'pose', pose },
            { kind: 'pose', pose },
          ],
          {},
          tick,
        ),
      ).rejects.toThrow(/coin id \d+ appears more than once/);
    });

    it('a pusher tick outside the cycle and a tier the ladder does not have', async () => {
      for (const tick of [-1, PUSHER.periodTicks, 0.5]) {
        await expect(restoreWith([], {}, tick)).rejects.toThrow(RangeError);
      }
      await expect(restoreWith([{ kind: 'heapSlot', slot: 0, tier: 'tin' }])).rejects.toThrow(
        /restore.coins\[0\].tier "tin" is not in the tier ladder/,
      );
      await expect(
        create({
          seed: SEED,
          restore: { pusherTickInCycle: 0, coins: [{ kind: 'heapSlot', slot: 0, tier: 'copper' }] },
        }),
      ).rejects.toThrow(/restore.coins\[0\].tier needs a Sim created with mechanics/);
    });
  });
});
