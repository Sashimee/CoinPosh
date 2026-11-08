import { afterAll, bench, describe } from 'vitest';
import { GRAVITY, TICK_RATE_HZ } from '../constants.ts';
import { Xoshiro128ss } from '../prng.ts';
import { loadRapier } from '../rapier.ts';
import { PusherTable, type TableCoin } from '../table/table.ts';
import { configureTableWorld } from '../table/tuning.ts';
import { CoinContactFinder, NO_GROUP } from './contacts.ts';
import { ContactFusion } from './fusion.ts';
import type { MechanicTable } from './table.ts';
import { ChampagneTower } from './tower.ts';
import { FUSION_TUNING } from './tuning.ts';

/**
 * Budget: the mechanics share the table's 4 ms tick with 250 coins, at the 99th
 * percentile as well as on average. Run with
 * `pnpm --filter @coinposh/sim exec vitest bench --run src/mechanics`.
 *
 * The table is a real PusherTable with the tower's pedestal in its world, filled by
 * playing as in table.bench.ts, and every coin is copper, the worst case: every
 * contact on the table is a same-tier contact to find and time. Each mechanics step
 * reads the coins, finds the slice of contacts due this tick, runs the fusion clock
 * and steps the ChampagneTower, which is what TableMechanics.step does.
 *
 * The bench takes no coin off the table, so the pile stays at the worst-case density
 * it is meant to measure; a bench that applies fusions and captures through
 * PusherTable.removeCoin, as TableMechanics does, is P-79. Here:
 *
 * - A fusion is applied to the clock, not to the table: the clock forgets its coins'
 *   contacts, as TableMechanics does, but the coins stay where they are, all copper,
 *   so their contacts start again at once, as if a new pile of the tier had formed in
 *   the same place. The table stays at full same-tier density for the finder, and the
 *   clock fires fusions at the rate such piles would.
 * - A coin the tower captures is hidden from the mechanics instead of removed: its
 *   body stays in the world and the table keeps paying for it. So that hidden bodies
 *   do not end up inside a growing stack collider, which no real table would ever
 *   simulate, the stepped tower lives in a world of its own at the same placement,
 *   and the table's world holds a second, never stepped tower: the pedestal's
 *   physical cost on the table, and the tower's logic, are both measured as they are.
 *
 * Measured 2026-11-07 (Node, x86-64 dev machine), 250 coins, about 185 same-tier
 * contacts and 2.9 fusions per step: the mechanics alone take 0.19 ms mean and
 * 0.34 ms at p99; the table alone 3.00 ms mean and 4.07 ms at p99; table then
 * mechanics 3.33 ms mean and 4.36 ms at p99. The mean is inside the budget, the p99
 * is not, and the table's own p99 already is past it in this process, so the
 * headroom has to come from the table. The coin, contact and capture counts over the
 * measured steps are printed after the run, so the result always says what it measured.
 */
const TARGET_COINS = 250;
const WARMUP_TICKS = 45 * TICK_RATE_HZ;

const rapier = await loadRapier();
const world = new rapier.World(GRAVITY);
configureTableWorld(world);
const table = new PusherTable(rapier, world);
new ChampagneTower(rapier, world);
const towerWorld = new rapier.World(GRAVITY);
const tower = new ChampagneTower(rapier, towerWorld);
const rng = Xoshiro128ss.fromSeed(0xbe7c4);
const live = new Set<number>();
const hidden = new Set<number>();
const contacts = new CoinContactFinder(FUSION_TUNING.touchGap);
const fusion = new ContactFusion(
  { inputCount: 3, contactSeconds: 0.4 },
  FUSION_TUNING.graceTicks,
  FUSION_TUNING.sampleTicks,
);
let tick = 0;
const measured = { samples: 0, pairs: 0, fusions: 0, captures: 0, topples: 0 };

const towerTable: MechanicTable = {
  coins: (): TableCoin[] => table.coins().filter(({ id }) => !hidden.has(id)),
  addCoin: (translation, rotation) => {
    const id = table.addCoin(translation, rotation);
    live.add(id);
    return id;
  },
  removeCoin: (id) => {
    hidden.add(id);
    live.delete(id);
  },
};

function stepTable(): void {
  if (table.coinCount < TARGET_COINS) {
    live.add(table.dropCoin((rng.nextInt(301) - 150) / 1000, rng));
  }
  tick += 1;
  for (const { coinId } of table.step(tick)) {
    live.delete(coinId);
    hidden.delete(coinId);
  }
}

function stepMechanics(): void {
  const coins = towerTable.coins();
  const groups = new Int32Array(coins.length);
  coins.forEach(({ id }, i) => {
    groups[i] = live.has(id) ? 0 : NO_GROUP;
  });
  const touching = contacts.find(
    coins,
    groups,
    tick % FUSION_TUNING.sampleTicks,
    FUSION_TUNING.sampleTicks,
  );
  for (const ids of fusion.update(tick, touching)) {
    fusion.forget(ids);
    measured.fusions += 1;
  }
  const { captures, topple } = tower.step(tick, coins, () => 0, towerTable);
  measured.captures += captures.length;
  measured.topples += topple ? 1 : 0;
  measured.pairs += touching.length;
  measured.samples += 1;
}

for (let i = 0; i < WARMUP_TICKS; i++) {
  stepTable();
  stepMechanics();
}
measured.samples = measured.pairs = measured.fusions = measured.captures = measured.topples = 0;

afterAll(() => {
  const { samples, pairs, fusions, captures, topples } = measured;
  console.info(
    `measured ${samples} mechanics steps at ${table.coinCount} coins: ` +
      `${(pairs / Math.max(1, samples)).toFixed(1)} same-tier contacts and ` +
      `${(fusions / Math.max(1, samples)).toFixed(2)} fusions per step, ` +
      `${captures} tower captures and ${topples} topples`,
  );
  world.free();
  towerWorld.free();
});

describe(`mechanics, ${TARGET_COINS} coins`, () => {
  bench('table tick alone, for comparison', stepTable, { time: 5000, warmupTime: 500 });
  bench(
    'table tick, then the mechanics',
    () => {
      stepTable();
      stepMechanics();
    },
    { time: 5000, warmupTime: 500 },
  );
  bench(
    'the mechanics alone, on a full table',
    () => {
      tick += 1;
      stepMechanics();
    },
    { time: 3000, warmupTime: 300 },
  );
});
