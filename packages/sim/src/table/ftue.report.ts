import { ftueFirstCredit } from '@coinposh/economy';
import { TICK_RATE_HZ } from '../constants.ts';
import {
  FTUE_SEEDS,
  type Opening,
  playOpenings,
  TAP_BANDS_PX,
  type TapBand,
} from './ftue.harness.ts';

/**
 * The 02-ECONOMY "First credit" table: every FTUE_SEEDS table, with centre taps and with taps
 * anywhere, at ftueFirstCredit.tapsPerSecond. Run with
 * `node packages/sim/src/table/ftue.report.ts` from the repo root (about 15 s).
 */

const intervalTicks = TICK_RATE_HZ / ftueFirstCredit.tapsPerSecond;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  const middle = sorted.slice(Math.ceil(mid) - 1, Math.floor(mid) + 1);
  return middle.reduce((sum, value) => sum + value, 0) / middle.length;
}

function row(band: TapBand, runs: readonly Opening[]): string {
  const drops = runs.map((run) => run.drops);
  const seconds = runs.map((run) => (run.ticksAfterFirstTap ?? Number.NaN) / TICK_RATE_HZ);
  const [minPx, maxPx] = TAP_BANDS_PX[band];
  const cells = [
    `${ftueFirstCredit.tapsPerSecond}/s`,
    `${band} (${minPx}–${maxPx} px)`,
    `${Math.min(...drops)} / ${median(drops)} / ${Math.max(...drops)}`,
    `${Math.min(...seconds).toFixed(2)}–${Math.max(...seconds).toFixed(2)} s`,
    `${Math.min(...runs.map((run) => run.minVault))}`,
    `${runs.filter((run) => run.minVault < ftueFirstCredit.minVault).length} / ${runs.filter((run) => run.minVault === 0).length}`,
    `${runs.filter((run) => run.refusedTaps > 0).length} (max ${Math.max(...runs.map((run) => run.refusedTaps))})`,
    `${runs.filter((run) => run.allowance > 0).length}`,
    `${runs.filter((run) => run.drops <= ftueFirstCredit.maxDrops && run.minVault >= ftueFirstCredit.minVault).length} of ${runs.length}`,
  ];
  return `| ${cells.join(' | ')} |`;
}

const lines = [
  '| Taps | Aim | Drops to first credit (min / median / max) | First tap to credit | Lowest Vault | Runs with Vault < 8 / at 0 | Runs with taps refused at 0 (most taps) | Runs the allowance paid | Runs meeting P-436 |',
  '|---|---|---|---|---|---|---|---|---|',
];
for (const band of Object.keys(TAP_BANDS_PX) as TapBand[]) {
  const runs = await playOpenings(FTUE_SEEDS.map((seed) => ({ seed, intervalTicks, band })));
  lines.push(row(band, runs));
}
console.info(lines.join('\n'));
