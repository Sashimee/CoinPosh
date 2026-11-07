import { bench, describe } from 'vitest';
import { GRAVITY, TICK_RATE_HZ } from '../constants.ts';
import { Xoshiro128ss } from '../prng.ts';
import { loadRapier } from '../rapier.ts';
import { PusherTable } from './table.ts';
import { configureTableWorld } from './tuning.ts';

/**
 * Budget: one tick with 250 coins on the table, all awake, must stay under 4 ms on
 * desktop. Run with `pnpm --filter @coinposh/sim exec vitest bench --run`.
 *
 * The table is filled by playing, not by placing coins, so the bench measures the
 * real steady state: a full upper tier riding the pusher, a packed lower tier being
 * shoved over the edge, and fresh drops topping it back up to 250.
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
  if (tick % 6 === 0 && table.coinCount < TARGET_COINS) {
    table.dropCoin((rng.nextInt(301) - 150) / 1000, rng);
  }
  table.beforeStep();
  world.step();
  tick += 1;
  table.afterStep(tick);
}

for (let i = 0; i < WARMUP_TICKS; i++) {
  step();
}

describe(`PusherTable, ${TARGET_COINS} coins`, () => {
  bench('one 60 Hz tick', step, { time: 5000, warmupTime: 500 });
});
