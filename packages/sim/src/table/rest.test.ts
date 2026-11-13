import { openingHeap } from '@coinposh/economy';
import { COIN_TIERS } from '@coinposh/shared';
import type { World } from '@dimforge/rapier3d-deterministic-compat';
import { afterEach, describe, expect, it } from 'vitest';
import { COIN } from '../coin.ts';
import { GRAVITY, TICK_RATE_HZ } from '../constants.ts';
import { StateHasher } from '../hash.ts';
import type { SimInput } from '../inputs.ts';
import type { MechanicsConfig } from '../mechanics/index.ts';
import { Xoshiro128ss } from '../prng.ts';
import { loadRapier } from '../rapier.ts';
import { type CoinState, Sim } from '../sim.ts';
import { PUSHER } from './layout.ts';
import { PusherTable, type TableCoin } from './table.ts';
import { COIN_MATERIAL, configureTableWorld } from './tuning.ts';

/** The Demo table's seed (apps/web), then two more tables with the same heap. */
const DEMO_SEED = 0xc0196051;
const SEEDS = [DEMO_SEED, 1, 2];
/** Tiers with no fusion and no tower: the table on its own, as the sim worker ran it before P-222. */
const DEMO_MECHANICS: MechanicsConfig<string> = { tiers: COIN_TIERS, fusion: null, tower: null };
const SETTLE_TICKS = 10 * TICK_RATE_HZ;
const IDLE_TICKS = 600 * TICK_RATE_HZ;
const DROP_EVERY_TICKS = 2 * TICK_RATE_HZ;
const DROP_COUNT = 60;
const PLAY_TICKS = SETTLE_TICKS + DROP_COUNT * DROP_EVERY_TICKS;
const FLAT = { x: 0, y: 0, z: 0, w: 1 };
/** Forward slip over the block, in metres, that counts a coin as scraped by the backboard. */
const SCRAPED = 0.0005;
/**
 * How far ahead of the pusher's face, in metres, a coin on the lower tier is out of its
 * reach: the face only wakes coins within COIN_REST.pusherMargin of it, and a coin
 * further ahead is moved only through the ones in between.
 */
const BEYOND_FACE = 0.04;

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

type Posed = Pick<TableCoin, 'translation'>;

const high = (coin: Posed) => coin.translation.y > PUSHER.height + COIN.halfThickness / 2;

/**
 * An upper bound, in degrees, on the angle between two orientations: 2 tan(θ/2) of the
 * rotation taking one to the other, which is at least θ. Acos of their dot product
 * would read float32 rounding of an unchanged quaternion as hundredths of a degree.
 */
function turn(a: TableCoin['rotation'], b: TableCoin['rotation']): number {
  const w = a.w * b.w + a.x * b.x + a.y * b.y + a.z * b.z;
  const x = a.w * b.x - a.x * b.w - a.y * b.z + a.z * b.y;
  const y = a.w * b.y + a.x * b.z - a.y * b.w - a.z * b.x;
  const z = a.w * b.z - a.x * b.y + a.y * b.x - a.z * b.w;
  return ((2 * Math.sqrt(x * x + y * y + z * z)) / Math.abs(w)) * (180 / Math.PI);
}

/** Millimetres between two poses, along the block for a coin on the pusher top. */
function shift(a: Posed, b: Posed, blockMoved: number): number {
  const dz = b.translation.z - a.translation.z - (high(a) && high(b) ? blockMoved : 0);
  const dx = b.translation.x - a.translation.x;
  const dy = b.translation.y - a.translation.y;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) * 1000;
}

/**
 * Whether `coin` lies half on another: a coin one layer below has its centre 0.5 to 1.5
 * radii away across the table, and none lies squarely under it.
 */
function halfOnAnother(coin: CoinState, coins: readonly CoinState[]): boolean {
  let overlapped = false;
  for (const other of coins) {
    const rise = coin.translation.y - other.translation.y;
    if (rise < COIN.halfThickness || rise > 3 * COIN.halfThickness) {
      continue;
    }
    const dx = coin.translation.x - other.translation.x;
    const dz = coin.translation.z - other.translation.z;
    const apart = Math.sqrt(dx * dx + dz * dz);
    if (apart < 0.5 * COIN.radius) {
      return false;
    }
    overlapped ||= apart <= 1.5 * COIN.radius;
  }
  return overlapped;
}

type DropPattern = 'scattered' | 'sweep' | 'centre';
const PATTERNS: readonly DropPattern[] = ['scattered', 'sweep', 'centre'];

/** Where the `i`th drop goes across the table, in millimetres from the centre line. */
function dropMm(pattern: DropPattern, i: number, rng: Xoshiro128ss): number {
  switch (pattern) {
    case 'scattered':
      return rng.nextInt(301) - 150;
    case 'sweep':
      return ((i * 37) % 301) - 150;
    case 'centre':
      return rng.nextInt(41) - 20;
  }
}

interface Departure {
  readonly tick: number;
  readonly coinId: number;
  readonly phase: number;
  /** Forward slip over the block from the backboard, summed over the returns it rode. */
  readonly scraped: number;
}

interface Motion {
  readonly mm: number;
  readonly deg: number;
}

const worse = (a: Motion, b: Motion): Motion => ({
  mm: Math.max(a.mm, b.mm),
  deg: Math.max(a.deg, b.deg),
});

interface DemoRun {
  readonly frontFallTicks: number[];
  /** Coins that left the pusher top after the settle, by its front or down off it. */
  readonly departures: Departure[];
  /** Over each second from the settle on, the coins on the table at its end. */
  readonly coinsPerSecond: number[];
  /** Over each second from the settle on, the coins frozen at its start. */
  readonly resting: number[];
  /** Over each second from the settle on, the coins awake through all of it. */
  readonly awake: number[];
  /**
   * The most a coin frozen at the start of a second, from the settle on, moved in that
   * second, summed tick by tick whether it stayed frozen or not; along the block on the
   * pusher top. A coin that left the table in the second counts as moving without bound.
   */
  readonly restingWorst: Motion;
  readonly restingWorstAt: string;
  /**
   * Of those coin-seconds, the ones lying half on another (halfOnAnother) at the
   * second's start, and the most one moved.
   */
  readonly halfOn: { readonly count: number; readonly worst: Motion };
  /**
   * From 60 to 90 s, for awake coins on the lower tier BEYOND_FACE ahead of the face:
   * the longest they stayed awake there, in ticks, and the most one moved there in a
   * second, in millimetres.
   */
  readonly loose: { readonly ticks: number; readonly mm: number };
  readonly hashes: string[];
}

/**
 * The Demo table (Sim with tiers and no fusion and the economy's opening heap) on
 * `seed`, with `drops` coins dropped one every two seconds from the settle on (none for
 * the idle table), across the table by `pattern`; Sim.hash every minute.
 */
async function demoRun(
  seed: number,
  ticks: number,
  drops = 0,
  pattern: DropPattern = 'scattered',
): Promise<DemoRun> {
  const sim = await Sim.create({ seed, mechanics: DEMO_MECHANICS, openingHeap });
  try {
    const rng = Xoshiro128ss.fromSeed((seed ^ 0x5eed) >>> 0);
    const frontFallTicks: number[] = [];
    const departures: Departure[] = [];
    const resting: number[] = [];
    const awake: number[] = [];
    const hashes: string[] = [];
    const onTop = new Set<number>();
    const scraped = new Map<number, number>();
    const returnStart = new Map<number, number>();
    let restingWorst: Motion = { mm: 0, deg: 0 };
    let halfOn = { count: 0, worst: { mm: 0, deg: 0 } };
    const awakeFor = new Map<number, number>();
    const looseMm = new Map<number, number>();
    let loose = { ticks: 0, mm: 0 };
    const coinsPerSecond: number[] = [];
    let restingWorstAt = 'no coin';
    let last = new Map<number, CoinState>();
    let lastCoins: readonly CoinState[] = [];
    let watched = new Map<number, Motion>();
    let halfOnIds = new Set<number>();
    let awakeThrough = new Set<number>();
    let lastFront = sim.pusher.frontZ;
    let dropped = 0;
    for (let tick = 1; tick <= ticks; tick++) {
      const inputs: SimInput[] = [];
      if (
        tick > SETTLE_TICKS &&
        dropped < drops &&
        (tick - SETTLE_TICKS) % DROP_EVERY_TICKS === 1
      ) {
        inputs.push({ kind: 'dropCoin', xMm: dropMm(pattern, dropped, rng) });
        dropped += 1;
      }
      const phaseBefore = sim.pusher.phase;
      for (const fall of sim.step(inputs).falls) {
        if (fall.edge === 'front') {
          frontFallTicks.push(fall.tick);
        }
      }
      const { phase, frontZ: front } = sim.pusher;
      const coins = sim.coins();
      const returnBegins = phaseBefore < PUSHER.pushFraction && phase >= PUSHER.pushFraction;
      const returnEnds = phase < phaseBefore;
      for (const coin of coins) {
        const along = coin.translation.z - front;
        if (returnBegins && high(coin)) {
          returnStart.set(coin.id, along);
        }
        const start = returnStart.get(coin.id);
        if (returnEnds && start !== undefined) {
          returnStart.delete(coin.id);
          if (high(coin) && along > start) {
            scraped.set(coin.id, (scraped.get(coin.id) ?? 0) + along - start);
          }
        }
        const atop = high(coin) && along < 0;
        if (atop) {
          onTop.add(coin.id);
        } else if (onTop.delete(coin.id)) {
          if (tick > SETTLE_TICKS) {
            departures.push({ tick, coinId: coin.id, phase, scraped: scraped.get(coin.id) ?? 0 });
          }
          scraped.delete(coin.id);
        }
      }
      if (tick > SETTLE_TICKS) {
        const now = new Map(coins.map((coin) => [coin.id, coin]));
        const secondStarts = (tick - SETTLE_TICKS) % TICK_RATE_HZ === 1;
        if (secondStarts) {
          watched = new Map();
          for (const coin of lastCoins) {
            if (coin.sleeping) {
              watched.set(coin.id, { mm: 0, deg: 0 });
            }
          }
          halfOnIds = new Set(
            lastCoins
              .filter((coin) => coin.sleeping && halfOnAnother(coin, lastCoins))
              .map((coin) => coin.id),
          );
        }
        for (const [id, sofar] of watched) {
          const before = last.get(id);
          const coin = now.get(id);
          watched.set(
            id,
            before && coin
              ? {
                  mm: sofar.mm + shift(before, coin, front - lastFront),
                  deg: sofar.deg + turn(before.rotation, coin.rotation),
                }
              : { mm: Infinity, deg: Infinity },
          );
        }
        const stillAwake = new Set<number>();
        for (const coin of coins) {
          if (!coin.sleeping && (secondStarts || awakeThrough.has(coin.id))) {
            stillAwake.add(coin.id);
          }
        }
        awakeThrough = stillAwake;
        if (tick % TICK_RATE_HZ === 0) {
          resting.push(watched.size);
          awake.push(awakeThrough.size);
          coinsPerSecond.push(coins.length);
          for (const [id, motion] of watched) {
            if (motion.mm > restingWorst.mm || motion.deg > restingWorst.deg) {
              restingWorstAt = `coin ${id} in the second ending at tick ${tick}`;
            }
            restingWorst = worse(restingWorst, motion);
            if (halfOnIds.has(id)) {
              halfOn = { count: halfOn.count + 1, worst: worse(halfOn.worst, motion) };
            }
          }
        }
      }
      if (tick > 60 * TICK_RATE_HZ && tick <= 90 * TICK_RATE_HZ) {
        for (const coin of coins) {
          const before = last.get(coin.id);
          if (!before || high(coin) || coin.sleeping || coin.translation.z - front < BEYOND_FACE) {
            awakeFor.delete(coin.id);
            continue;
          }
          const ticksAwake = (awakeFor.get(coin.id) ?? 0) + 1;
          awakeFor.set(coin.id, ticksAwake);
          looseMm.set(coin.id, (looseMm.get(coin.id) ?? 0) + shift(before, coin, 0));
          loose = { ticks: Math.max(loose.ticks, ticksAwake), mm: loose.mm };
        }
        if (tick % TICK_RATE_HZ === 0) {
          loose = { ticks: loose.ticks, mm: Math.max(loose.mm, ...looseMm.values()) };
          looseMm.clear();
        }
      }
      last = new Map(coins.map((coin) => [coin.id, coin]));
      lastCoins = coins;
      lastFront = front;
      if (tick % (60 * TICK_RATE_HZ) === 0) {
        hashes.push(sim.hash());
      }
    }
    return {
      frontFallTicks,
      departures,
      resting,
      awake,
      coinsPerSecond,
      restingWorst,
      restingWorstAt,
      halfOn,
      loose,
      hashes,
    };
  } finally {
    sim.dispose();
  }
}

const hex = (seed: number) => `0x${seed.toString(16)}`;

const idleRuns = new Map<number, Promise<DemoRun>>();
function idleTable(seed: number): Promise<DemoRun> {
  let run = idleRuns.get(seed);
  if (!run) {
    run = demoRun(seed, IDLE_TICKS);
    idleRuns.set(seed, run);
  }
  return run;
}

for (const seed of SEEDS) {
  describe(`the Demo opening heap on seed ${hex(seed)} with nobody playing, for ten minutes`, () => {
    it(
      'drops at most two coins over the front lip after the first 10 s',
      { timeout: 180_000 },
      async () => {
        const { frontFallTicks } = await idleTable(seed);
        const late = frontFallTicks.filter((tick) => tick > SETTLE_TICKS);
        expect(late.length, `front falls at ticks ${frontFallTicks.join(' ')}`).toBeLessThanOrEqual(
          2,
        );
      },
    );

    it(
      'loses coins off the pusher top only where the backboard scraped them forward',
      { timeout: 180_000 },
      async () => {
        const { departures } = await idleTable(seed);
        const unscraped = departures.filter((d) => d.scraped <= SCRAPED);
        expect(unscraped, JSON.stringify(departures)).toEqual([]);
      },
    );

    it(
      'keeps most of the table at rest and almost none awake through a second, and a resting coin, even one half on another, where it lies',
      { timeout: 180_000 },
      async () => {
        const { resting, awake, coinsPerSecond, restingWorst, restingWorstAt, halfOn } =
          await idleTable(seed);
        const seconds = (IDLE_TICKS - SETTLE_TICKS) / TICK_RATE_HZ;
        const perSecond = `coins frozen at the start of each second: ${resting.join(' ')}`;
        const awakePerSecond = `coins awake through each second: ${awake.join(' ')}`;
        expect(resting).toHaveLength(seconds);
        expect(awake).toHaveLength(seconds);
        resting.forEach((count, i) => {
          const coins = coinsPerSecond[i] ?? 0;
          expect(count, perSecond).toBeGreaterThan(coins / 2);
          expect(awake[i], awakePerSecond).toBeLessThanOrEqual(coins / 20);
        });
        expect(restingWorst.mm, restingWorstAt).toBeLessThan(0.2);
        expect(restingWorst.deg, restingWorstAt).toBeLessThan(1);
        expect(halfOn.count, 'resting coin-seconds half on another coin').toBeGreaterThan(0);
        expect(halfOn.worst.mm).toBeLessThan(0.2);
        expect(halfOn.worst.deg).toBeLessThan(1);
      },
    );

    it(
      "lets an awake coin out of the pusher's reach on the lower tier freeze within a second, barely moving",
      { timeout: 180_000 },
      async () => {
        // The upper tier is left out: a coin there past the face never freezes, by design
        // (COIN_REST), and one on the block is moved by the backboard.
        const { loose } = await idleTable(seed);
        expect(loose.ticks, JSON.stringify(loose)).toBeLessThanOrEqual(TICK_RATE_HZ);
        expect(loose.mm, JSON.stringify(loose)).toBeLessThan(2);
      },
    );
  });
}

describe('the idle Demo table on its own seed', () => {
  it('replays to the same hash every minute', { timeout: 180_000 }, async () => {
    const { hashes } = await idleTable(DEMO_SEED);
    expect(hashes).toHaveLength(10);
    expect((await demoRun(DEMO_SEED, 2 * 60 * TICK_RATE_HZ)).hashes).toEqual(hashes.slice(0, 2));
  });

  it(
    'pins the hash after ten minutes so rest or wake changes are caught',
    { timeout: 180_000 },
    async () => {
      const { hashes } = await idleTable(DEMO_SEED);
      // Changing this value breaks replay audits of every input log recorded before
      // the change. Update it only alongside a deliberate sim version bump.
      expect(hashes.at(-1)).toMatchInlineSnapshot(`"2594a3a4fc7da2a1"`);
    },
  );
});

const playedRuns = new Map<string, Promise<DemoRun>>();
function playedTable(seed: number, pattern: DropPattern): Promise<DemoRun> {
  const key = `${seed}:${pattern}`;
  let run = playedRuns.get(key);
  if (!run) {
    run = demoRun(seed, PLAY_TICKS, DROP_COUNT, pattern);
    playedRuns.set(key, run);
  }
  return run;
}

describe('the Demo opening heap with a coin dropped every 2 s for 2 minutes', () => {
  for (const seed of SEEDS) {
    for (const pattern of PATTERNS) {
      it(
        `pays out at least one front fall for every two coins dropped, seed ${hex(seed)}, ${pattern} drops`,
        { timeout: 120_000 },
        async () => {
          const { frontFallTicks } = await playedTable(seed, pattern);
          const paid = frontFallTicks.filter((tick) => tick > SETTLE_TICKS);
          expect(paid.length).toBeGreaterThanOrEqual(DROP_COUNT / 2);
        },
      );
    }
  }

  it('replays to the same hash and pins it', { timeout: 120_000 }, async () => {
    const { hashes } = await playedTable(DEMO_SEED, 'scattered');
    expect((await demoRun(DEMO_SEED, PLAY_TICKS, DROP_COUNT, 'scattered')).hashes).toEqual(hashes);
    // Changing this value breaks replay audits of every input log recorded before
    // the change. Update it only alongside a deliberate sim version bump.
    expect(hashes.at(-1)).toMatchInlineSnapshot(`"21c5adc0ce693322"`);
  });
});

describe('waking the coins in a region', () => {
  /** Two lone coins on the lower tier, 10 cm apart, stepped until both are frozen. */
  async function twoFrozen(): Promise<{ table: PusherTable; left: number; right: number }> {
    const table = await createTable();
    const y = COIN.halfThickness + COIN_MATERIAL.contactSkin;
    const left = table.addCoin({ x: -0.05, y, z: 0.03 }, FLAT);
    const right = table.addCoin({ x: 0.05, y, z: 0.03 }, FLAT);
    for (let tick = 1; tick <= 2 * TICK_RATE_HZ; tick++) {
      table.step(tick);
    }
    expect(table.coins().map((c) => c.sleeping)).toEqual([true, true]);
    return { table, left, right };
  }

  const sleepingOf = (table: PusherTable) =>
    new Map(table.coins().map((coin) => [coin.id, coin.sleeping]));

  it('wakes the frozen coins whose centres lie in the box, and only those', async () => {
    const { table, left, right } = await twoFrozen();
    table.wakeRegion({ x: -0.1, y: -0.01, z: 0 }, { x: 0, y: 0.05, z: 0.06 });
    const sleeping = sleepingOf(table);
    expect(sleeping.get(left)).toBe(false);
    expect(sleeping.get(right)).toBe(true);
  });

  it('wakes nothing for a box that holds no coin centre', async () => {
    const { table } = await twoFrozen();
    table.wakeRegion({ x: -0.04, y: -0.01, z: 0 }, { x: 0.04, y: 0.05, z: 0.06 });
    expect([...sleepingOf(table).values()]).toEqual([true, true]);
  });

  it('throws for a box whose min exceeds its max', async () => {
    const { table } = await twoFrozen();
    expect(() => {
      table.wakeRegion({ x: 0, y: 0, z: 0.1 }, { x: 0.1, y: 0.1, z: 0 });
    }).toThrow(RangeError);
  });

  it('replays a wake to the same hash', async () => {
    const run = async () => {
      const { table } = await twoFrozen();
      table.wakeRegion({ x: -0.1, y: -0.01, z: 0 }, { x: 0.1, y: 0.05, z: 0.06 });
      for (let tick = 2 * TICK_RATE_HZ + 1; tick <= 3 * TICK_RATE_HZ; tick++) {
        table.step(tick);
      }
      return table.hashInto(new StateHasher()).digest();
    };
    expect(await run()).toBe(await run());
  });
});

/** A coin dropped half on another; how far the top one moves in each second after the first two. */
async function halfOn(shelf: boolean, offset: number): Promise<Motion[]> {
  const table = await createTable();
  const base = shelf ? PUSHER.height : 0;
  const z = shelf ? -0.17 : 0.03;
  table.addCoin({ x: 0, y: base + COIN.halfThickness + COIN_MATERIAL.contactSkin, z }, FLAT);
  const top = table.addCoin(
    { x: offset * COIN.radius, y: base + 3 * COIN.halfThickness + 0.002, z },
    FLAT,
  );
  const coinOf = () => {
    const coin = table.coins().find((c) => c.id === top);
    if (!coin) {
      throw new Error(`coin ${top} left the table`);
    }
    return coin;
  };
  const seconds: Motion[] = [];
  let before = coinOf();
  let front = table.pusher.frontZ;
  let second: Motion = { mm: 0, deg: 0 };
  for (let tick = 1; tick <= 10 * TICK_RATE_HZ; tick++) {
    table.step(tick);
    const now = coinOf();
    second = {
      mm: second.mm + shift(before, now, table.pusher.frontZ - front),
      deg: second.deg + turn(before.rotation, now.rotation),
    };
    before = now;
    front = table.pusher.frontZ;
    if (tick % TICK_RATE_HZ === 0) {
      if (tick > 2 * TICK_RATE_HZ) {
        seconds.push(second);
      }
      second = { mm: 0, deg: 0 };
    }
  }
  return seconds;
}

describe('a coin resting half on another', () => {
  for (const shelf of [false, true]) {
    for (const offset of [0.6, 0.8, 1.0, 1.2]) {
      it(`on the ${shelf ? 'pusher top' : 'floor'}, ${offset} radii off centre, moves under 0.2 mm and 1° a second`, async () => {
        const seconds = await halfOn(shelf, offset);
        expect(seconds).toHaveLength(8);
        for (const { mm, deg } of seconds) {
          expect(mm, JSON.stringify(seconds)).toBeLessThan(0.2);
          expect(deg, JSON.stringify(seconds)).toBeLessThan(1);
        }
      });
    }
  }
});
