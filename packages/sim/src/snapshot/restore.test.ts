import { afterEach, describe, expect, it } from 'vitest';
import { SIM_VERSION } from '../constants.ts';
import type { SimInput } from '../inputs.ts';
import type { MechanicsConfig } from '../mechanics/index.ts';
import { type RestoreEntry, Sim, type SimOptions } from '../sim.ts';
import { PUSHER } from '../table/index.ts';
import settledTable from './fixtures/settled-table.json' with { type: 'json' };
import { type CoinPose, type SimTableSnapshot, SIM_SNAPSHOT_VERSION } from './snapshot.ts';
import { pusherBox, validateSnapshot } from './validate.ts';

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

/** The poses of `snapshot` validateSnapshot keeps, as the server stores them. */
function kept(snapshot: SimTableSnapshot): SimTableSnapshot {
  return { ...snapshot, coins: validateSnapshot(snapshot).ok };
}

/**
 * The scripted Demo table settled: the worker's 110-coin heap, 10 s of steadyDrops,
 * 10 s idle, then on to tick 180 of the pusher cycle, snapshotted with SIM_VERSION 7.
 */
const SETTLED_RAW: SimTableSnapshot = {
  version: SIM_SNAPSHOT_VERSION,
  pusherTickInCycle: settledTable.pusherTickInCycle,
  coins: settledTable.coins.map(parsePose),
};
/** SETTLED_RAW without coin 23, which overhangs a side gutter (see the pinned hash test). */
const SETTLED = kept(SETTLED_RAW);

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

type Point = Readonly<{ x: number; y: number; z: number }>;

function distance(a: Point, b: Point): number {
  return norm(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** How far a coin at rest may move over a restore's first 2 s (92-table-persistence 1.4). */
const STILL = 0.001;

/**
 * How far a coin the pusher wakes may end from the table played on after those 2 s. Looser
 * than STILL because positions are stored to 10 µm: moving every asleep coin by that one
 * unit moves a woken coin by up to 4.35 mm within 120 ticks at tick 180 of the cycle, and
 * the restored table ends one woken coin 1.08 mm off there. The 1.5 mm bound is the lead
 * decision recorded in 92-table-persistence 1.4 ("Woken-coin bound"); velocities are not
 * stored (P-275).
 */
const WOKEN = 0.0015;

/** `snapshot` with every asleep pose one position unit (10 µm) further along +x. */
function shiftedOneUnit(snapshot: SimTableSnapshot): SimTableSnapshot {
  return {
    ...snapshot,
    coins: snapshot.coins.map((pose) =>
      pose.rest === 'asleep' ? { ...pose, p: [pose.p[0] + 1, pose.p[1], pose.p[2]] } : pose,
    ),
  };
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
    const { dropped } = validateSnapshot(snapshot);
    for (const { id, reason } of dropped) {
      const pose = snapshot.coins.find((coin) => coin.id === id);
      expect(reason, `coin ${id}`).toBe('out_of_bounds');
      expect(pose?.rest, `coin ${id} is dropped but at rest`).toBe('awake');
    }
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
    const snapshot = kept(source.snapshot());
    expect(snapshot.coins.length).toBeGreaterThan(source.coinCount / 2);
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
    expect(validateSnapshot(SETTLED_RAW).dropped).toEqual([{ id: 23, reason: 'out_of_bounds' }]);
    expect(validateSnapshot(SETTLED).dropped).toEqual([]);
    const sim = await restore(SETTLED);
    expect(sim.hash()).toMatchInlineSnapshot(`"3b0c71dac53f6038"`);
    const [atSecond] = play(sim, 60, 60, steadyDrops);
    expect(atSecond).toMatchInlineSnapshot(`"0609e515127fb408"`);
    const [atMinute] = play(sim, 3540, 3540, steadyDrops);
    expect(atMinute).toMatchInlineSnapshot(`"ae7e0b2e8272d895"`);
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
   * The design's restore stability property (92-table-persistence 1.4), at the pusher's
   * four quarter phases. A table played on to that phase is snapshotted and restored, and
   * both tables then run 120 ticks side by side, with nothing falling from either that was
   * not already falling when the snapshot was taken.
   *
   * Every coin that restores asleep and that the table played on keeps asleep for all
   * 120 ticks ends less than 1 mm from where the table played on has it, and less than
   * 1 mm from where it restored: in the world, or on the block for a coin riding the
   * pusher top, which carries it the same way on both tables. Woken or not, more than nine
   * in ten of the coins that restore asleep end that still.
   *
   * The pusher's contact wakes much of the pile without moving it, so the sleep flag
   * alone strictly checks as few as 32 of 116 coins. Every coin the table played on ends
   * less than 1 mm from where it was is also held to 1 mm from the table played on, and
   * those are more than three in four of the coins that restore asleep.
   *
   * The rest are coins the pusher moves (riders scraped off near the backboard, the pile
   * at its face), which end within WOKEN of the table played on.
   */
  it.each([0, 1, 2, 3].map((quarter) => (quarter * PUSHER.periodTicks) / 4))(
    'restores a table with the pusher at tick %i of its cycle so that over 2 s nothing falls and coins at rest stay within 1 mm',
    async (tickInCycle) => {
      const reference = await restore(SETTLED);
      while (reference.snapshot().pusherTickInCycle !== tickInCycle || reference.tick === 0) {
        reference.step();
      }
      const taken = reference.snapshot();
      const falling = new Set(validateSnapshot(taken).dropped.map(({ id }) => id));
      const snapshot = kept(taken);
      const sim = await restore(snapshot);
      const shifted = await restore(shiftedOneUnit(snapshot));
      const asleep = snapshot.coins.flatMap((pose, i) => (pose.rest === 'asleep' ? [i] : []));
      const atRest = new Set(asleep.map((i) => snapshot.coins[i]?.id));
      const start = sim.coins();
      const before = new Map(reference.coins().map((coin) => [coin.id, coin.translation]));
      for (let tick = 0; tick < 120; tick++) {
        expect(sim.step().falls, `restored, tick ${sim.tick}`).toEqual([]);
        shifted.step();
        const falls = reference.step().falls.filter(({ coinId }) => !falling.has(coinId));
        expect(falls, `played on, tick ${reference.tick}`).toEqual([]);
        for (const coin of reference.coins()) {
          if (!coin.sleeping) {
            atRest.delete(coin.id);
          }
        }
      }
      const startBox = pusherBox(tickInCycle);
      const travel = pusherBox(sim.snapshot().pusherTickInCycle).z - startBox.z;
      const shelfFrontZ = startBox.z + startBox.hz;
      const there = new Map(reference.coins().map((coin) => [coin.id, coin.translation]));
      const now = sim.coins();
      const spread = shifted.coins();
      let still = 0;
      let keptStill = 0;
      let wokenWorst = 0;
      let sensitivity = 0;
      for (const i of asleep) {
        const id = snapshot.coins[i]?.id ?? -1;
        const from = start[i]?.translation;
        const to = now[i]?.translation;
        const played = there.get(id);
        const was = before.get(id);
        const off = spread[i]?.translation;
        if (!from || !to || !played || !was || !off) {
          throw new Error(`coin ${id} left a table it never fell from`);
        }
        const fromPlayed = distance(to, played);
        const rides = from.y > PUSHER.height && from.z <= shelfFrontZ;
        const moved = distance(to, { ...from, z: from.z + (rides ? travel : 0) });
        still += moved < STILL ? 1 : 0;
        const where = `coin ${id}${rides ? ' on the pusher top' : ''}`;
        const playedMoved = distance(played, { ...was, z: was.z + (rides ? travel : 0) });
        if (atRest.has(id)) {
          expect(fromPlayed, `${where}, from the table played on`).toBeLessThan(STILL);
          expect(moved, `${where}, from where it restored`).toBeLessThan(STILL);
        } else if (playedMoved < STILL) {
          keptStill += 1;
          expect(
            fromPlayed,
            `${where}, woken but kept still, from the table played on`,
          ).toBeLessThan(STILL);
        } else {
          wokenWorst = Math.max(wokenWorst, fromPlayed);
          sensitivity = Math.max(sensitivity, distance(to, off));
        }
      }
      expect(atRest.size, 'the table played on kept too few coins asleep').toBeGreaterThan(
        asleep.length / 4,
      );
      expect(
        atRest.size + keptStill,
        `the table played on kept ${atRest.size + keptStill} of ${asleep.length} asleep coins still`,
      ).toBeGreaterThan(asleep.length * 0.75);
      expect(still, `${still} of ${asleep.length} asleep coins stayed still`).toBeGreaterThan(
        asleep.length * 0.9,
      );
      expect(
        wokenWorst,
        `a woken coin ends ${(wokenWorst * 1000).toFixed(2)} mm from the table played on; one unit moves the table ${(sensitivity * 1000).toFixed(2)} mm`,
      ).toBeLessThan(WOKEN);
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
