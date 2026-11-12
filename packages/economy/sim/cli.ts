import { parseArgs } from 'node:util';
import { economyConfig } from '../src/config/index.ts';
import type { CoinTierId, EconomyConfig } from '../src/types.ts';
import { assertValidEconomyConfig } from '../src/validate.ts';
import { buildEnvelopeTable } from './envelopeTable.ts';
import { simModel, type SimModel } from './model.ts';
import { evaluateLadder, pacingAcrossStyles } from './ladder.ts';
import { formatLadder, formatStylePacing, formatSummary } from './report.ts';
import { runSimulation } from './simulate.ts';

export const USAGE = `Usage: pnpm --filter economy sim [--days N] [--players N] [--seed N] [--json] [--strict]
                                [--envelope] [--empty-table] [--heap-coins N]
                                [--heap-tier T] [--return-ratio X] [--fusion-share X]
                                [--ladder]

  --days          casual calendar days to simulate (default 7)
  --players       simulated players per cohort (default 100)
  --seed          PRNG seed; the same seed always gives the same report (default 1)
  --json          print the raw result as JSON instead of the summary
  --strict        exit with code 1 when any pacing or FTUE target misses (ladder too with --ladder)
  --envelope      print the server rate-envelope table (JSON) the sim's tables need
  --empty-table   what-if: the table starts with no coins on it (same as --heap-coins 0)
  --heap-coins    what-if: opening-heap coins instead of the shipped ${economyConfig.openingHeap.coins}
  --heap-tier     what-if: opening-heap coin tier instead of the shipped ${economyConfig.openingHeap.tier}
  --return-ratio  what-if: front-edge value per coin dropped (shipped model: ${simModel.baseReturnRatio})
  --fusion-share  what-if: share of returned value fused at fusionWindow 1 (shipped model: ${simModel.fusionShare})
  --ladder        print fusion tier-creation times per play style (physics-measured) against the ladder targets,
                  and the pacing targets rerun with each cadence style's measured fusionShare`;

export interface CliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

function parseInteger(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new RangeError(`--${name} expects an integer, got "${raw}"`);
  return value;
}

function parseNonNegative(name: string, raw: string): number {
  const value = Number(raw);
  if (!(raw.trim() !== '' && Number.isInteger(value) && value >= 0)) {
    throw new RangeError(`--${name} expects a whole number ≥ 0, got "${raw}"`);
  }
  return value;
}

function parseTier(raw: string): CoinTierId {
  const tier = economyConfig.coinTiers.find((t) => t.id === raw);
  if (tier === undefined) {
    const ids = economyConfig.coinTiers.map((t) => t.id).join(', ');
    throw new RangeError(`--heap-tier expects one of ${ids}, got "${raw}"`);
  }
  return tier.id;
}

function parsePositive(name: string, raw: string): number {
  const value = Number(raw);
  if (!(Number.isFinite(value) && value > 0)) {
    throw new RangeError(`--${name} expects a positive number, got "${raw}"`);
  }
  return value;
}

function parseShare(name: string, raw: string): number {
  const value = Number(raw);
  if (!(raw.trim() !== '' && Number.isFinite(value) && value >= 0 && value <= 1)) {
    throw new RangeError(`--${name} expects a share in [0, 1], got "${raw}"`);
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
      'heap-coins': { type: 'string' },
      'heap-tier': { type: 'string' },
      'return-ratio': { type: 'string' },
      'fusion-share': { type: 'string' },
      ladder: { type: 'boolean', default: false },
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
    fusionShare:
      values['fusion-share'] === undefined
        ? simModel.fusionShare
        : parseShare('fusion-share', values['fusion-share']),
  };
  const heapCoins = values['empty-table']
    ? 0
    : values['heap-coins'] === undefined
      ? economyConfig.openingHeap.coins
      : parseNonNegative('heap-coins', values['heap-coins']);
  const config: EconomyConfig = {
    ...economyConfig,
    openingHeap: {
      coins: heapCoins,
      tier:
        values['heap-tier'] === undefined
          ? economyConfig.openingHeap.tier
          : parseTier(values['heap-tier']),
    },
  };

  if (values.envelope) {
    io.out(finiteJson(buildEnvelopeTable(config, model, seed)));
    return 0;
  }

  const options = {
    days: parseInteger('days', values.days),
    players: parseInteger('players', values.players),
    seed,
  };
  const result = runSimulation(config, model, options);
  const ladder = values.ladder ? evaluateLadder(model, config.fusion.bonusMultiplier) : null;
  const pacing = values.ladder ? pacingAcrossStyles(config, model, options) : null;
  io.out(
    values.json
      ? finiteJson(ladder === null ? result : { ...result, ladder, pacing })
      : [
          formatSummary(result),
          ...(ladder === null ? [] : ['', formatLadder(ladder)]),
          ...(pacing === null ? [] : ['', formatStylePacing(pacing)]),
        ].join('\n'),
  );
  const missed = [
    ...result.targets,
    ...result.ftue,
    ...(ladder?.targets ?? []),
    ...(pacing ?? []).flatMap((p) => p.targets),
  ].some((t) => !t.pass);
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
