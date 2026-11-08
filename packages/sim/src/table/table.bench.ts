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
 * which holds it at 224 to 250 coins (a sweep over the edge can take a couple of
 * dozen at once), up to 166 of them frozen at rest (COIN_REST). Measured with the
 * impact brake (COIN_MATERIAL.impactSpeed), the separation pass and the solver
 * settings in TABLE_SOLVER: before coins could rest, 3.01 to 3.06 ms mean and 3.72 to
 * 3.83 ms at the 99th percentile. Rest (P-215) took the tick about a tenth faster, but
 * a second round of runs on the same host, then slower all round, measured the old
 * table at 3.51 to 3.52 ms mean and 4.90 to 4.94 ms at the 99th, the new one at 3.17 to
 * 3.21 ms and 4.63 to 4.72 ms. Finding pressed rest coins through a grid of the awake
 * ones, rather than walking every frozen coin's contact pairs, then measured 2.97 to
 * 2.99 ms mean and 4.59 to 4.63 ms at the 99th against 3.50 ms and 4.91 to 5.00 ms for
 * the old table: compare runs taken back to back on one machine. Shape queries made
 * straight on the WASM shapes in the separation pass (CoinSeparator), on a host that
 * measured the old table at 3.5 ms mean, then gave 2.82 to 2.83 ms mean, 4.18 to 4.22
 * ms at the 99th and 4.45 to 4.52 ms at the 99.5th: the 99th is still over the 4 ms
 * budget there. The tail is the world step on late-return ticks (3.6 to 3.9 ms, with
 * some 150 upper-tier coins held awake by the backboard as the block slides under
 * them) and separation ticks of 20 to 37 passes (1.3 to 3 ms). The
 * coin and sleeping counts over the measured ticks are printed after the run, so the
 * result always says what it measured.
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
