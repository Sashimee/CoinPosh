import { describe, expect, it } from 'vitest';
import {
  COIN_TIERS,
  CURRENCIES,
  RewardPreviewSchema,
  RewardSchema,
  WalletSchema,
  nextCoinTier,
} from './domain.ts';
import { ids } from './test/fixtures.ts';
import { roundTrip } from './test/roundTrip.ts';

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
