import { afterAll, bench, describe } from 'vitest';
import { GRAVITY, TICK_RATE_HZ } from '../constants.ts';
import { Xoshiro128ss } from '../prng.ts';
import { loadRapier } from '../rapier.ts';
import { PusherTable } from '../table/table.ts';
import { configureTableWorld } from '../table/tuning.ts';
import { CoinContactFinder, NO_GROUP } from './contacts.ts';
import { ContactFusion } from './fusion.ts';
import { FUSION_TUNING } from './tuning.ts';

/**
 * Budget: the mechanics share the table's 4 ms tick with 250 coins. Run with
 * `pnpm --filter @coinposh/sim exec vitest bench --run src/mechanics`.
 *
 * The table is filled by playing, as in table.bench.ts, and every coin is copper, the
 * worst case: every contact on the table is a same-tier contact to find and time.
 * Fusions are reported but not applied (PusherTable cannot remove coins yet), so the
 * piles stay ripe and the walk over them runs every tick, where a real table would
 * have fused them away. The tower is left out: its step is one distance check per
 * coin.
 *
 * Measured with the table at about 510 same-tier contacts and 70 ripe groups a tick:
 * the table alone 3.03 ms mean, 3.75 ms p99; with the mechanics 3.66 ms mean, 4.55 ms
 * p99. So the mechanics add about 0.6 ms a tick in this worst case, about 0.3 ms with
 * the poses held still (the bookkeeping, without fresh distance queries). The mean
 * holds the 4 ms budget, the slowest percent does not: the table alone leaves 0.25 ms
 * at p99. A table that fuses its piles away carries a fraction of these contacts.
 */
const TARGET_COINS = 250;
const WARMUP_TICKS = 45 * TICK_RATE_HZ;

const rapier = await loadRapier();
const world = new rapier.World(GRAVITY);
configureTableWorld(world);
const table = new PusherTable(rapier, world);
const rng = Xoshiro128ss.fromSeed(0xbe7c4);
const live = new Set<number>();
const contacts = new CoinContactFinder(rapier, FUSION_TUNING.touchGap);
const fusion = new ContactFusion({ inputCount: 3, contactSeconds: 0.4 }, FUSION_TUNING.graceTicks);
let tick = 0;
const measured = { samples: 0, pairs: 0, ripe: 0 };

function stepTable(): void {
  if (table.coinCount < TARGET_COINS) {
    live.add(table.dropCoin((rng.nextInt(301) - 150) / 1000, rng));
  }
  tick += 1;
  for (const { coinId } of table.step(tick)) {
    live.delete(coinId);
  }
}

function stepMechanics(): void {
  const coins = table.coins();
  const groups = new Int32Array(coins.length);
  coins.forEach(({ id }, i) => {
    groups[i] = live.has(id) ? 0 : NO_GROUP;
  });
  const touching = contacts.find(coins, groups);
  measured.ripe += fusion.update(tick, touching).length;
  measured.pairs += touching.length;
  measured.samples += 1;
}

for (let i = 0; i < WARMUP_TICKS; i++) {
  stepTable();
  stepMechanics();
}
measured.samples = measured.pairs = measured.ripe = 0;

afterAll(() => {
  const { samples, pairs, ripe } = measured;
  console.info(
    `measured ${samples} mechanics steps at ${table.coinCount} coins: ` +
      `${(pairs / Math.max(1, samples)).toFixed(1)} same-tier contacts and ` +
      `${(ripe / Math.max(1, samples)).toFixed(2)} ripe groups per step`,
  );
  world.free();
});

describe(`mechanics, ${TARGET_COINS} coins`, () => {
  bench('table tick alone, for comparison', stepTable, { time: 5000, warmupTime: 500 });
  bench(
    'table tick, then contact finding and fusion clock',
    () => {
      stepTable();
      stepMechanics();
    },
    { time: 5000, warmupTime: 500 },
  );
  bench(
    'contact finding and fusion clock alone, on a full table',
    () => {
      tick += 1;
      stepMechanics();
    },
    { time: 3000, warmupTime: 300 },
  );
});
