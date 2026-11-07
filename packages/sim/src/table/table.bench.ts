import { afterAll, bench, describe } from 'vitest';
import { GRAVITY, TICK_RATE_HZ } from '../constants.ts';
import { Xoshiro128ss } from '../prng.ts';
import { loadRapier } from '../rapier.ts';
import { PusherTable } from './table.ts';
import { configureTableWorld } from './tuning.ts';

/**
 * Budget: one tick with 250 coins on the table must stay under 4 ms on desktop. Run
 * with `pnpm --filter @coinposh/sim exec vitest bench --run`.
 *
 * The table is filled by playing, not by placing coins, so the bench measures the
 * real steady state: a full upper tier riding the pusher, a packed lower tier being
 * shoved over the edge, and a fresh drop every tick that the table is short of 250,
 * which holds it at 238 to 250 coins (a sweep over the edge can take a dozen at
 * once), with at most one asleep (see TABLE_SOLVER). Measured: 3.5 ms mean, 4.05 ms
 * at the 99th percentile, so the mean holds the budget with about 13% to spare and
 * the slowest 1% of ticks run just past it. The coin and sleeping counts over the
 * measured ticks are printed after the run, so the result always says what it
 * measured.
 */
const TARGET_COINS = 250;
const WARMUP_TICKS = 45 * TICK_RATE_HZ;

const rapier = await loadRapier();
const world = new rapier.World(GRAVITY);
configureTableWorld(world);
const table = new PusherTable(rapier, world);
const rng = Xoshiro128ss.fromSeed(0xbe7c4);
let tick = 0;

function step(): void {
  if (table.coinCount < TARGET_COINS) {
    table.dropCoin((rng.nextInt(301) - 150) / 1000, rng);
  }
  tick += 1;
  table.step(tick);
}

for (let i = 0; i < WARMUP_TICKS; i++) {
  step();
}

const measured = { ticks: 0, minCoins: Number.POSITIVE_INFINITY, maxSleeping: 0 };

function measuredStep(): void {
  step();
  measured.ticks += 1;
  measured.minCoins = Math.min(measured.minCoins, table.coinCount);
  if (measured.ticks % TICK_RATE_HZ === 0) {
    const sleeping = table.coins().filter((c) => c.sleeping).length;
    measured.maxSleeping = Math.max(measured.maxSleeping, sleeping);
  }
}

afterAll(() => {
  const { ticks, minCoins, maxSleeping } = measured;
  console.info(
    `measured ${ticks} ticks: at least ${minCoins} coins, ` +
      `at most ${maxSleeping} sleeping (sampled once a second)`,
  );
});

describe(`PusherTable, ${TARGET_COINS} coins`, () => {
  bench('one 60 Hz tick', measuredStep, { time: 5000, warmupTime: 500 });
});
