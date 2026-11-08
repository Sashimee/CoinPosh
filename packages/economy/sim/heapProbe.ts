import { parseArgs } from 'node:util';
import { COIN_TIERS } from '@coinposh/shared';
// packages/economy does not depend on packages/sim; the probe reaches it by path so the
// economy package stays free of the physics engine outside this measuring tool.
import { Sim } from '../../sim/src/index.ts';
import { economyConfig } from '../src/config/index.ts';
import { cascadeTierFor } from '../src/formulas.ts';
import type { CoinTierId, OpeningHeapConfig } from '../src/types.ts';

/**
 * Plays the first minutes of a fresh profile on packages/sim's table the way Demo Mode does:
 * the game worker's mechanics (tiers, no fusion, no tower), the opening heap laid at the
 * brink, one copper drop per tap paid from the Vault, and every front fall credited at its
 * tier's face value times the cascade multiplier the mock server applies. It does not apply
 * the server's fall envelope or buy anything, so the Vault it reports is "before purchases".
 */
export interface HeapProbeOptions {
  readonly heap: OpeningHeapConfig;
  readonly seed: number;
  /** Fixed ticks (60 Hz) between taps: 30 is the playtest's one tap every 0.5 s. */
  readonly tapEveryTicks: number;
  readonly seconds: number;
  /** Lateral drop position in millimetres from the centre line. */
  readonly xMm: number;
}

export interface HeapProbeRun {
  readonly seed: number;
  readonly drops: number;
  /** Drops paid before the first coin left the front edge; null when none did. */
  readonly firstFallAfterDrops: number | null;
  /** Seconds until the Vault first held the cheapest venue upgrade's cost; null when never. */
  readonly firstUpgradeAffordableSeconds: number | null;
  /** Vault gain in each whole minute probed. */
  readonly minuteGains: readonly number[];
  /** Heap coins that left the front edge in each whole minute probed. */
  readonly minuteHeapFalls: readonly number[];
  /** Drops paid in each whole minute probed. */
  readonly minuteDrops: readonly number[];
  readonly heapPaid: number;
  readonly vault: number;
}

const TICK_HZ = 60;
const DROP_TIER: CoinTierId = 'copper';

function tierValue(tier: string): number {
  const def = economyConfig.coinTiers.find((t) => t.id === tier);
  if (def === undefined) throw new Error(`heapProbe: tier "${tier}" missing from economy config`);
  return def.value;
}

function startingCoins(): number {
  const line = economyConfig.upgradeLines.find((l) => l.effect.stat === 'startingCoins');
  if (line === undefined) throw new Error('heapProbe: no upgrade line sets startingCoins');
  return line.effect.base;
}

function cheapestVenueUpgrade(): number {
  const costs = economyConfig.upgradeLines
    .filter((l) => l.scope === 'venue')
    .map((l) => l.baseCost);
  if (costs.length === 0) throw new Error('heapProbe: no venue upgrade is bought with coins');
  return Math.min(...costs);
}

export async function probeHeap(options: HeapProbeOptions): Promise<HeapProbeRun> {
  const { heap, seed, tapEveryTicks, seconds, xMm } = options;
  const sim = await Sim.create({
    seed,
    mechanics: { tiers: COIN_TIERS, fusion: null, tower: null },
    ...(heap.coins > 0 ? { openingHeap: { coins: heap.coins, tier: heap.tier } } : {}),
  });
  try {
    const heapIds = new Set(sim.coins().map((coin) => coin.id));
    const cost = cheapestVenueUpgrade();
    const windowTicks = Math.round((economyConfig.cascade.windowMs / 1000) * TICK_HZ);
    let vault = startingCoins();
    let drops = 0;
    let heapPaid = 0;
    let firstFallAfterDrops: number | null = null;
    let affordable: number | null = vault >= cost ? 0 : null;
    let chain: { lastTick: number; count: number } | null = null;
    const minuteGains: number[] = [];
    const minuteHeapFalls: number[] = [];
    const minuteDrops: number[] = [];
    let minuteStart = { vault, heapFalls: 0, drops: 0 };
    let heapFalls = 0;
    for (let tick = 1; tick <= seconds * TICK_HZ; tick += 1) {
      const tap = tick % tapEveryTicks === 0 && vault >= tierValue(DROP_TIER);
      if (tap) {
        vault -= tierValue(DROP_TIER);
        drops += 1;
      }
      const { falls } = sim.step(tap ? [{ kind: 'dropCoin', xMm, tier: DROP_TIER }] : []);
      for (const fall of falls) {
        if (fall.edge !== 'front') continue;
        firstFallAfterDrops ??= drops;
        const count: number =
          chain !== null && fall.tick - chain.lastTick <= windowTicks ? chain.count + 1 : 1;
        chain = { lastTick: fall.tick, count };
        const fromHeap = heapIds.has(fall.coinId);
        const tier = fromHeap ? heap.tier : DROP_TIER;
        const credited = Math.floor(
          tierValue(tier) * (cascadeTierFor(count, economyConfig.cascade)?.multiplier ?? 1),
        );
        if (fromHeap) {
          heapPaid += credited;
          heapFalls += 1;
        }
        vault += credited;
      }
      if (affordable === null && vault >= cost) affordable = tick / TICK_HZ;
      if (tick % (60 * TICK_HZ) === 0) {
        minuteGains.push(vault - minuteStart.vault);
        minuteHeapFalls.push(heapFalls - minuteStart.heapFalls);
        minuteDrops.push(drops - minuteStart.drops);
        minuteStart = { vault, heapFalls, drops };
      }
    }
    return {
      seed,
      drops,
      firstFallAfterDrops,
      firstUpgradeAffordableSeconds: affordable,
      minuteGains,
      minuteHeapFalls,
      minuteDrops,
      heapPaid,
      vault,
    };
  } finally {
    sim.dispose();
  }
}

export const PROBE_USAGE = `Usage: node sim/heapProbe.ts [--heap-coins N] [--heap-tier T] [--seeds A-B]
                           [--tap-every TICKS] [--seconds S] [--x-mm MM]

  Defaults: the shipped opening heap, seeds 1-10, one tap every 30 ticks (0.5 s, the
  playtest cadence), 150 s, centre drops. Use --tap-every 75 for the sim's 0.8 drops/s.`;

function formatRun(run: HeapProbeRun): string {
  const ratio =
    run.minuteGains.length >= 2 && (run.minuteGains[0] ?? 0) > 0
      ? `×${((run.minuteGains[1] ?? 0) / (run.minuteGains[0] ?? 1)).toFixed(2)}`
      : '—';
  const affordable =
    run.firstUpgradeAffordableSeconds === null
      ? 'never'
      : `${run.firstUpgradeAffordableSeconds.toFixed(1)} s`;
  return [
    `seed ${run.seed}`,
    `first fall after ${run.firstFallAfterDrops ?? '—'} drops`,
    `upgrade affordable ${affordable}`,
    `minute gains ${run.minuteGains.map((g) => (g >= 0 ? `+${g}` : `${g}`)).join(' ')}`,
    `m2/m1 ${ratio}`,
    `heap falls/min ${run.minuteHeapFalls.join(' ')}`,
    `drops/min ${run.minuteDrops.join(' ')}`,
    `heap paid ${run.heapPaid}`,
    `Vault ${run.vault}`,
  ].join(' · ');
}

function parseSeeds(raw: string): number[] {
  const match = /^(\d+)(?:-(\d+))?$/.exec(raw);
  if (match === null) throw new RangeError(`--seeds expects N or A-B, got "${raw}"`);
  const from = Number(match[1]);
  const to = Number(match[2] ?? match[1]);
  if (to < from) throw new RangeError(`--seeds range must ascend, got "${raw}"`);
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

function parseWhole(name: string, raw: string): number {
  const value = Number(raw);
  if (!(raw.trim() !== '' && Number.isInteger(value) && value >= 0)) {
    throw new RangeError(`--${name} expects a whole number ≥ 0, got "${raw}"`);
  }
  return value;
}

async function main(argv: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv.filter((arg) => arg !== '--'),
    options: {
      'heap-coins': { type: 'string', default: String(economyConfig.openingHeap.coins) },
      'heap-tier': { type: 'string', default: economyConfig.openingHeap.tier },
      seeds: { type: 'string', default: '1-10' },
      'tap-every': { type: 'string', default: '30' },
      seconds: { type: 'string', default: '150' },
      'x-mm': { type: 'string', default: '0' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.info(PROBE_USAGE);
    return;
  }
  const tier = economyConfig.coinTiers.find((t) => t.id === values['heap-tier']);
  if (tier === undefined)
    throw new RangeError(`--heap-tier: unknown tier "${values['heap-tier']}"`);
  const tapEveryTicks = parseWhole('tap-every', values['tap-every']);
  if (tapEveryTicks === 0) throw new RangeError('--tap-every must be at least 1 tick');
  const heap = { coins: parseWhole('heap-coins', values['heap-coins']), tier: tier.id };
  console.info(
    `heap ${heap.coins} ${heap.tier} · tap every ${tapEveryTicks} ticks · ${values.seconds} s · x ${values['x-mm']} mm`,
  );
  for (const seed of parseSeeds(values.seeds)) {
    const run = await probeHeap({
      heap,
      seed,
      tapEveryTicks,
      seconds: parseWhole('seconds', values.seconds),
      xMm: Number.parseInt(values['x-mm'], 10),
    });
    console.info(formatRun(run));
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`\n${PROBE_USAGE}`);
    process.exitCode = 2;
  });
}
