import type { CharmKind } from '@coinposh/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { economyConfig } from './config/index.ts';
import { ODDS_SCALE } from './odds.ts';
import { EconomyConfigError, assertValidEconomyConfig, validateEconomyConfig } from './validate.ts';
import {
  DROP_SOURCE_IDS,
  RARITY_IDS,
  RATE_ENVELOPE_METRIC_IDS,
  type CharmKindDef,
  type CharmsConfig,
  type CoinTierId,
  type DropTableDef,
  type EconomyConfig,
  type OddsTable,
  type RarityId,
  type RateEnvelopeConfig,
  type RateEnvelopeMetricDef,
  type RateEnvelopeMetricId,
  type SafeTypeDef,
} from './types.ts';

function withOdds(source: DropTableDef['source'], odds: OddsTable): EconomyConfig {
  return {
    ...economyConfig,
    dropTables: economyConfig.dropTables.map((t) => (t.source === source ? { ...t, odds } : t)),
  };
}

function oddsFrom(weights: readonly number[]): OddsTable {
  return Object.fromEntries(RARITY_IDS.map((r, i) => [r, weights[i] ?? 0])) as Record<
    RarityId,
    number
  >;
}

function paths(config: EconomyConfig): string[] {
  return validateEconomyConfig(config).map((issue) => issue.path);
}

/** Six non-negative integers summing to exactly ODDS_SCALE, with a rare+ weight so pity holds. */
const validWeights = fc
  .array(fc.integer({ min: 0, max: ODDS_SCALE }), { minLength: 5, maxLength: 5 })
  .map((cuts) => {
    const sorted = [...cuts].sort((a, b) => a - b);
    const bounds = [0, ...sorted, ODDS_SCALE];
    return bounds.slice(1).map((b, i) => b - (bounds[i] ?? 0));
  })
  .filter((w) => (w[4] ?? 0) + (w[5] ?? 0) > 0);

describe('validateEconomyConfig: odds', () => {
  it('accepts any integer table that sums to exactly 100 %', () => {
    fc.assert(
      fc.property(fc.constantFrom(...DROP_SOURCE_IDS), validWeights, (source, weights) => {
        expect(validateEconomyConfig(withOdds(source, oddsFrom(weights)))).toEqual([]);
      }),
    );
  });

  it('rejects every table whose odds do not sum to 100 %', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...DROP_SOURCE_IDS),
        validWeights,
        fc.integer({ min: 0, max: RARITY_IDS.length - 1 }),
        fc.integer({ min: 1, max: 5_000 }),
        fc.boolean(),
        (source, weights, index, delta, up) => {
          const skewed = [...weights];
          const current = skewed[index] ?? 0;
          skewed[index] = up ? current + delta : Math.max(0, current - delta);
          fc.pre(skewed[index] !== current);
          const issues = validateEconomyConfig(withOdds(source, oddsFrom(skewed)));
          expect(issues.some((i) => i.path === `dropTables.${source}.odds`)).toBe(true);
        },
      ),
    );
  });

  it('explains the actual sum in the message', () => {
    const issues = validateEconomyConfig(
      withOdds('vaultCrate', { ...oddsFrom([6_200, 2_500, 900, 300, 95, 5]), common: 6_100 }),
    );
    expect(issues).toContainEqual({
      path: 'dropTables.vaultCrate.odds',
      message: 'odds sum to 99 %, must be exactly 100 %',
    });
  });

  it('rejects fractional and negative weights even when the total is right', () => {
    expect(paths(withOdds('gacha', oddsFrom([5_500.5, 2_699.5, 1_200, 450, 140, 10])))).toEqual(
      expect.arrayContaining(['dropTables.gacha.odds.common', 'dropTables.gacha.odds.fine']),
    );
    expect(paths(withOdds('gacha', oddsFrom([5_600, 2_700, 1_200, 450, 140, -90])))).toContain(
      'dropTables.gacha.odds.heirloom',
    );
  });

  it('rejects a missing rarity and an unknown one', () => {
    const { heirloom: _dropped, ...rest } = oddsFrom([6_200, 2_500, 900, 300, 100, 0]);
    const issues = validateEconomyConfig(
      withOdds('scratch', { ...rest, mythic: 0 } as unknown as OddsTable),
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        { path: 'dropTables.scratch.odds', message: 'missing "heirloom"' },
        { path: 'dropTables.scratch.odds', message: 'unknown id "mythic"' },
      ]),
    );
  });

  it('rejects a pitied table that can never roll the guaranteed rarity', () => {
    const issues = validateEconomyConfig(
      withOdds('scratch', oddsFrom([7_000, 2_000, 800, 200, 0, 0])),
    );
    expect(issues).toContainEqual({
      path: 'dropTables.scratch',
      message: 'pity guarantees legendary+ but the table can never roll it',
    });
  });

  it('requires one table per drop source', () => {
    const config = { ...economyConfig, dropTables: economyConfig.dropTables.slice(1) };
    expect(validateEconomyConfig(config)).toContainEqual({
      path: 'dropTables',
      message: 'missing "vaultCrate"',
    });
  });
});

describe('validateEconomyConfig: pity, upgrades, ladders', () => {
  it('rejects pity windows that shrink as rarity rises', () => {
    const config: EconomyConfig = {
      ...economyConfig,
      pity: {
        rules: [
          { rarity: 'rare', within: 10 },
          { rarity: 'exquisite', within: 8 },
        ],
      },
    };
    expect(paths(config)).toContain('pity.rules[1] (exquisite)');
  });

  it('rejects upgrade growth outside [1.12, 1.18]', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.double({ min: 1.0001, max: 1.1199, noNaN: true }),
          fc.double({ min: 1.1801, max: 3, noNaN: true }),
        ),
        (growth) => {
          const [first, ...rest] = economyConfig.upgradeLines;
          const config = { ...economyConfig, upgradeLines: [{ ...first, growth }, ...rest] };
          expect(paths(config)).toContain(`upgradeLines[0] (${first.id})`);
        },
      ),
    );
  });

  it('rejects duplicate upgrade ids and a venue line paid in Gold Bars', () => {
    const [first, ...rest] = economyConfig.upgradeLines;
    const config: EconomyConfig = {
      ...economyConfig,
      upgradeLines: [first, { ...first, currency: 'goldBars' }, ...rest],
    };
    const messages = validateEconomyConfig(config).map((i) => i.message);
    expect(messages).toContain('duplicate id');
    expect(messages).toContain('venue upgrades are paid in coins, got goldBars');
  });

  it('keeps the offline-hours line in step with the offline cap', () => {
    const config: EconomyConfig = {
      ...economyConfig,
      offline: { ...economyConfig.offline, maxCapHours: 24 },
    };
    expect(paths(config)).toContain('upgradeLines (offlineHours)');
  });

  it('rejects a coin ladder that breaks the fusion chain or goes down in value', () => {
    const tiers = economyConfig.coinTiers.map((t) =>
      t.id === 'gold' ? { ...t, value: 4, fusesInto: 'diamond' as const } : t,
    );
    const issues = paths({ ...economyConfig, coinTiers: tiers });
    expect(issues).toContain('coinTiers[1] (silver)');
    expect(issues).toContain('coinTiers[2] (gold)');
  });

  it('accepts an opening heap of any positive whole number of coins at any defined tier', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.constantFrom(...economyConfig.coinTiers.map((t) => t.id)),
        (coins, tier) => {
          expect(validateEconomyConfig({ ...economyConfig, openingHeap: { coins, tier } })).toEqual(
            [],
          );
        },
      ),
    );
  });

  it.each([0, -1, -100, 0.5, 99.9, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an opening heap of %s coins',
    (coins) => {
      const issues = validateEconomyConfig({
        ...economyConfig,
        openingHeap: { ...economyConfig.openingHeap, coins },
      });
      expect(issues).toEqual([
        { path: 'openingHeap.coins', message: `must be a positive integer, got ${coins}` },
      ]);
    },
  );

  it('rejects an opening heap at a tier the ladder does not define', () => {
    const unknown = { ...economyConfig.openingHeap, tier: 'bronze' as CoinTierId };
    expect(validateEconomyConfig({ ...economyConfig, openingHeap: unknown })).toEqual([
      {
        path: 'openingHeap.tier',
        message: 'must be one of copper, silver, gold, platinum, diamond, heirloom, got "bronze"',
      },
    ]);
    const ladder = economyConfig.coinTiers.filter((t) => t.id !== 'heirloom');
    const dropped = { ...economyConfig.openingHeap, tier: 'heirloom' as const };
    expect(paths({ ...economyConfig, coinTiers: ladder, openingHeap: dropped })).toContain(
      'openingHeap.tier',
    );
  });

  it('rejects a fusion that destroys value', () => {
    const config = { ...economyConfig, fusion: { ...economyConfig.fusion, bonusMultiplier: 0.9 } };
    expect(paths(config)).toContain('fusion.bonusMultiplier');
  });

  it('rejects cascade tiers whose multiplier does not climb', () => {
    const tiers = economyConfig.cascade.tiers.map((t) =>
      t.id === 'opulent' ? { ...t, multiplier: 1.2 } : t,
    );
    expect(paths({ ...economyConfig, cascade: { ...economyConfig.cascade, tiers } })).toContain(
      'cascade.tiers[2] (opulent)',
    );
  });

  it('rejects offline earnings that beat active play', () => {
    const config = {
      ...economyConfig,
      offline: { ...economyConfig.offline, activeRateFactor: 1.2 },
    };
    expect(paths(config)).toContain('offline.activeRateFactor');
  });

  it('rejects venue thresholds that do not climb', () => {
    const venues = economyConfig.venues.map((v) =>
      v.order === 2 ? { ...v, bullionThreshold: 100 } : v,
    );
    expect(paths({ ...economyConfig, venues })).toContain('venues[1] (salonDeParis)');
  });

  it('rejects an album item listed in two sets', () => {
    const [first, second, ...rest] = economyConfig.album;
    const duplicate = { ...second, items: [...second.items, first.items[0]] };
    const messages = validateEconomyConfig({
      ...economyConfig,
      album: [first, duplicate, ...rest],
    }).map((i) => i.message);
    expect(messages).toContain(`item "${first.items[0].id}" appears in more than one set`);
  });
});

describe('validateEconomyConfig: rate envelope', () => {
  function withMetric(
    metric: RateEnvelopeMetricId,
    patch: Partial<RateEnvelopeMetricDef>,
  ): EconomyConfig {
    const rateEnvelope: Record<RateEnvelopeMetricId, RateEnvelopeMetricDef> = {
      ...economyConfig.rateEnvelope,
    };
    rateEnvelope[metric] = { ...rateEnvelope[metric], ...patch };
    return { ...economyConfig, rateEnvelope };
  }

  it('ships the envelope inside the config', () => {
    expect(Object.keys(economyConfig.rateEnvelope)).toEqual([...RATE_ENVELOPE_METRIC_IDS]);
    expect(validateEconomyConfig(economyConfig)).toEqual([]);
  });

  it('rejects every metric whose window or max is not a positive integer', () => {
    const bad = fc.oneof(
      fc.integer({ max: 0 }),
      fc.double({ noInteger: true }),
      fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY),
    );
    fc.assert(
      fc.property(
        fc.constantFrom(...RATE_ENVELOPE_METRIC_IDS),
        fc.constantFrom('windowMs' as const, 'max' as const),
        bad,
        (metric, field, value) => {
          const issues = validateEconomyConfig(withMetric(metric, { [field]: value }));
          expect(issues).toEqual([
            {
              path: `rateEnvelope.${metric}`,
              message: `${field} must be a positive integer, got ${value}`,
            },
          ]);
        },
      ),
    );
  });

  it('rejects a scaleBy weight outside [0, 1] and an unknown stat', () => {
    const issues = validateEconomyConfig(
      withMetric('falls', {
        scaleBy: { dropRate: 1.5, sparkle: 1 } as RateEnvelopeMetricDef['scaleBy'],
      }),
    );
    expect(issues.map((i) => i.message)).toEqual([
      'scaleBy.dropRate must be an elasticity in [0, 1], got 1.5',
      'scaleBy names unknown stat "sparkle"',
    ]);
  });

  it('reports a missing metric and an unknown one without crashing', () => {
    const { crates: _crates, ...rest } = economyConfig.rateEnvelope;
    const rateEnvelope = {
      ...rest,
      jackpots: economyConfig.rateEnvelope.drops,
    } as unknown as RateEnvelopeConfig;
    expect(validateEconomyConfig({ ...economyConfig, rateEnvelope })).toEqual([
      { path: 'rateEnvelope', message: 'missing "crates"' },
      { path: 'rateEnvelope', message: 'unknown id "jackpots"' },
    ]);
  });

  it('fails assertValidEconomyConfig on an invalid envelope', () => {
    expect(() => {
      assertValidEconomyConfig(withMetric('fusions', { max: 0 }));
    }).toThrow('rateEnvelope.fusions: max must be a positive integer, got 0');
  });
});

describe('assertValidEconomyConfig', () => {
  it('passes the shipped config', () => {
    expect(() => {
      assertValidEconomyConfig(economyConfig);
    }).not.toThrow();
  });

  it('throws one error listing every issue', () => {
    const config = withOdds('goldSafe', oddsFrom([3_500, 3_500, 2_000, 750, 240, 0]));
    let caught: unknown;
    try {
      assertValidEconomyConfig({ ...config, bullion: { valuePerBullion: 0 } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EconomyConfigError);
    const error = caught as EconomyConfigError;
    expect(error.issues.map((i) => i.path)).toEqual([
      'dropTables.goldSafe.odds',
      'bullion.valuePerBullion',
    ]);
    expect(error.message).toContain('Economy config is invalid (2 issues)');
    expect(error.message).toContain('dropTables.goldSafe.odds: odds sum to 99.9 %');
  });
});

describe('validateEconomyConfig: config keys', () => {
  const KEY = /^[a-z][a-zA-Z0-9]*([-_.:][a-zA-Z0-9]+)*$/;
  const isKey = (key: string): boolean => key.length <= 64 && KEY.test(key);

  function withLineId(id: string): EconomyConfig {
    return {
      ...economyConfig,
      upgradeLines: economyConfig.upgradeLines.map((l, i) => (i === 0 ? { ...l, id } : l)),
    };
  }

  const keyIssues = (config: EconomyConfig): string[] =>
    validateEconomyConfig(config)
      .filter((i) => i.message.includes('must match'))
      .map((i) => i.path);

  it('accepts every key that matches the pattern within 64 characters', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(KEY).filter((k) => k.length <= 64),
        (key) => {
          expect(keyIssues(withLineId(key))).toEqual([]);
        },
      ),
    );
  });

  it('rejects every key outside the pattern or over 64 characters', () => {
    const offPattern = fc.string({ unit: 'binary-ascii', maxLength: 80 });
    const tooLong = fc.stringMatching(KEY).filter((k) => k.length > 64);
    fc.assert(
      fc.property(fc.oneof(offPattern, tooLong), (key) => {
        fc.pre(!isKey(key));
        expect(keyIssues(withLineId(key))).toEqual(['upgradeLines[0].id']);
      }),
    );
  });

  it('pins the boundary cases', () => {
    for (const key of ['a', 'pusher-speed', 'vault.crate:gold_2', 'a'.repeat(64)]) {
      expect(keyIssues(withLineId(key))).toEqual([]);
    }
    for (const key of [
      '',
      'PusherSpeed',
      '1coin',
      'pusher--speed',
      'pusher-',
      '-pusher',
      'pusher speed',
      'a'.repeat(65),
    ]) {
      expect(keyIssues(withLineId(key))).toEqual(['upgradeLines[0].id']);
    }
  });

  it('checks venue, album and source keys too', () => {
    const [venue, ...venues] = economyConfig.venues;
    const [set, ...sets] = economyConfig.album;
    const [currency, ...currencies] = economyConfig.currencies;
    const broken = {
      ...economyConfig,
      venues: [{ ...venue, id: 'Riviera Yacht' }, ...venues],
      album: [{ ...set, id: 'deck essentials' }, ...sets],
      currencies: [{ ...currency, sinks: ['Drop'] }, ...currencies],
    } as unknown as EconomyConfig;
    expect(keyIssues(broken)).toEqual(['currencies[0].sinks[0]', 'venues[0].id', 'album[0].id']);
  });
});

describe('validateEconomyConfig: safes', () => {
  const [gold] = economyConfig.safes.types;
  const withTypes = (types: readonly SafeTypeDef[]): EconomyConfig => ({
    ...economyConfig,
    safes: { ...economyConfig.safes, types },
  });
  const withGold = (patch: Partial<SafeTypeDef>): EconomyConfig =>
    withTypes([{ ...gold, ...patch }]);
  const withSafeChance = (rarity: RarityId, safeChance: number): EconomyConfig => ({
    ...economyConfig,
    crateRewards: {
      ...economyConfig.crateRewards,
      [rarity]: { ...economyConfig.crateRewards[rarity], safeChance },
    },
  });

  it('rejects a safe chance off the odds scale', () => {
    for (const chance of [-1, 0.5, ODDS_SCALE + 1, Number.NaN]) {
      expect(validateEconomyConfig(withSafeChance('heirloom', chance))).toContainEqual({
        path: 'crateRewards.heirloom.safeChance',
        message: `must be an integer in [0, ${ODDS_SCALE}]`,
      });
    }
  });

  it('rejects a rarer crate that is less likely to hold a safe', () => {
    expect(validateEconomyConfig(withSafeChance('legendary', 2_000))).toEqual([
      {
        path: 'crateRewards.legendary.safeChance',
        message: 'a rarer crate must not be less likely to hold a safe',
      },
    ]);
  });

  it('rejects an empty catalog and a crate drop that names no safe type', () => {
    expect(paths(withTypes([]))).toEqual(['safes.types', 'safes.crateDrop.type']);
  });

  it('rejects a duplicate safe type', () => {
    expect(validateEconomyConfig(withTypes([gold, gold]))).toEqual([
      { path: 'safes.types[1] (gold)', message: 'duplicate id' },
    ]);
  });

  it('rejects contents that roll on a missing table or on the table that drops safes', () => {
    const dropTables = economyConfig.dropTables.filter((t) => t.source !== 'goldSafe');
    expect(validateEconomyConfig({ ...economyConfig, dropTables })).toContainEqual({
      path: 'safes.types[0] (gold)',
      message: 'dropSource "goldSafe" has no drop table',
    });
    expect(validateEconomyConfig(withGold({ dropSource: 'vaultCrate' }))).toEqual([
      {
        path: 'safes.types[0] (gold)',
        message: 'contents must not roll on "vaultCrate", the table that drops safes',
      },
    ]);
  });

  it('rejects contents that roll on a table without pity', () => {
    const dropTables = economyConfig.dropTables.map((t) =>
      t.source === 'goldSafe' ? { ...t, pity: false } : t,
    );
    expect(validateEconomyConfig({ ...economyConfig, dropTables })).toContainEqual({
      path: 'safes.types[0] (gold)',
      message: 'dropSource "goldSafe" must carry pity counters',
    });
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects %s keys or unlock seconds per safe', (bad) => {
    expect(validateEconomyConfig(withGold({ keysPerSafe: bad }))).toEqual([
      {
        path: 'safes.types[0] (gold)',
        message: `keysPerSafe must be a positive integer, got ${bad}`,
      },
    ]);
    expect(validateEconomyConfig(withGold({ unlockSeconds: bad }))).toEqual([
      {
        path: 'safes.types[0] (gold)',
        message: `unlockSeconds must be a positive integer, got ${bad}`,
      },
    ]);
  });

  it('rejects a crate drop from a source with no table', () => {
    const dropTables = economyConfig.dropTables.filter((t) => t.source !== 'vaultCrate');
    expect(paths({ ...economyConfig, dropTables })).toContain('safes.crateDrop.source');
  });

  it('rejects a safe type id outside the shared key format', () => {
    expect(paths(withTypes([{ ...gold, id: 'Gold Safe' }]))).toContain('safes.types[0].id');
  });
});

describe('validateEconomyConfig: charms', () => {
  const shipped = economyConfig.charms;

  function withCharms(patch: Partial<CharmsConfig>): EconomyConfig {
    return { ...economyConfig, charms: { ...shipped, ...patch } };
  }

  function withKind(kind: CharmKind, patch: Partial<CharmKindDef>): EconomyConfig {
    return withCharms({
      kinds: { ...shipped.kinds, [kind]: { ...shipped.kinds[kind], ...patch } },
    });
  }

  it('accepts the shipped catalog', () => {
    expect(validateEconomyConfig(economyConfig).filter((i) => i.path.startsWith('charms'))).toEqual(
      [],
    );
  });

  it('rejects charm pick odds that do not sum to exactly 100 %', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20_000 }).filter((w) => w !== 1_500),
        (weight) => {
          const drops = { ...shipped.drops, butler: { kind: 'butler' as const, weight } };
          expect(validateEconomyConfig(withCharms({ drops }))).toContainEqual(
            expect.objectContaining({ path: 'charms.drops' }),
          );
        },
      ),
    );
  });

  it('rejects an album charm that maps to no kind', () => {
    const { pearlNecklaceCharm: _dropped, ...drops } = shipped.drops;
    const rest = { ...drops, butler: { kind: 'butler' as const, weight: 1_700 } };
    expect(validateEconomyConfig(withCharms({ drops: rest }))).toEqual([
      {
        path: 'album[2] (sunsetGala)',
        message: 'charm "pearlNecklaceCharm" maps to no kind in charms.drops',
      },
    ]);
  });

  it('rejects a kind that no drop grants, and a kind id that plays as another kind', () => {
    const drops = { ...shipped.drops, 'golden-peg': { kind: 'butler' as const, weight: 1_500 } };
    expect(validateEconomyConfig(withCharms({ drops }))).toEqual([
      {
        path: 'charms.drops.golden-peg',
        message: 'a kind\'s own id must play as that kind, got "butler"',
      },
      { path: 'charms.drops', message: 'no drop ever grants golden-peg' },
    ]);
  });

  it('rejects a level that weakens a charm', () => {
    const kick = shipped.kinds['brass-bumper'].params.kickMmPerS;
    const levels: number[] = [...kick.levels];
    levels[4] = 100;
    const params = { ...shipped.kinds['brass-bumper'].params, kickMmPerS: { ...kick, levels } };
    expect(paths(withKind('brass-bumper', { params }))).toEqual([
      'charms.kinds.brass-bumper.params.kickMmPerS.levels[4]',
    ]);
  });

  it('rejects fractional or missing level values, so the sim never sees a float', () => {
    const ropes = shipped.kinds['velvet-ropes'].params.ropeMm;
    const params = {
      ...shipped.kinds['velvet-ropes'].params,
      ropeMm: { ...ropes, levels: [24.5, ...ropes.levels.slice(1, 9)] },
    };
    expect(paths(withKind('velvet-ropes', { params }))).toEqual([
      'charms.kinds.velvet-ropes.params.ropeMm',
      'charms.kinds.velvet-ropes.params.ropeMm.levels[0]',
    ]);
  });

  it('rejects a boosted name that is not a parameter', () => {
    expect(paths(withKind('butler', { boosted: 'speed' }))).toEqual(['charms.kinds.butler']);
  });

  it('rejects a value cap over the per-charm envelope budget', () => {
    expect(validateEconomyConfig(withKind('golden-peg', { valueCapBp: 601 }))).toContainEqual({
      path: 'charms.kinds.golden-peg.valueCapBp',
      message: 'must be an integer in [0, 600], got 601',
    });
  });

  it('rejects a set bonus that pushes a loadout past the envelope', () => {
    const setBonuses = shipped.setBonuses.map((b) =>
      b.tag === 'kinetic' && b.pieces === 2 ? { ...b, valueBp: 700 } : b,
    );
    expect(validateEconomyConfig(withCharms({ setBonuses }))).toContainEqual({
      path: 'charms',
      message: "loadout golden-peg + brass-bumper may mint 1300 bp, over the envelope's 1200 bp",
    });
  });

  it('rejects an unreachable tier, a missing tier and a tier that does not beat the one below', () => {
    const setBonuses = [
      ...shipped.setBonuses.filter((b) => !(b.tag === 'service' && b.pieces === 3)),
      { tag: 'service' as const, pieces: 4, effectBoostBp: 3_000, valueBp: 0 },
    ].map((b) => (b.tag === 'fragrant' && b.pieces === 3 ? { ...b, effectBoostBp: 1_000 } : b));
    expect(validateEconomyConfig(withCharms({ setBonuses }))).toEqual([
      { path: 'charms.setBonuses[8] (fragrant ×3)', message: 'must beat the 2-piece tier' },
      {
        path: 'charms.setBonuses[9] (service ×4)',
        message: 'only 3 kinds carry service, so no loadout reaches it',
      },
      { path: 'charms.setBonuses', message: 'service needs a 3-piece tier' },
    ]);
  });

  it('rejects a level curve that skips the first copy or stalls', () => {
    expect(paths(withCharms({ copiesToLevel: [2, 3, 4, 7, 12, 20, 32, 50, 76, 116] }))).toEqual([
      'charms.copiesToLevel',
    ]);
    expect(paths(withCharms({ copiesToLevel: [1, 2, 4, 7, 7, 20, 32, 50, 76, 116] }))).toEqual([
      'charms.copiesToLevel[4]',
    ]);
  });

  it('rejects a drop id outside the shared key format', () => {
    const drops = { ...shipped.drops, 'Golden Peg': { kind: 'golden-peg' as const, weight: 0 } };
    expect(paths(withCharms({ drops }))).toEqual(['charms.drops.Golden Peg']);
  });
});
