import { describe, expect, it } from 'vitest';
import { roundTrip } from '../../test/roundTrip.ts';
import {
  BASIS_POINTS,
  LiveGrantSchema,
  LiveOddsSchema,
  LivePitySchema,
  LiveRewardSchema,
} from './rewards.ts';

describe('LiveRewardSchema', () => {
  it.each([
    { kind: 'currency', currency: 'keys', amount: 1 },
    { kind: 'repute', amount: 100 },
    { kind: 'crate', rarity: 'rare' },
    { kind: 'cosmetic', cosmetic: 'gildedCalendarFrame' },
    { kind: 'collectible', collectibleId: 'bauble-gold' },
  ])('round-trips a $kind reward', (reward) => {
    const { parsed, reparsed } = roundTrip(LiveRewardSchema, reward);
    expect(reparsed).toEqual(parsed);
  });

  it.each([
    ['a zero amount', { kind: 'currency', currency: 'coins', amount: 0 }],
    ['an unknown currency', { kind: 'currency', currency: 'euros', amount: 5 }],
    ['negative Repute', { kind: 'repute', amount: -1 }],
    ['an unknown rarity', { kind: 'crate', rarity: 'mythic' }],
    ['a crate already minted', { kind: 'crate', crateId: 'crate_7Hq2LmX9pA' }],
    ['an unknown kind', { kind: 'damage', amount: 5 }],
  ])('refuses %s', (_label, reward) => {
    expect(LiveRewardSchema.safeParse(reward).success).toBe(false);
  });
});

describe('LiveGrantSchema', () => {
  it('pays crates as minted entities with their rolled rarity', () => {
    const crate = { kind: 'crate', crateId: 'crate_7Hq2LmX9pA', rarity: 'exquisite' };
    expect(LiveGrantSchema.safeParse(crate).success).toBe(true);
    expect(LiveGrantSchema.safeParse({ kind: 'crate', rarity: 'exquisite' }).success).toBe(false);
  });

  it('pays every table reward too', () => {
    const scratch = { kind: 'scratchCard', cardId: 'scratch_9AbCdEfGh' };
    expect(LiveGrantSchema.safeParse(scratch).success).toBe(true);
    expect(LiveGrantSchema.safeParse({ kind: 'repute', amount: 40 }).success).toBe(true);
  });
});

describe('LiveOddsSchema', () => {
  it('accepts a sheet that covers exactly 100 %', () => {
    const odds = [
      { rarity: 'fine', chanceBp: 9_999 },
      { rarity: 'legendary', chanceBp: 1 },
    ];
    expect(LiveOddsSchema.safeParse(odds).success).toBe(true);
    expect(LiveOddsSchema.safeParse([{ rarity: 'rare', chanceBp: BASIS_POINTS }]).success).toBe(
      true,
    );
  });

  it.each([
    ['an empty sheet', []],
    ['a sheet short of 100 %', [{ rarity: 'rare', chanceBp: BASIS_POINTS - 1 }]],
    [
      'a sheet over 100 %',
      [
        { rarity: 'fine', chanceBp: 6_000 },
        { rarity: 'rare', chanceBp: 4_001 },
      ],
    ],
    [
      'a rarity listed twice',
      [
        { rarity: 'rare', chanceBp: 5_000 },
        { rarity: 'rare', chanceBp: 5_000 },
      ],
    ],
    [
      'a zero row',
      [
        { rarity: 'rare', chanceBp: BASIS_POINTS },
        { rarity: 'fine', chanceBp: 0 },
      ],
    ],
    [
      'a fractional chance',
      [
        { rarity: 'rare', chanceBp: 9_999.5 },
        { rarity: 'fine', chanceBp: 0.5 },
      ],
    ],
  ])('refuses %s', (_label, odds) => {
    expect(LiveOddsSchema.safeParse(odds).success).toBe(false);
  });
});

describe('LivePitySchema', () => {
  it('accepts a counter one roll short of firing', () => {
    expect(LivePitySchema.safeParse({ guaranteed: 'rare', within: 4, since: 3 }).success).toBe(
      true,
    );
    expect(LivePitySchema.safeParse({ guaranteed: 'rare', within: 1, since: 0 }).success).toBe(
      true,
    );
  });

  it('refuses a counter at or past its limit', () => {
    for (const since of [4, 5]) {
      const result = LivePitySchema.safeParse({ guaranteed: 'rare', within: 4, since });
      expect(result.error?.issues.map((issue) => issue.path)).toEqual([['since']]);
    }
  });

  it('refuses a pity that never fires', () => {
    expect(LivePitySchema.safeParse({ guaranteed: 'rare', within: 0, since: 0 }).success).toBe(
      false,
    );
  });
});
