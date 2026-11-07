import {
  AlbumSetIdSchema,
  CollectibleIdSchema,
  UpgradeLineIdSchema,
  VenueIdSchema,
} from '@coinposh/shared';
import { ODDS_SCALE, oddsTotal, weightToPercent } from './odds.ts';
import { rarityRank } from './pity.ts';
import {
  CASCADE_TIER_IDS,
  COIN_TIER_IDS,
  CURRENCY_IDS,
  DROP_SOURCE_IDS,
  PACING_TARGET_IDS,
  RARITY_IDS,
  VENUE_IDS,
  type EconomyConfig,
} from './types.ts';

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

type Report = (path: string, message: string) => void;

const isPositive = (n: number): boolean => Number.isFinite(n) && n > 0;
const isNonNegative = (n: number): boolean => Number.isFinite(n) && n >= 0;
const isPositiveInt = (n: number): boolean => Number.isInteger(n) && n > 0;

function checkIdsExactly(
  report: Report,
  path: string,
  actual: readonly string[],
  expected: readonly string[],
): void {
  const seen = new Set<string>();
  for (const id of actual) {
    if (seen.has(id)) report(path, `duplicate id "${id}"`);
    seen.add(id);
  }
  for (const id of expected) {
    if (!seen.has(id)) report(path, `missing "${id}"`);
  }
  for (const id of seen) {
    if (!expected.includes(id)) report(path, `unknown id "${id}"`);
  }
}

interface KeySchema {
  safeParse(key: string): { success: boolean };
}

// TODO(P-10): check generic keys with a CatalogKeySchema once @coinposh/shared exports one.
// Every catalog-key schema there applies the same pattern and 64-char cap today, so the
// upgrade-line schema stands in for keys that have no branded kind of their own.
const GENERIC_KEY: KeySchema = UpgradeLineIdSchema;

function checkKeys(config: EconomyConfig, report: Report): void {
  const check = (path: string, key: string, schema: KeySchema = GENERIC_KEY): void => {
    if (!schema.safeParse(key).success) {
      report(
        path,
        `key "${key}" must match ^[a-z][a-zA-Z0-9]*([-_.:][a-zA-Z0-9]+)*$ and be ≤ 64 characters`,
      );
    }
  };
  for (const [i, c] of config.currencies.entries()) {
    check(`currencies[${i}].id`, c.id);
    for (const [j, key] of c.sources.entries()) check(`currencies[${i}].sources[${j}]`, key);
    for (const [j, key] of c.sinks.entries()) check(`currencies[${i}].sinks[${j}]`, key);
  }
  for (const [i, t] of config.coinTiers.entries()) check(`coinTiers[${i}].id`, t.id);
  for (const [i, t] of config.cascade.tiers.entries()) check(`cascade.tiers[${i}].id`, t.id);
  for (const [i, line] of config.upgradeLines.entries()) {
    check(`upgradeLines[${i}].id`, line.id, UpgradeLineIdSchema);
    check(`upgradeLines[${i}].effect.stat`, line.effect.stat);
  }
  for (const [i, t] of config.dropTables.entries()) check(`dropTables[${i}].source`, t.source);
  for (const [i, v] of config.venues.entries()) check(`venues[${i}].id`, v.id, VenueIdSchema);
  for (const [i, set] of config.album.entries()) {
    check(`album[${i}].id`, set.id, AlbumSetIdSchema);
    for (const [j, item] of set.items.entries()) {
      check(`album[${i}].items[${j}].id`, item.id, CollectibleIdSchema);
    }
  }
  for (const [i, t] of config.pacing.entries()) check(`pacing[${i}].id`, t.id);
}

function checkCurrencies(config: EconomyConfig, report: Report): void {
  checkIdsExactly(
    report,
    'currencies',
    config.currencies.map((c) => c.id),
    CURRENCY_IDS,
  );
}

function checkCoins(config: EconomyConfig, report: Report): void {
  const { coinTiers, fusion, cascade } = config;
  checkIdsExactly(
    report,
    'coinTiers',
    coinTiers.map((t) => t.id),
    COIN_TIER_IDS,
  );
  coinTiers.forEach((tier, i) => {
    const path = `coinTiers[${i}] (${tier.id})`;
    if (!isPositive(tier.value)) report(path, `value must be > 0, got ${tier.value}`);
    const next = coinTiers[i + 1];
    if (next === undefined) {
      if (tier.fusesInto !== null) report(path, 'the top tier must not fuse into anything');
    } else {
      if (tier.fusesInto !== next.id) {
        report(path, `must fuse into the next tier "${next.id}", got "${String(tier.fusesInto)}"`);
      }
      if (!(next.value > tier.value)) report(path, `value must be below ${next.id}'s`);
    }
  });

  if (!isPositiveInt(fusion.inputCount) || fusion.inputCount < 2) {
    report('fusion.inputCount', `must be an integer ≥ 2, got ${fusion.inputCount}`);
  }
  if (!isPositive(fusion.contactSeconds)) report('fusion.contactSeconds', 'must be > 0');
  if (!(fusion.bonusMultiplier >= 1)) {
    report(
      'fusion.bonusMultiplier',
      `must be ≥ 1 (fusion never destroys value), got ${fusion.bonusMultiplier}`,
    );
  }

  if (!isPositive(cascade.windowMs)) report('cascade.windowMs', 'must be > 0');
  checkIdsExactly(
    report,
    'cascade.tiers',
    cascade.tiers.map((t) => t.id),
    CASCADE_TIER_IDS,
  );
  cascade.tiers.forEach((tier, i) => {
    const path = `cascade.tiers[${i}] (${tier.id})`;
    if (!isPositiveInt(tier.minCoins)) report(path, 'minCoins must be a positive integer');
    const prev = cascade.tiers[i - 1];
    const floorMultiplier = prev?.multiplier ?? 1;
    if (!(tier.multiplier > floorMultiplier)) {
      report(path, `multiplier must exceed ${floorMultiplier}, got ${tier.multiplier}`);
    }
    if (prev !== undefined && !(tier.minCoins > prev.minCoins)) {
      report(path, `minCoins must exceed ${prev.id}'s ${prev.minCoins}`);
    }
  });
}

function checkUpgrades(config: EconomyConfig, report: Report): void {
  const { upgradeCostRule: rule, upgradeLines, offline } = config;
  if (!(rule.minGrowth > 1 && rule.maxGrowth >= rule.minGrowth)) {
    report('upgradeCostRule', 'growth bounds must satisfy 1 < minGrowth ≤ maxGrowth');
  }
  const ids = new Set<string>();
  upgradeLines.forEach((line, i) => {
    const path = `upgradeLines[${i}] (${line.id})`;
    if (ids.has(line.id)) report(path, 'duplicate id');
    ids.add(line.id);
    if (!isPositive(line.baseCost)) report(path, `baseCost must be > 0, got ${line.baseCost}`);
    if (!(line.growth >= rule.minGrowth && line.growth <= rule.maxGrowth)) {
      report(path, `growth ${line.growth} is outside [${rule.minGrowth}, ${rule.maxGrowth}]`);
    }
    if (!isPositiveInt(line.maxLevel)) report(path, 'maxLevel must be a positive integer');
    if (!isNonNegative(line.effect.base)) report(path, 'effect.base must be ≥ 0');
    if (!isPositive(line.effect.perLevel)) report(path, 'effect.perLevel must be > 0');
    const expectedCurrency = line.scope === 'venue' ? 'coins' : 'goldBars';
    if (line.currency !== expectedCurrency) {
      report(path, `${line.scope} upgrades are paid in ${expectedCurrency}, got ${line.currency}`);
    }
  });

  const offlineLine = upgradeLines.find((line) => line.effect.stat === 'offlineHours');
  if (offlineLine === undefined) {
    report('upgradeLines', 'an offlineHours line is required');
  } else {
    const top = offlineLine.effect.base + offlineLine.effect.perLevel * offlineLine.maxLevel;
    if (offlineLine.effect.base !== offline.baseCapHours || top !== offline.maxCapHours) {
      report(
        `upgradeLines (${offlineLine.id})`,
        `must span offline cap ${offline.baseCapHours}–${offline.maxCapHours} h, spans ${offlineLine.effect.base}–${top} h`,
      );
    }
  }
}

function checkDrops(config: EconomyConfig, report: Report): void {
  const { dropTables, pity, crateSpawn, crateRewards } = config;
  checkIdsExactly(
    report,
    'dropTables',
    dropTables.map((t) => t.source),
    DROP_SOURCE_IDS,
  );
  for (const table of dropTables) {
    const path = `dropTables.${table.source}`;
    checkIdsExactly(report, `${path}.odds`, Object.keys(table.odds), RARITY_IDS);
    for (const rarity of RARITY_IDS) {
      const weight = table.odds[rarity];
      if (!Number.isInteger(weight) || weight < 0) {
        report(`${path}.odds.${rarity}`, `weight must be a non-negative integer, got ${weight}`);
      }
    }
    const total = oddsTotal(table.odds);
    if (total !== ODDS_SCALE) {
      report(`${path}.odds`, `odds sum to ${weightToPercent(total)} %, must be exactly 100 %`);
    }
    if (table.pity) {
      for (const rule of pity.rules) {
        const reachable = RARITY_IDS.filter((r) => rarityRank(r) >= rarityRank(rule.rarity)).some(
          (r) => table.odds[r] > 0,
        );
        if (!reachable) {
          report(path, `pity guarantees ${rule.rarity}+ but the table can never roll it`);
        }
      }
    }
  }

  pity.rules.forEach((rule, i) => {
    const path = `pity.rules[${i}] (${rule.rarity})`;
    if (!isPositiveInt(rule.within))
      report(path, `within must be a positive integer, got ${rule.within}`);
    const prev = pity.rules[i - 1];
    if (prev !== undefined) {
      if (!(rarityRank(rule.rarity) > rarityRank(prev.rarity))) {
        report(path, `rules must be ordered by ascending rarity (after ${prev.rarity})`);
      }
      if (!(rule.within > prev.within)) {
        report(
          path,
          `a rarer guarantee needs a longer window than ${prev.rarity}'s ${prev.within}`,
        );
      }
    }
  });

  if (!isPositive(crateSpawn.dropsPerCrate)) report('crateSpawn.dropsPerCrate', 'must be > 0');
  if (!isPositiveInt(crateSpawn.ftueScriptedDrop)) {
    report('crateSpawn.ftueScriptedDrop', 'must be a positive integer');
  }

  checkIdsExactly(report, 'crateRewards', Object.keys(crateRewards), RARITY_IDS);
  let previousIncome = -1;
  for (const rarity of RARITY_IDS) {
    const reward = crateRewards[rarity];
    const path = `crateRewards.${rarity}`;
    for (const key of ['incomeSeconds', 'pearls', 'keys', 'tickets'] as const) {
      if (!isNonNegative(reward[key])) report(`${path}.${key}`, 'must be ≥ 0');
    }
    if (
      !Number.isInteger(reward.charmChance) ||
      reward.charmChance < 0 ||
      reward.charmChance > ODDS_SCALE
    ) {
      report(`${path}.charmChance`, `must be an integer in [0, ${ODDS_SCALE}]`);
    }
    if (!(reward.incomeSeconds > previousIncome)) {
      report(`${path}.incomeSeconds`, 'rarer crates must pay strictly more coins');
    }
    previousIncome = reward.incomeSeconds;
  }
}

function checkProgression(config: EconomyConfig, report: Report): void {
  const { venues, album, offline, bullion, ascension, season } = config;
  checkIdsExactly(
    report,
    'venues',
    venues.map((v) => v.id),
    VENUE_IDS,
  );
  venues.forEach((venue, i) => {
    const path = `venues[${i}] (${venue.id})`;
    if (venue.order !== i + 1) report(path, `order must be ${i + 1}, got ${venue.order}`);
    if (!isPositive(venue.bullionThreshold)) report(path, 'bullionThreshold must be > 0');
    if (!isPositive(venue.coinValueMultiplier)) report(path, 'coinValueMultiplier must be > 0');
    if (!isPositiveInt(venue.charmSockets)) report(path, 'charmSockets must be a positive integer');
    const prev = venues[i - 1];
    if (prev !== undefined && !(venue.bullionThreshold > prev.bullionThreshold)) {
      report(path, `bullionThreshold must exceed ${prev.id}'s`);
    }
  });

  const itemIds = new Set<string>();
  const setIds = new Set<string>();
  album.forEach((set, i) => {
    const path = `album[${i}] (${set.id})`;
    if (setIds.has(set.id)) report(path, 'duplicate set id');
    setIds.add(set.id);
    if (set.items.length === 0) report(path, 'a set needs at least one item');
    if (!isPositive(set.globalBonus)) report(path, 'globalBonus must be > 0');
    for (const item of set.items) {
      if (itemIds.has(item.id)) report(path, `item "${item.id}" appears in more than one set`);
      itemIds.add(item.id);
      const obtainable = config.crateRewards[item.rarity].albumCard;
      if (!obtainable) report(path, `item "${item.id}" (${item.rarity}) cannot drop from crates`);
    }
  });

  if (!(offline.activeRateFactor > 0 && offline.activeRateFactor <= 1)) {
    report('offline.activeRateFactor', 'must be in (0, 1]: offline never beats active play');
  }
  if (!(offline.baseCapHours > 0 && offline.maxCapHours >= offline.baseCapHours)) {
    report('offline', 'cap hours must satisfy 0 < baseCapHours ≤ maxCapHours');
  }
  if (!isPositive(bullion.valuePerBullion)) report('bullion.valuePerBullion', 'must be > 0');
  if (!isPositive(ascension.goldBarScale)) report('ascension.goldBarScale', 'must be > 0');
  for (const key of ['weeks', 'freeTiers', 'starsPerTier', 'dropsPerStar'] as const) {
    if (!isPositive(season[key])) report(`season.${key}`, 'must be > 0');
  }
}

function checkPacing(config: EconomyConfig, report: Report): void {
  checkIdsExactly(
    report,
    'pacing',
    config.pacing.map((t) => t.id),
    PACING_TARGET_IDS,
  );
  for (const target of config.pacing) {
    const path = `pacing.${target.id}`;
    if (!(target.percentile > 0 && target.percentile <= 100)) {
      report(path, 'percentile must be in (0, 100]');
    }
    if (target.min === undefined && target.max === undefined) report(path, 'needs a min or a max');
    if (target.min !== undefined && target.max !== undefined && target.min > target.max) {
      report(path, 'min must not exceed max');
    }
  }
}

export function validateEconomyConfig(config: EconomyConfig): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const report: Report = (path, message) => issues.push({ path, message });
  checkKeys(config, report);
  checkCurrencies(config, report);
  checkCoins(config, report);
  checkUpgrades(config, report);
  checkDrops(config, report);
  checkProgression(config, report);
  checkPacing(config, report);
  return issues;
}

export class EconomyConfigError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super(
      `Economy config is invalid (${issues.length} issue${issues.length === 1 ? '' : 's'}):\n` +
        issues.map((issue) => `  - ${issue.path}: ${issue.message}`).join('\n'),
    );
    this.name = 'EconomyConfigError';
    this.issues = issues;
  }
}

export function assertValidEconomyConfig(config: EconomyConfig): void {
  const issues = validateEconomyConfig(config);
  if (issues.length > 0) throw new EconomyConfigError(issues);
}
