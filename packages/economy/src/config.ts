import { upgradeLines, venues } from './config/index.ts';
import { upgradeStat } from './formulas.ts';
import type { ValidationIssue } from './validate.ts';
import {
  RATE_ENVELOPE_METRIC_IDS,
  UPGRADE_STAT_IDS,
  type EconomyConfig,
  type RateEnvelopeConfig,
  type RateEnvelopeDerivation,
  type RateEnvelopeLimit,
  type RateEnvelopeLimits,
  type RateEnvelopeMetricDef,
  type RateEnvelopeMetricId,
  type RateEnvelopeTable,
  type UpgradeLineDef,
  type UpgradeStatId,
} from './types.ts';

/**
 * Inputs to `rateEnvelope.test.ts`, which replays `sessions` honest sessions through the
 * economy sim's rates and this burst model, takes the 99.9th percentile of each session's
 * busiest window and multiplies it by `headroom`. The `max` values below are its output.
 * `fusions` also takes the busiest 60 s of the physics-measured ladder (sim/ladder.ts) for
 * every style up to `honestTapsPerSecond`, because the burst model only sees fused coins
 * that fall, not the merges that stay on the table.
 */
export const rateEnvelopeDerivation = {
  percentile: 99.9,
  headroom: 1.25,
  sessions: 3_000,
  seed: 0x5eed_e1e7,
  slotMs: 250,
  pourShare: 0.06,
  pourCadence: 8,
  meanPourSeconds: 2,
  tableLagSeconds: 4,
  obsceneMaxCoins: 40,
  looseMaxCoins: 2,
  crateFallSeconds: { min: 2, max: 90 },
  honestTapsPerSecond: 3,
} as const satisfies RateEnvelopeDerivation;

/**
 * Max plausible throughput per table configuration. Drops are capped (they cost the
 * player balance anyway); the other metrics are claims and flag the player past the limit.
 */
export const rateEnvelope = {
  drops: {
    windowMs: 10_000,
    max: 113,
    scaleBy: { dropRate: 1 },
    value: null,
  },
  falls: {
    windowMs: 30_000,
    max: 274,
    scaleBy: { dropRate: 1, pusherSpeed: 1 },
    value: null,
  },
  fallValue: {
    windowMs: 30_000,
    max: 517,
    // fusionWindow only lifts the fused share of value: 0.15 × 0.25 / (1 + 0.15 × 0.25).
    scaleBy: { dropRate: 1, pusherSpeed: 1, coinValue: 1, globalCoinValue: 1, fusionWindow: 0.037 },
    value: { perCharm: 0.06 },
  },
  fusions: {
    windowMs: 60_000,
    max: 127,
    scaleBy: { dropRate: 1, pusherSpeed: 1, fusionWindow: 1 },
    value: null,
  },
  crates: {
    windowMs: 300_000,
    max: 24,
    scaleBy: { dropRate: 1, crateChance: 1, globalCrateChance: 1 },
    value: null,
  },
} as const satisfies RateEnvelopeConfig;

export type RateEnvelopeSource = Pick<EconomyConfig, 'upgradeLines' | 'venues'> & {
  readonly rateEnvelope: RateEnvelopeConfig;
};

const shipped: RateEnvelopeSource = { upgradeLines, venues, rateEnvelope };

function assertTable(table: RateEnvelopeTable, source: RateEnvelopeSource): void {
  for (const [id, level] of Object.entries(table.levels)) {
    const line = source.upgradeLines.find((l) => l.id === id);
    if (line === undefined) {
      throw new RangeError(`rateEnvelopeFor: unknown upgrade line "${id}".`);
    }
    if (!Number.isInteger(level) || level < 0 || level > line.maxLevel) {
      throw new RangeError(
        `rateEnvelopeFor: "${id}" level must be an integer in [0, ${line.maxLevel}], got ${level}.`,
      );
    }
  }
  if (!Number.isInteger(table.charms) || table.charms < 0) {
    throw new RangeError(
      `rateEnvelopeFor: charms must be a non-negative integer, got ${table.charms}.`,
    );
  }
  if (!Number.isFinite(table.albumBonus) || table.albumBonus < 0) {
    throw new RangeError(
      `rateEnvelopeFor: albumBonus must be a finite number ≥ 0, got ${table.albumBonus}.`,
    );
  }
}

function statRatio(
  lines: readonly UpgradeLineDef[],
  table: RateEnvelopeTable,
  stat: UpgradeStatId,
): number {
  const line = lines.find((l) => l.effect.stat === stat);
  if (line === undefined) return 1;
  return upgradeStat(line, table.levels[line.id] ?? 0) / line.effect.base;
}

/** How far this table stretches one metric's base `max` (always ≥ 1). */
export function rateEnvelopeScale(
  def: RateEnvelopeMetricDef,
  table: RateEnvelopeTable,
  source: RateEnvelopeSource = shipped,
): number {
  assertTable(table, source);
  let scale = 1;
  for (const [stat, weight] of Object.entries(def.scaleBy) as [UpgradeStatId, number][]) {
    scale *= 1 + weight * (statRatio(source.upgradeLines, table, stat) - 1);
  }
  if (def.value !== null) {
    const venue = source.venues.find((v) => v.id === table.venue);
    if (venue === undefined)
      throw new RangeError(`rateEnvelopeFor: unknown venue "${table.venue}".`);
    const slotted = Math.min(table.charms, venue.charmSockets);
    scale *=
      venue.coinValueMultiplier * (1 + slotted * def.value.perCharm) * (1 + table.albumBonus);
  }
  return scale;
}

/**
 * The limits the server's RateEnvelope enforces for one table configuration: each base
 * `max` stretched by the table's upgrades and rounded up to whole units.
 */
export function rateEnvelopeFor(
  table: RateEnvelopeTable,
  source: RateEnvelopeSource = shipped,
): RateEnvelopeLimits {
  const limit = (metric: RateEnvelopeMetricId): RateEnvelopeLimit => {
    const def = source.rateEnvelope[metric];
    // Float products like 100 × 1.2 land a hair above the integer; that must not cost a unit.
    const max = Math.ceil(def.max * rateEnvelopeScale(def, table, source) - 1e-9);
    return { windowMs: def.windowMs, max };
  };
  return {
    drops: limit('drops'),
    falls: limit('falls'),
    fallValue: limit('fallValue'),
    fusions: limit('fusions'),
    crates: limit('crates'),
  };
}

export function validateRateEnvelope(config: RateEnvelopeConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const report = (path: string, message: string): void => {
    issues.push({ path, message });
  };
  for (const metric of RATE_ENVELOPE_METRIC_IDS) {
    const path = `rateEnvelope.${metric}`;
    const def = config[metric];
    if (!Number.isSafeInteger(def.windowMs) || def.windowMs <= 0) {
      report(path, `windowMs must be a positive integer, got ${def.windowMs}`);
    }
    if (!Number.isSafeInteger(def.max) || def.max <= 0) {
      report(path, `max must be a positive integer, got ${def.max}`);
    }
    for (const [stat, weight] of Object.entries(def.scaleBy)) {
      if (!(UPGRADE_STAT_IDS as readonly string[]).includes(stat)) {
        report(path, `scaleBy names unknown stat "${stat}"`);
      }
      if (!(Number.isFinite(weight) && weight >= 0 && weight <= 1)) {
        report(path, `scaleBy.${stat} must be an elasticity in [0, 1], got ${weight}`);
      }
    }
    if (def.value !== null && !(Number.isFinite(def.value.perCharm) && def.value.perCharm >= 0)) {
      report(path, `value.perCharm must be ≥ 0, got ${def.value.perCharm}`);
    }
  }
  for (const metric of Object.keys(config)) {
    if (!(RATE_ENVELOPE_METRIC_IDS as readonly string[]).includes(metric)) {
      report('rateEnvelope', `unknown metric "${metric}"`);
    }
  }
  return issues;
}
