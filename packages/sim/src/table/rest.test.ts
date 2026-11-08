import type { World } from '@dimforge/rapier3d-deterministic-compat';
import { afterEach, describe, expect, it } from 'vitest';
import { COIN } from '../coin.ts';
import { GRAVITY, TICK_RATE_HZ } from '../constants.ts';
import { StateHasher } from '../hash.ts';
import { Xoshiro128ss } from '../prng.ts';
import { loadRapier } from '../rapier.ts';
import { PUSHER } from './layout.ts';
import { PusherTable, type TableCoin } from './table.ts';
import { COIN_MATERIAL, configureTableWorld } from './tuning.ts';

/** The Demo table's seed and opening pour: 160 coins at 40 a second, golden-ratio spread. */
const DEMO_SEED = 0xc0196051;
const POUR_COINS = 160;
const POUR_SPREAD_MM = 135;
const SETTLE_TICKS = 10 * TICK_RATE_HZ;
const IDLE_TICKS = 600 * TICK_RATE_HZ;
const DROP_EVERY_TICKS = 2 * TICK_RATE_HZ;
const DROP_COUNT = 60;
const FLAT = { x: 0, y: 0, z: 0, w: 1 };
/** Forward slip over the block, in metres, that counts a coin as scraped by the backboard. */
const SCRAPED = 0.0005;

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

const high = (coin: TableCoin) => coin.translation.y > PUSHER.height + COIN.halfThickness / 2;

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
function shift(a: TableCoin, b: TableCoin, blockMoved: number): number {
  const dz = b.translation.z - a.translation.z - (high(a) && high(b) ? blockMoved : 0);
  const dx = b.translation.x - a.translation.x;
  const dy = b.translation.y - a.translation.y;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) * 1000;
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

interface PourRun {
  readonly frontFallTicks: number[];
  /** Coins that left the pusher top after the settle, by its front or down off it. */
  readonly departures: Departure[];
  /** Over each second from 60 to 90 s, the coins frozen through all of it. */
  readonly resting: number[];
  readonly coinsAt90s: number;
  /** The most a coin frozen through a second moved in it, summed tick by tick. */
  readonly restingWorst: Motion;
  readonly hashes: string[];
}

/**
 * The Demo opening pour, then `drops` more coins one every two seconds from the settle
 * on (none for the idle table), hashed every minute.
 */
async function demoPour(ticks: number, drops: number): Promise<PourRun> {
  const table = await createTable();
  const rng = Xoshiro128ss.fromSeed(DEMO_SEED);
  const pour = pourDrops();
  const frontFallTicks: number[] = [];
  const departures: Departure[] = [];
  const resting: number[] = [];
  const hashes: string[] = [];
  const onTop = new Set<number>();
  const scraped = new Map<number, number>();
  const returnStart = new Map<number, number>();
  let restingWorst: Motion = { mm: 0, deg: 0 };
  let coinsAt90s = 0;
  let last = new Map<number, TableCoin>();
  let path = new Map<number, Motion>();
  let lastFront = table.pusher.frontZ;
  let dropped = 0;
  for (let tick = 1; tick <= ticks; tick++) {
    for (const x of pour.get(tick) ?? []) {
      table.dropCoin(x, rng);
    }
    if (tick > SETTLE_TICKS && dropped < drops && (tick - SETTLE_TICKS) % DROP_EVERY_TICKS === 1) {
      table.dropCoin((rng.nextInt(301) - 150) / 1000, rng);
      dropped += 1;
    }
    const phaseBefore = table.pusher.phase;
    for (const fall of table.step(tick)) {
      if (fall.edge === 'front') {
        frontFallTicks.push(tick);
      }
    }
    const phase = table.pusher.phase;
    const front = table.pusher.frontZ;
    const coins = table.coins();
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
    if (tick > 60 * TICK_RATE_HZ && tick <= 90 * TICK_RATE_HZ) {
      const next = new Map<number, Motion>();
      for (const coin of coins) {
        const before = last.get(coin.id);
        const sofar = path.get(coin.id);
        if (before?.sleeping && coin.sleeping && (sofar || tick % TICK_RATE_HZ === 1)) {
          next.set(coin.id, {
            mm: (sofar?.mm ?? 0) + shift(before, coin, front - lastFront),
            deg: (sofar?.deg ?? 0) + turn(before.rotation, coin.rotation),
          });
        }
      }
      path = next;
      if (tick % TICK_RATE_HZ === 0) {
        resting.push(path.size);
        for (const motion of path.values()) {
          restingWorst = {
            mm: Math.max(restingWorst.mm, motion.mm),
            deg: Math.max(restingWorst.deg, motion.deg),
          };
        }
        path = new Map();
        coinsAt90s = coins.length;
      }
    }
    last = new Map(coins.map((coin) => [coin.id, coin]));
    lastFront = front;
    if (tick % (60 * TICK_RATE_HZ) === 0) {
      hashes.push(table.hashInto(new StateHasher().int(tick)).digest());
    }
  }
  return { frontFallTicks, departures, resting, coinsAt90s, restingWorst, hashes };
}

let idle: Promise<PourRun> | undefined;
function idleTable(): Promise<PourRun> {
  idle ??= demoPour(IDLE_TICKS, 0);
  return idle;
}

let played: Promise<PourRun> | undefined;
const PLAY_TICKS = SETTLE_TICKS + DROP_COUNT * DROP_EVERY_TICKS;
function playedTable(): Promise<PourRun> {
  played ??= demoPour(PLAY_TICKS, DROP_COUNT);
  return played;
}

describe('the Demo opening heap with nobody playing, for ten minutes', () => {
  it(
    'drops at most two coins over the front lip after the first 10 s',
    { timeout: 180_000 },
    async () => {
      const { frontFallTicks } = await idleTable();
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
      const { departures } = await idleTable();
      const unscraped = departures.filter(
        (d) => d.phase < PUSHER.pushFraction && d.scraped <= SCRAPED,
      );
      expect(unscraped, JSON.stringify(departures)).toEqual([]);
    },
  );

  it(
    'keeps most of the table at rest, and a resting coin exactly where it lies',
    { timeout: 180_000 },
    async () => {
      const { resting, coinsAt90s, restingWorst } = await idleTable();
      const perSecond = `resting coins per second: ${resting.join(' ')} of ${coinsAt90s}`;
      expect(resting).toHaveLength(30);
      expect(resting.reduce((a, b) => a + b, 0) / resting.length, perSecond).toBeGreaterThan(
        coinsAt90s / 2,
      );
      expect(Math.min(...resting), perSecond).toBeGreaterThan(coinsAt90s / 4);
      expect(restingWorst.mm).toBeLessThan(0.2);
      expect(restingWorst.deg).toBeLessThan(1);
    },
  );

  it('replays to the same hash every minute', { timeout: 180_000 }, async () => {
    const { hashes } = await idleTable();
    expect(hashes).toHaveLength(10);
    expect((await demoPour(2 * 60 * TICK_RATE_HZ, 0)).hashes).toEqual(hashes.slice(0, 2));
  });

  it(
    'pins the hash after ten minutes so rest or wake changes are caught',
    { timeout: 180_000 },
    async () => {
      const { hashes } = await idleTable();
      // Changing this value breaks replay audits of every input log recorded before
      // the change. Update it only alongside a deliberate sim version bump.
      expect(hashes.at(-1)).toMatchInlineSnapshot(`"a044318612a6692b"`);
    },
  );
});

describe('the Demo opening heap with a coin dropped every 2 s for 2 minutes', () => {
  it(
    'pays out at least one front fall for every two coins dropped',
    { timeout: 120_000 },
    async () => {
      const { frontFallTicks } = await playedTable();
      const paid = frontFallTicks.filter((tick) => tick > SETTLE_TICKS);
      expect(paid.length).toBeGreaterThanOrEqual(DROP_COUNT / 2);
    },
  );

  it('replays to the same hash and pins it', { timeout: 120_000 }, async () => {
    const { hashes } = await playedTable();
    expect((await demoPour(PLAY_TICKS, DROP_COUNT)).hashes).toEqual(hashes);
    // Changing this value breaks replay audits of every input log recorded before
    // the change. Update it only alongside a deliberate sim version bump.
    expect(hashes.at(-1)).toMatchInlineSnapshot(`"d12afc06736517d7"`);
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
