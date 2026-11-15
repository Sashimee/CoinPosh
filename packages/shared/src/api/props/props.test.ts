import { describe, expect, expectTypeOf, it } from 'vitest';
import { CATALOG_KEY_MAX_LENGTH, CoinIdSchema } from '../../ids.ts';
import { roundTrip } from '../../test/roundTrip.ts';
import { ClaimSchema, ClaimWithPrizeSchema, MAX_CLAIMS_PER_BATCH } from '../table.ts';
import {
  ClaimWithPropsSchema,
  ClaimsWithPropsRequestSchema,
  JackpotBallClaimSchema,
  PropClaimSchema,
  TargetClaimSchema,
} from './claims.ts';
import {
  propsJackpotBallClaim,
  propsLayoutId,
  propsNow,
  propsRewards,
  propsTargetClaim,
  propsTargetHit,
} from './fixtures.ts';
import {
  JackpotBallIdSchema,
  PROP_KINDS,
  TargetIdSchema,
  VenueLayoutIdSchema,
  type TargetId,
  type VenueLayoutId,
} from './ids.ts';
import {
  MAX_MULTIPLIER_FACTOR,
  MAX_SHOWER_COINS,
  PROP_REWARD_KINDS,
  PropRewardSchema,
  TargetHitSchema,
} from './rewards.ts';

describe('prop ids', () => {
  it.each([
    ['layout', VenueLayoutIdSchema],
    ['target', TargetIdSchema],
  ] as const)('%s ids accept config keys and refuse the rest', (_, schema) => {
    for (const key of [
      propsLayoutId,
      'backWall.leftChute',
      'a',
      'a'.repeat(CATALOG_KEY_MAX_LENGTH),
    ]) {
      const { parsed, reparsed } = roundTrip(schema, key);
      expect(reparsed).toBe(parsed);
    }
    for (const bad of [
      '',
      'Riviera',
      'left chute',
      'chute-',
      'a'.repeat(CATALOG_KEY_MAX_LENGTH + 1),
      3,
      null,
    ]) {
      expect(schema.safeParse(bad).success, String(bad)).toBe(false);
    }
  });

  it('names the expected kind in the error', () => {
    expect(VenueLayoutIdSchema.safeParse('Riviera Yacht').error?.issues[0]?.message).toContain(
      'VenueLayoutId',
    );
  });

  it('keeps jackpot balls apart from coins and other entities', () => {
    expect(JackpotBallIdSchema.safeParse('jackpot_Obsidian0001').success).toBe(true);
    for (const bad of [
      'coin_Obsidian0001',
      'jackpot_short',
      'jackpot_',
      'jackpot_bad-chars!!',
      '',
    ]) {
      expect(JackpotBallIdSchema.safeParse(bad).success, bad).toBe(false);
    }
    expect(CoinIdSchema.safeParse('jackpot_Obsidian0001').success).toBe(false);
  });

  it('brands layouts and targets apart', () => {
    expectTypeOf<VenueLayoutId>().not.toEqualTypeOf<TargetId>();
  });

  it('lists every mechanic the sim models', () => {
    expect(PROP_KINDS).toEqual([
      'target',
      'pegField',
      'turntable',
      'conveyor',
      'gate',
      'jackpotBall',
    ]);
  });
});

describe('prop claims', () => {
  it('round-trip both claim kinds through the wire', () => {
    for (const claim of [propsTargetClaim, propsJackpotBallClaim]) {
      const { parsed, reparsed } = roundTrip(PropClaimSchema, claim);
      expect(reparsed).toEqual(parsed);
      expect(ClaimWithPropsSchema.parse(claim)).toEqual(parsed);
    }
  });

  it('refuse any value, reward or timestamp the client might try to smuggle in', () => {
    for (const extra of [
      { value: 5_000 },
      { reward: propsRewards.shower },
      { at: propsNow },
      { credited: 1 },
    ]) {
      expect(TargetClaimSchema.safeParse({ ...propsTargetClaim, ...extra }).success).toBe(false);
      expect(JackpotBallClaimSchema.safeParse({ ...propsJackpotBallClaim, ...extra }).success).toBe(
        false,
      );
    }
  });

  it('refuse a target claim without a known-shaped coin or target', () => {
    expect(
      TargetClaimSchema.safeParse({ ...propsTargetClaim, coinId: 'jackpot_Obsidian0001' }).success,
    ).toBe(false);
    expect(
      TargetClaimSchema.safeParse({ ...propsTargetClaim, targetId: 'Left Chute' }).success,
    ).toBe(false);
    expect(TargetClaimSchema.safeParse({ ...propsTargetClaim, tick: -1 }).success).toBe(false);
    expect(
      JackpotBallClaimSchema.safeParse({ ...propsJackpotBallClaim, edge: 'top' }).success,
    ).toBe(false);
  });

  it('stay out of the live claim schemas until the server settles them', () => {
    for (const claim of [propsTargetClaim, propsJackpotBallClaim]) {
      expect(ClaimSchema.safeParse(claim).success).toBe(false);
      expect(ClaimWithPrizeSchema.safeParse(claim).success).toBe(false);
    }
  });

  it('extend every existing claim kind rather than replacing them', () => {
    const kinds = ClaimWithPropsSchema.options.map((o) => o.shape.kind.value);
    expect(kinds).toEqual(['fall', 'fusion', 'crate', 'prize', 'target', 'jackpotBall']);
  });

  it('batch within the shared limit', () => {
    expect(ClaimsWithPropsRequestSchema.safeParse({ claims: [] }).success).toBe(false);
    expect(
      ClaimsWithPropsRequestSchema.safeParse({
        claims: Array.from({ length: MAX_CLAIMS_PER_BATCH }, () => propsTargetClaim),
      }).success,
    ).toBe(true);
    expect(
      ClaimsWithPropsRequestSchema.safeParse({
        claims: Array.from({ length: MAX_CLAIMS_PER_BATCH + 1 }, () => propsTargetClaim),
      }).success,
    ).toBe(false);
  });
});

describe('prop rewards', () => {
  it('cover shower, crate and multiplier window, each round-tripping', () => {
    expect(Object.keys(propsRewards)).toEqual([...PROP_REWARD_KINDS]);
    for (const reward of Object.values(propsRewards)) {
      const { parsed, reparsed } = roundTrip(PropRewardSchema, reward);
      expect(reparsed).toEqual(parsed);
    }
    expect(roundTrip(TargetHitSchema, propsTargetHit).reparsed).toEqual(propsTargetHit);
  });

  it('bound the shower size', () => {
    for (const coins of [0, MAX_SHOWER_COINS + 1, 1.5]) {
      expect(PropRewardSchema.safeParse({ kind: 'shower', coins }).success, String(coins)).toBe(
        false,
      );
    }
    expect(PropRewardSchema.safeParse({ kind: 'shower', coins: MAX_SHOWER_COINS }).success).toBe(
      true,
    );
  });

  it('only accept a real multiplier over a window that ends after it starts', () => {
    const window = propsRewards.multiplierWindow;
    for (const factor of [1, 0.5, MAX_MULTIPLIER_FACTOR + 0.01]) {
      expect(PropRewardSchema.safeParse({ ...window, factor }).success, String(factor)).toBe(false);
    }
    expect(PropRewardSchema.safeParse({ ...window, endsAt: window.startsAt }).success).toBe(false);
    expect(PropRewardSchema.safeParse({ ...window, factor: MAX_MULTIPLIER_FACTOR }).success).toBe(
      true,
    );
  });

  it('refuse unknown kinds and stray fields', () => {
    expect(PropRewardSchema.safeParse({ kind: 'jackpot', coins: 3 }).success).toBe(false);
    expect(PropRewardSchema.safeParse({ ...propsRewards.shower, value: 9_999 }).success).toBe(
      false,
    );
    expect(
      PropRewardSchema.safeParse({
        ...propsRewards.crate,
        crate: { id: 'crate_Riv1era0007', kind: 'gold' },
      }).success,
    ).toBe(false);
  });
});
