import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { economyConfig } from './config/index.ts';
import { ODDS_SCALE } from './odds.ts';
import { EconomyConfigError, assertValidEconomyConfig, validateEconomyConfig } from './validate.ts';
import {
  DROP_SOURCE_IDS,
  RARITY_IDS,
  RATE_ENVELOPE_METRIC_IDS,
  type CoinTierId,
  type DropTableDef,
  type EconomyConfig,
  type OddsTable,
  type RarityId,
  type RateEnvelopeConfig,
  type RateEnvelopeMetricDef,
  type RateEnvelopeMetricId,
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
