import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  COIN_TIER_IDS,
  COIN_TIERS,
  CURRENCIES,
  CURRENCY_IDS,
  CoinTierIdSchema,
  CurrencyIdSchema,
  DROP_SOURCE_IDS,
  DropSourceIdSchema,
  LOOT_SOURCES,
  LootSourceSchema,
  RARITIES,
  RARITY_IDS,
  RarityIdSchema,
  RewardPreviewSchema,
  RewardSchema,
  WalletSchema,
  nextCoinTier,
  type CoinTier,
  type CoinTierId,
  type Currency,
  type CurrencyId,
  type DropSourceId,
  type LootSource,
  type Rarity,
  type RarityId,
} from './domain.ts';
import { ids } from './test/fixtures.ts';
import { roundTrip } from './test/roundTrip.ts';

describe('economy id unions', () => {
  it('names each id list after the economy config keys it validates', () => {
    expect(CURRENCY_IDS).toBe(CURRENCIES);
    expect(COIN_TIER_IDS).toBe(COIN_TIERS);
    expect(RARITY_IDS).toBe(RARITIES);
    expectTypeOf<CurrencyId>().toEqualTypeOf<Currency>();
    expectTypeOf<CoinTierId>().toEqualTypeOf<CoinTier>();
    expectTypeOf<RarityId>().toEqualTypeOf<Rarity>();
    expectTypeOf<CoinTierId>().toEqualTypeOf<
      'copper' | 'silver' | 'gold' | 'platinum' | 'diamond' | 'heirloom'
    >();
  });

  it('parses ids with the matching schema', () => {
    expect(CurrencyIdSchema.parse('goldBars')).toBe('goldBars');
    expect(CoinTierIdSchema.parse('heirloom')).toBe('heirloom');
    expect(RarityIdSchema.parse('exquisite')).toBe('exquisite');
    expect(CoinTierIdSchema.safeParse('bronze').success).toBe(false);
  });
});

describe('drop sources', () => {
  it('is one union, keyed as the economy drop tables are', () => {
    expect(DROP_SOURCE_IDS).toEqual(['vaultCrate', 'goldSafe', 'gacha', 'scratch']);
    for (const source of DROP_SOURCE_IDS) {
      const { parsed, reparsed } = roundTrip(DropSourceIdSchema, source);
      expect(parsed).toBe(source);
      expect(reparsed).toBe(source);
    }
  });

  it('rejects the retired short names', () => {
    for (const retired of ['crate', 'safe', 'VaultCrate', '']) {
      expect(DropSourceIdSchema.safeParse(retired).success).toBe(false);
    }
  });

  it('keeps the deprecated LootSource names as aliases of the same union', () => {
    /* eslint-disable @typescript-eslint/no-deprecated -- the aliases under test are deprecated on purpose */
    expect(LOOT_SOURCES).toBe(DROP_SOURCE_IDS);
    expect(LootSourceSchema).toBe(DropSourceIdSchema);
    expectTypeOf<LootSource>().toEqualTypeOf<DropSourceId>();
    /* eslint-enable @typescript-eslint/no-deprecated */
  });
});

describe('nextCoinTier', () => {
  it('walks the fusion ladder from copper to heirloom', () => {
    expect(COIN_TIERS.map(nextCoinTier)).toEqual([
      'silver',
      'gold',
      'platinum',
      'diamond',
      'heirloom',
      null,
    ]);
  });
});

describe('WalletSchema', () => {
  const wallet = Object.fromEntries(CURRENCIES.map((currency) => [currency, 0]));

  it('has a balance for every currency and round-trips', () => {
    const { parsed, reparsed } = roundTrip(WalletSchema, wallet);
    expect(Object.keys(parsed).toSorted()).toEqual([...CURRENCIES].toSorted());
    expect(reparsed).toEqual(parsed);
  });

  it('accepts balances up to the largest safe integer', () => {
    const rich = { ...wallet, coins: Number.MAX_SAFE_INTEGER };
    expect(WalletSchema.safeParse(rich).success).toBe(true);
  });

  it.each([
    ['a negative balance', { ...wallet, pearls: -1 }],
    ['a fractional balance', { ...wallet, coins: 0.5 }],
    ['a balance past safe integers', { ...wallet, coins: Number.MAX_SAFE_INTEGER + 2 }],
    ['a numeric string', { ...wallet, keys: '3' }],
    ['a missing currency', { ...wallet, stars: undefined }],
  ])('rejects %s', (_label, value) => {
    expect(WalletSchema.safeParse(value).success).toBe(false);
  });
});

describe('RewardSchema', () => {
  it.each([
    { kind: 'currency', currency: 'pearls', amount: 10 },
    { kind: 'charm', charmId: ids.charm, charmType: 'butler', level: 1, duplicate: false },
    { kind: 'safe', safe: { id: ids.safe, type: 'gold', unlocksAt: 0 } },
    { kind: 'scratchCard', cardId: ids.scratchCard },
    { kind: 'collectible', collectibleId: 'duchess-sovereign-1891' },
  ])('round-trips a $kind reward', (reward) => {
    const { parsed, reparsed } = roundTrip(RewardSchema, reward);
    expect(parsed).toEqual(reward);
    expect(reparsed).toEqual(parsed);
  });

  it('rejects zero-amount and unknown-currency rewards', () => {
    expect(
      RewardSchema.safeParse({ kind: 'currency', currency: 'pearls', amount: 0 }).success,
    ).toBe(false);
    expect(RewardSchema.safeParse({ kind: 'currency', currency: 'gems', amount: 5 }).success).toBe(
      false,
    );
  });

  it('keeps previews free of entity ids', () => {
    expect(RewardPreviewSchema.safeParse({ kind: 'safe', safeType: 'gold' }).success).toBe(true);
    expect(
      RewardPreviewSchema.safeParse({
        kind: 'safe',
        safe: { id: ids.safe, type: 'gold', unlocksAt: 0 },
      }).success,
    ).toBe(false);
  });
});
