import { parseArgs } from 'node:util';
import { economyConfig } from '../src/config/index.ts';
import { assertValidEconomyConfig } from '../src/validate.ts';
import { buildEnvelopeTable } from './envelopeTable.ts';
import { simModel, type SimModel } from './model.ts';
import { formatSummary } from './report.ts';
import { runSimulation } from './simulate.ts';

export const USAGE = `Usage: pnpm --filter economy sim [--days N] [--players N] [--seed N] [--json] [--strict]
                                [--envelope] [--empty-table] [--return-ratio X]

  --days          casual calendar days to simulate (default 7)
  --players       simulated players per cohort (default 100)
  --seed          PRNG seed; the same seed always gives the same report (default 1)
  --json          print the raw result as JSON instead of the summary
  --strict        exit with code 1 when any pacing or FTUE target misses
  --envelope      print the server rate-envelope table (JSON) the sim's tables need
  --empty-table   what-if: the table starts with no coins on it instead of a seeded pile
  --return-ratio  what-if: front-edge value per coin dropped (shipped model: ${simModel.baseReturnRatio})`;

export interface CliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

function parseInteger(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new RangeError(`--${name} expects an integer, got "${raw}"`);
  return value;
}

function parsePositive(name: string, raw: string): number {
  const value = Number(raw);
  if (!(Number.isFinite(value) && value > 0)) {
    throw new RangeError(`--${name} expects a positive number, got "${raw}"`);
  }
  return value;
}

function finiteJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, v: unknown) => (typeof v === 'number' && !Number.isFinite(v) ? null : v),
    2,
  );
}

function run(argv: readonly string[], io: CliIo): number {
  const { values } = parseArgs({
    args: argv.filter((arg) => arg !== '--'),
    options: {
      days: { type: 'string', default: '7' },
      players: { type: 'string', default: '100' },
      seed: { type: 'string', default: '1' },
      json: { type: 'boolean', default: false },
      strict: { type: 'boolean', default: false },
      envelope: { type: 'boolean', default: false },
      'empty-table': { type: 'boolean', default: false },
      'return-ratio': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  if (values.help) {
    io.out(USAGE);
    return 0;
  }

  assertValidEconomyConfig(economyConfig);
  const seed = parseInteger('seed', values.seed);
  const model: SimModel = {
    ...simModel,
    baseReturnRatio:
      values['return-ratio'] === undefined
        ? simModel.baseReturnRatio
        : parsePositive('return-ratio', values['return-ratio']),
    pile: values['empty-table'] ? { ...simModel.pile, startingCoins: 0 } : simModel.pile,
  };

  if (values.envelope) {
    io.out(finiteJson(buildEnvelopeTable(economyConfig, model, seed)));
    return 0;
  }

  const result = runSimulation(economyConfig, model, {
    days: parseInteger('days', values.days),
    players: parseInteger('players', values.players),
    seed,
  });
  io.out(values.json ? finiteJson(result) : formatSummary(result));
  const missed = [...result.targets, ...result.ftue].some((t) => !t.pass);
  return values.strict && missed ? 1 : 0;
}

/** Runs the CLI and returns its exit code: 0 ok, 1 a --strict target missed, 2 bad usage. */
export function runCli(argv: readonly string[], io: CliIo): number {
  try {
    return run(argv, io);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(`\n${USAGE}`);
    return 2;
  }
}

if (import.meta.main) {
  process.exitCode = runCli(process.argv.slice(2), {
    out: (text) => {
      console.info(text);
    },
    err: (text) => {
      console.error(text);
    },
  });
}
