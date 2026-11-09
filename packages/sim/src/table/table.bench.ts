import { afterAll, bench, describe } from 'vitest';
import { GRAVITY, TICK_RATE_HZ } from '../constants.ts';
import { Xoshiro128ss } from '../prng.ts';
import { loadRapier } from '../rapier.ts';
import { PusherTable } from './table.ts';
import { configureTableWorld } from './tuning.ts';

/**
 * Budget: one tick with 250 coins on the table must stay under 4 ms at the 99th
 * percentile on desktop. Run with `pnpm --filter @coinposh/sim exec vitest bench --run`.
 *
 * The table is filled by playing, not by placing coins: a full upper tier riding the
 * pusher, a packed lower tier being shoved over the edge, and a fresh drop every tick
 * that the table is short of 250, which holds it at 238 to 250 coins, up to 144 of them
 * frozen at rest (COIN_REST).
 *
 * Only the tick is timed. The sleeping count runs once a second in a microtask, after
 * tinybench has stopped the clock, so it is not in the figures; timing it inside moved
 * the 99th by under 0.05 ms. Compare only runs taken back to back on one machine.
 *
 * On 2026-11-09, back to back on one host: 3.11 to 3.13 ms mean and 4.46 to 4.48 ms at
 * the 99th, against 3.57 ms and 5.06 ms for the table before coins could rest (2e31a30).
 * The 99th is over budget. The tail is late-return ticks, where the backboard holds some
 * 180 upper-tier coins awake as the block slides under them (the world step alone 3.1 to
 * 3.5 ms), and separation ticks of 17 to 47 passes (1.2 to 2.8 ms). The coin and
 * sleeping counts are printed after the run.
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
    // tinybench stops the clock when this synchronous call returns, so the count
    // runs untimed in a microtask before the next sample starts.
    queueMicrotask(countSleeping);
  }
}

function countSleeping(): void {
  const sleeping = table.coins().filter((c) => c.sleeping).length;
  measured.maxSleeping = Math.max(measured.maxSleeping, sleeping);
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
