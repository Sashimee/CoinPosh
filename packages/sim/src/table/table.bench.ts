import { crateSpawn } from '@coinposh/economy';
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
 * On 2026-11-09, two rounds back to back on one loaded host (load 4 to 6): 3.06 to
 * 3.10 ms mean and 4.39 to 4.54 ms at the 99th, against 3.55 ms and 4.98 to 5.02 ms for
 * the table before coins could rest (feat/build-loop). The 99th is over budget. The tail
 * is late-return ticks, where the backboard holds some 180 to 230 upper-tier coins awake
 * as the block slides under them (the world step alone 3.1 to 3.5 ms), and separation
 * ticks of 17 to 47 passes (1.2 to 2.8 ms). Waking only the riders within a coin of the
 * board, or not cascading the board's push, cut the separation passes but let the pour
 * spill 12 to 13 coins over the front lip instead of 5. The coin and
 * sleeping counts are printed after the run.
 *
 * The same table with Vault Crates (CRATE_BODY) is measured twice: one crate every
 * crateSpawn.dropsPerCrate coin drops, as the economy spawns them, and a stress case
 * that drops a fresh crate on any tick the table holds fewer than three. The figures
 * are in CRATE_BODY.
 */
const TARGET_COINS = 250;
const STRESS_CRATES = 3;
const WARMUP_TICKS = 45 * TICK_RATE_HZ;

const rapier = await loadRapier();

/** How a table gets its crates: one every `dropsPerCrate` coin drops, or kept at `keep`. */
type CratePlan =
  | { readonly kind: 'none' }
  | { readonly kind: 'spawn'; readonly dropsPerCrate: number }
  | { readonly kind: 'keep'; readonly keep: number };

interface Measured {
  ticks: number;
  minCoins: number;
  maxSleeping: number;
  crateDrops: number;
  maxCrates: number;
}

function playedTable(plan: CratePlan): {
  step: () => void;
  table: PusherTable;
  crateDrops: () => number;
} {
  const world = new rapier.World(GRAVITY);
  configureTableWorld(world);
  const table = new PusherTable(rapier, world);
  const rng = Xoshiro128ss.fromSeed(0xbe7c4);
  let tick = 0;
  let coinDrops = 0;
  let crateDrops = 0;
  const dropCrate = (): void => {
    table.dropCrate((rng.nextInt(241) - 120) / 1000, rng);
    crateDrops += 1;
  };
  const step = (): void => {
    if (table.coinCount < TARGET_COINS) {
      table.dropCoin((rng.nextInt(301) - 150) / 1000, rng);
      coinDrops += 1;
      if (plan.kind === 'spawn' && coinDrops % plan.dropsPerCrate === 0) {
        dropCrate();
      }
    }
    if (plan.kind === 'keep' && table.crateCount < plan.keep) {
      dropCrate();
    }
    tick += 1;
    table.step(tick);
  };
  for (let i = 0; i < WARMUP_TICKS; i++) {
    step();
  }
  return { step, table, crateDrops: () => crateDrops };
}

function measure(plan: CratePlan): { measuredStep: () => void; measured: Measured } {
  const { step, table, crateDrops } = playedTable(plan);
  const dropsBefore = crateDrops();
  const measured: Measured = {
    ticks: 0,
    minCoins: Number.POSITIVE_INFINITY,
    maxSleeping: 0,
    crateDrops: 0,
    maxCrates: 0,
  };
  const countSleeping = (): void => {
    const sleeping = table.coins().filter((c) => c.sleeping).length;
    measured.maxSleeping = Math.max(measured.maxSleeping, sleeping);
  };
  const measuredStep = (): void => {
    step();
    measured.ticks += 1;
    measured.minCoins = Math.min(measured.minCoins, table.coinCount);
    measured.crateDrops = crateDrops() - dropsBefore;
    measured.maxCrates = Math.max(measured.maxCrates, table.crateCount);
    if (measured.ticks % TICK_RATE_HZ === 0) {
      // tinybench stops the clock when this synchronous call returns, so the count
      // runs untimed in a microtask before the next sample starts.
      queueMicrotask(countSleeping);
    }
  };
  return { measuredStep, measured };
}

const plain = measure({ kind: 'none' });
const spawned = measure({ kind: 'spawn', dropsPerCrate: crateSpawn.dropsPerCrate });
const stressed = measure({ kind: 'keep', keep: STRESS_CRATES });

afterAll(() => {
  for (const [name, { measured }] of [
    ['no crates', plain],
    [`a crate every ${crateSpawn.dropsPerCrate} drops`, spawned],
    [`${STRESS_CRATES} crates kept`, stressed],
  ] as const) {
    const { ticks, minCoins, maxSleeping, crateDrops, maxCrates } = measured;
    console.info(
      `${name}: measured ${ticks} ticks: at least ${minCoins} coins, ` +
        `at most ${maxSleeping} sleeping (sampled once a second), ` +
        `${crateDrops} crates dropped, at most ${maxCrates} on the table`,
    );
  }
});

describe(`PusherTable, ${TARGET_COINS} coins`, () => {
  bench('one 60 Hz tick', plain.measuredStep, { time: 5000, warmupTime: 500 });
  bench(`one 60 Hz tick, a crate every ${crateSpawn.dropsPerCrate} drops`, spawned.measuredStep, {
    time: 5000,
    warmupTime: 500,
  });
  bench(`one 60 Hz tick, ${STRESS_CRATES} crates kept`, stressed.measuredStep, {
    time: 5000,
    warmupTime: 500,
  });
});
