import {
  AlbumSetIdSchema,
  CATALOG_KEY,
  CATALOG_KEY_MAX_LENGTH,
  CatalogKeySchema,
  CHARM_KINDS,
  CharmTypeIdSchema,
  COIN_TIER_IDS,
  CollectibleIdSchema,
  CURRENCY_IDS,
  DROP_SOURCE_IDS,
  RARITY_IDS,
  SafeTypeIdSchema,
  SYNERGY_TAGS,
  UpgradeLineIdSchema,
  VENUE_IDS,
  type CharmKind,
} from '@coinposh/shared';
import { validateRateEnvelope } from './config.ts';
import { charmLoadoutValueCapBp } from './config/charms.ts';
import { ODDS_SCALE, oddsTotal, weightToPercent } from './odds.ts';
import { rarityRank } from './pity.ts';
import {
  CASCADE_TIER_IDS,
  PACING_TARGET_IDS,
  RATE_ENVELOPE_METRIC_IDS,
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

function checkKeys(config: EconomyConfig, report: Report): void {
  const check = (path: string, key: string, schema: KeySchema = CatalogKeySchema): void => {
    if (!schema.safeParse(key).success) {
      report(
        path,
        `key "${key}" must match ${CATALOG_KEY.source} and be ≤ ${CATALOG_KEY_MAX_LENGTH} characters`,
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
  for (const [i, t] of config.safes.types.entries()) {
    check(`safes.types[${i}].id`, t.id, SafeTypeIdSchema);
  }
  // Key format only: membership in VENUE_IDS is reported by checkProgression.
  for (const [i, v] of config.venues.entries()) check(`venues[${i}].id`, v.id);
  for (const [i, set] of config.album.entries()) {
    check(`album[${i}].id`, set.id, AlbumSetIdSchema);
    for (const [j, item] of set.items.entries()) {
      check(`album[${i}].items[${j}].id`, item.id, CollectibleIdSchema);
    }
  }
  for (const [i, t] of config.pacing.entries()) check(`pacing[${i}].id`, t.id);
  for (const id of Object.keys(config.charms.drops)) {
    check(`charms.drops.${id}`, id, CharmTypeIdSchema);
  }
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
  const { coinTiers, fusion, openingHeap, cascade } = config;
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

  if (!isPositiveInt(openingHeap.coins)) {
    report('openingHeap.coins', `must be a positive integer, got ${openingHeap.coins}`);
  }
  if (!coinTiers.some((t) => t.id === openingHeap.tier)) {
    report(
      'openingHeap.tier',
      `must be one of ${coinTiers.map((t) => t.id).join(', ')}, got "${openingHeap.tier}"`,
    );
  }

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
  let previousSafeChance = 0;
  for (const rarity of RARITY_IDS) {
    const reward = crateRewards[rarity];
    const path = `crateRewards.${rarity}`;
    for (const key of ['incomeSeconds', 'pearls', 'keys', 'tickets'] as const) {
      if (!isNonNegative(reward[key])) report(`${path}.${key}`, 'must be ≥ 0');
    }
    for (const key of ['charmChance', 'safeChance'] as const) {
      const chance = reward[key];
      if (!Number.isInteger(chance) || chance < 0 || chance > ODDS_SCALE) {
        report(`${path}.${key}`, `must be an integer in [0, ${ODDS_SCALE}]`);
      }
    }
    if (reward.safeChance < previousSafeChance) {
      report(`${path}.safeChance`, 'a rarer crate must not be less likely to hold a safe');
    }
    previousSafeChance = reward.safeChance;
    if (!(reward.incomeSeconds > previousIncome)) {
      report(`${path}.incomeSeconds`, 'rarer crates must pay strictly more coins');
    }
    previousIncome = reward.incomeSeconds;
  }
}

function checkSafes(config: EconomyConfig, report: Report): void {
  const { safes, dropTables } = config;
  if (safes.types.length === 0) report('safes.types', 'the catalog needs at least one safe type');
  const ids = new Set<string>();
  safes.types.forEach((type, i) => {
    const path = `safes.types[${i}] (${type.id})`;
    if (ids.has(type.id)) report(path, 'duplicate id');
    ids.add(type.id);
    const table = dropTables.find((t) => t.source === type.dropSource);
    if (table === undefined) {
      report(path, `dropSource "${type.dropSource}" has no drop table`);
    } else if (!table.pity) {
      report(path, `dropSource "${type.dropSource}" must carry pity counters`);
    }
    if (type.dropSource === safes.crateDrop.source) {
      report(path, `contents must not roll on "${type.dropSource}", the table that drops safes`);
    }
    if (!isPositiveInt(type.keysPerSafe)) {
      report(path, `keysPerSafe must be a positive integer, got ${type.keysPerSafe}`);
    }
    if (!isPositiveInt(type.unlockSeconds)) {
      report(path, `unlockSeconds must be a positive integer, got ${type.unlockSeconds}`);
    }
  });

  const { source, type } = safes.crateDrop;
  if (!dropTables.some((t) => t.source === source)) {
    report('safes.crateDrop.source', `"${source}" has no drop table`);
  }
  if (!ids.has(type)) report('safes.crateDrop.type', `"${type}" is not in safes.types`);
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

function checkCharmParams(config: EconomyConfig, report: Report): void {
  const { charms } = config;
  for (const kind of CHARM_KINDS) {
    const def = charms.kinds[kind];
    const path = `charms.kinds.${kind}`;
    if (def.tags.length === 0) report(path, 'needs at least one synergy tag');
    if (new Set(def.tags).size !== def.tags.length) report(path, 'lists a tag twice');
    for (const tag of def.tags) {
      if (!(SYNERGY_TAGS as readonly string[]).includes(tag)) report(path, `unknown tag "${tag}"`);
    }
    if (!Object.hasOwn(def.params, def.boosted)) {
      report(path, `boosted names "${def.boosted}", which is not one of its params`);
    }
    for (const [name, param] of Object.entries(def.params)) {
      const at = `${path}.params.${name}`;
      if (param.levels.length !== charms.maxLevel) {
        report(at, `needs ${charms.maxLevel} levels, has ${param.levels.length}`);
      }
      param.levels.forEach((value, i) => {
        if (!isPositiveInt(value)) {
          report(`${at}.levels[${i}]`, `must be a positive integer, got ${value}`);
        }
        const prev = param.levels[i - 1];
        if (prev === undefined) return;
        const worse = param.sense === 'more' ? value < prev : value > prev;
        if (worse) {
          report(`${at}.levels[${i}]`, `a level must never weaken the charm (${prev} → ${value})`);
        }
      });
    }
  }
}

function checkCharmSets(config: EconomyConfig, report: Report, kindsComplete: boolean): void {
  const { charms } = config;
  const tiers = new Set<string>();
  charms.setBonuses.forEach((bonus, i) => {
    const path = `charms.setBonuses[${i}] (${bonus.tag} ×${bonus.pieces})`;
    if (!(SYNERGY_TAGS as readonly string[]).includes(bonus.tag)) report(path, 'unknown tag');
    if (tiers.has(`${bonus.tag}:${bonus.pieces}`)) report(path, 'duplicate tier');
    tiers.add(`${bonus.tag}:${bonus.pieces}`);
    if (!Number.isInteger(bonus.pieces) || bonus.pieces < 2) {
      report(path, 'pieces must be an integer ≥ 2');
    }
    for (const key of ['effectBoostBp', 'valueBp'] as const) {
      if (!Number.isInteger(bonus[key]) || bonus[key] < 0) {
        report(path, `${key} must be a non-negative integer`);
      }
    }
    if (kindsComplete) {
      const carriers = CHARM_KINDS.filter((kind) => charms.kinds[kind].tags.includes(bonus.tag));
      if (bonus.pieces > carriers.length) {
        report(path, `only ${carriers.length} kinds carry ${bonus.tag}, so no loadout reaches it`);
      }
    }
    for (const lower of charms.setBonuses) {
      if (lower.tag !== bonus.tag || !(lower.pieces < bonus.pieces)) continue;
      if (!(bonus.effectBoostBp > lower.effectBoostBp && bonus.valueBp >= lower.valueBp)) {
        report(path, `must beat the ${lower.pieces}-piece tier`);
      }
    }
  });
  for (const tag of SYNERGY_TAGS) {
    for (const pieces of [2, 3]) {
      if (!tiers.has(`${tag}:${pieces}`)) {
        report('charms.setBonuses', `${tag} needs a ${pieces}-piece tier`);
      }
    }
  }
}

function checkCharmDrops(config: EconomyConfig, report: Report): void {
  const { charms, album } = config;
  let total = 0;
  const weightByKind = new Map<CharmKind, number>();
  for (const [id, drop] of Object.entries(charms.drops)) {
    const path = `charms.drops.${id}`;
    if (!(CHARM_KINDS as readonly string[]).includes(drop.kind)) {
      report(path, `unknown kind "${drop.kind}"`);
    }
    if ((CHARM_KINDS as readonly string[]).includes(id) && id !== drop.kind) {
      report(path, `a kind's own id must play as that kind, got "${drop.kind}"`);
    }
    if (!Number.isInteger(drop.weight) || drop.weight < 0) {
      report(path, `weight must be a non-negative integer, got ${drop.weight}`);
    }
    total += drop.weight;
    weightByKind.set(drop.kind, (weightByKind.get(drop.kind) ?? 0) + drop.weight);
  }
  if (total !== ODDS_SCALE) {
    report('charms.drops', `weights sum to ${weightToPercent(total)} %, must be exactly 100 %`);
  }
  for (const kind of CHARM_KINDS) {
    if (!((weightByKind.get(kind) ?? 0) > 0)) report('charms.drops', `no drop ever grants ${kind}`);
  }
  // Album entries are charms by the `…Charm` id convention the album endpoint already reads.
  album.forEach((set, i) => {
    for (const item of set.items) {
      if (item.id.endsWith('Charm') && !Object.hasOwn(charms.drops, item.id)) {
        report(`album[${i}] (${set.id})`, `charm "${item.id}" maps to no kind in charms.drops`);
      }
    }
  });
}

/**
 * Exact over every set of distinct kinds (2^6 loadouts): what a loadout may mint never exceeds
 * the rate envelope's per-charm value budget times the charms slotted. A repeated kind adds its
 * own cap but no set progress, so the per-kind bound covers repeats.
 */
function checkCharmValueBudget(config: EconomyConfig, perCharmBp: number, report: Report): void {
  const { charms } = config;
  for (const kind of CHARM_KINDS) {
    const cap = charms.kinds[kind].valueCapBp;
    if (!Number.isInteger(cap) || cap < 0 || cap > perCharmBp) {
      report(
        `charms.kinds.${kind}.valueCapBp`,
        `must be an integer in [0, ${perCharmBp}], got ${cap}`,
      );
    }
  }
  for (let mask = 1; mask < 1 << CHARM_KINDS.length; mask += 1) {
    const loadout = CHARM_KINDS.filter((_, i) => (mask & (1 << i)) !== 0);
    const minted = charmLoadoutValueCapBp(loadout, charms);
    const budget = loadout.length * perCharmBp;
    if (minted > budget) {
      report(
        'charms',
        `loadout ${loadout.join(' + ')} may mint ${minted} bp, over the envelope's ${budget} bp`,
      );
    }
  }
}

function checkCharms(config: EconomyConfig, report: Report): void {
  const { charms } = config;
  if (!isPositiveInt(charms.tickRateHz)) report('charms.tickRateHz', 'must be a positive integer');
  if (!isPositiveInt(charms.maxLevel)) report('charms.maxLevel', 'must be a positive integer');
  if (charms.copiesToLevel.length !== charms.maxLevel) {
    report(
      'charms.copiesToLevel',
      `needs ${charms.maxLevel} entries, has ${charms.copiesToLevel.length}`,
    );
  }
  if (charms.copiesToLevel[0] !== 1) {
    report('charms.copiesToLevel', 'the first copy must be level 1');
  }
  charms.copiesToLevel.forEach((copies, i) => {
    const prev = charms.copiesToLevel[i - 1];
    if (!isPositiveInt(copies) || (prev !== undefined && !(copies > prev))) {
      report(`charms.copiesToLevel[${i}]`, 'copies must be positive integers rising every level');
    }
  });
  const { mastery } = charms;
  for (const key of ['maxLevel', 'activationsBase', 'growth'] as const) {
    if (!isPositiveInt(mastery[key])) report(`charms.mastery.${key}`, 'must be a positive integer');
  }
  if (!(mastery.growth > 1)) report('charms.mastery.growth', 'must exceed 1');
  if (!Number.isInteger(mastery.effectBpPerLevel) || mastery.effectBpPerLevel < 0) {
    report('charms.mastery.effectBpPerLevel', 'must be a non-negative integer');
  }
  if (!Number.isInteger(charms.setBoostCapBp) || charms.setBoostCapBp < 0) {
    report('charms.setBoostCapBp', 'must be a non-negative integer');
  }

  checkIdsExactly(report, 'charms.kinds', Object.keys(charms.kinds), CHARM_KINDS);
  const kindsComplete = CHARM_KINDS.every((kind) => Object.hasOwn(charms.kinds, kind));
  if (kindsComplete) checkCharmParams(config, report);
  checkCharmSets(config, report, kindsComplete);
  checkCharmDrops(config, report);

  const perCharm = config.rateEnvelope.fallValue.value?.perCharm;
  if (perCharm === undefined) {
    report('charms', 'rateEnvelope.fallValue must budget value per charm');
  } else if (kindsComplete) {
    // perCharm is a float share (0.06); the catalog speaks basis points.
    checkCharmValueBudget(config, Math.floor(perCharm * ODDS_SCALE + 1e-9), report);
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

function checkRateEnvelope(config: EconomyConfig, report: Report): void {
  const metrics = Object.keys(config.rateEnvelope);
  const complete = RATE_ENVELOPE_METRIC_IDS.every((id) => metrics.includes(id));
  if (!complete) {
    checkIdsExactly(report, 'rateEnvelope', metrics, RATE_ENVELOPE_METRIC_IDS);
    return;
  }
  // validateRateEnvelope reads every metric, so it only runs once none is missing.
  for (const issue of validateRateEnvelope(config.rateEnvelope)) report(issue.path, issue.message);
}

export function validateEconomyConfig(config: EconomyConfig): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const report: Report = (path, message) => issues.push({ path, message });
  checkKeys(config, report);
  checkCurrencies(config, report);
  checkCoins(config, report);
  checkUpgrades(config, report);
  checkDrops(config, report);
  checkSafes(config, report);
  checkProgression(config, report);
  checkCharms(config, report);
  checkPacing(config, report);
  checkRateEnvelope(config, report);
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
