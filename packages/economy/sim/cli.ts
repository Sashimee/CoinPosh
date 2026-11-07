import { parseArgs } from 'node:util';
import { economyConfig } from '../src/config/index.ts';
import { assertValidEconomyConfig } from '../src/validate.ts';
import { simModel } from './model.ts';
import { formatSummary } from './report.ts';
import { runSimulation } from './simulate.ts';

const USAGE = `Usage: pnpm --filter economy sim [--days N] [--players N] [--seed N] [--json] [--strict]

  --days     casual calendar days to simulate (default 7)
  --players  simulated players per cohort (default 100)
  --seed     PRNG seed; the same seed always gives the same report (default 1)
  --json     print the raw result as JSON instead of the summary
  --strict   exit with code 1 when any pacing target misses`;

function parseInteger(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new RangeError(`--${name} expects an integer, got "${raw}"`);
  return value;
}

function main(argv: readonly string[]): number {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      days: { type: 'string', default: '7' },
      players: { type: 'string', default: '100' },
      seed: { type: 'string', default: '1' },
      json: { type: 'boolean', default: false },
      strict: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.info(USAGE);
    return 0;
  }

  assertValidEconomyConfig(economyConfig);
  const result = runSimulation(economyConfig, simModel, {
    days: parseInteger('days', values.days),
    players: parseInteger('players', values.players),
    seed: parseInteger('seed', values.seed),
  });

  console.info(
    values.json
      ? JSON.stringify(
          result,
          (_key, v: unknown) => (typeof v === 'number' && !Number.isFinite(v) ? null : v),
          2,
        )
      : formatSummary(result),
  );
  return values.strict && result.targets.some((t) => !t.pass) ? 1 : 0;
}

try {
  process.exitCode = main(process.argv.slice(2).filter((arg) => arg !== '--'));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  console.error(`\n${USAGE}`);
  process.exitCode = 2;
}
