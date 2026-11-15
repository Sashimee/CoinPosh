import { describe, expect, it } from 'vitest';
import { roundTrip } from '../../test/roundTrip.ts';
import {
  BOSS_KINDS,
  BOSS_STATUSES,
  BossClaimRequestSchema,
  BossClaimResponseSchema,
  BossHitSchema,
  BossResponseSchema,
  BossSchema,
  BossTiersSchema,
  bossTierFor,
} from './boss.ts';
import { liveBosses, liveBossResponse, liveEventsFixtures, liveNow } from './fixtures.ts';

const { active, defeated, escaped } = liveBosses;
const tiers = BossTiersSchema.parse(liveBossResponse.tiers);
const issuePaths = (result: { error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => issue.path);

describe('BossSchema', () => {
  it('fields the two figures of 00-VISION', () => {
    expect(BOSS_KINDS).toEqual(['taxInspector', 'rivalTycoon']);
  });

  it.each(BOSS_STATUSES)('round-trips a boss that is %s', (status) => {
    const { parsed, reparsed } = roundTrip(BossSchema, liveBosses[status]);
    expect(reparsed).toEqual(parsed);
  });

  it('accepts a fresh boss at full health, and one hit down to its last coin of health', () => {
    expect(
      BossSchema.safeParse({ ...active, health: active.maxHealth, contributors: 0 }).success,
    ).toBe(true);
    expect(BossSchema.safeParse({ ...active, health: 1 }).success).toBe(true);
  });

  it.each([
    ['health over the maximum', active, { health: active.maxHealth + 1 }, ['health']],
    ['an active boss at 0 health', active, { health: 0 }, ['health']],
    ['an escaped boss at 0 health', escaped, { health: 0 }, ['health']],
    ['a defeated boss with health left', defeated, { health: 1 }, ['health']],
    ['a defeated boss with no defeat time', defeated, { defeatedAt: null }, ['defeatedAt']],
    ['a defeat after the week', defeated, { defeatedAt: defeated.endsAt + 1 }, ['defeatedAt']],
    ['a defeat before the week', defeated, { defeatedAt: defeated.startsAt - 1 }, ['defeatedAt']],
    ['a defeat time on a live boss', active, { defeatedAt: liveNow }, ['defeatedAt']],
    ['lost health nobody dealt', active, { contributors: 0 }, ['contributors']],
    ['a week that ends as it starts', active, { endsAt: active.startsAt }, ['endsAt']],
  ])('refuses %s', (_label, boss, change, path) => {
    expect(issuePaths(BossSchema.safeParse({ ...boss, ...change }))).toContainEqual(path);
  });

  it('refuses a boss that would take coins: health cannot go below 0', () => {
    expect(BossSchema.safeParse({ ...active, health: -1 }).success).toBe(false);
  });
});

describe('boss tiers', () => {
  it('ranks damage into the highest tier it reaches', () => {
    expect(bossTierFor(tiers, 0)).toBeNull();
    expect(bossTierFor(tiers, 4_999)).toBeNull();
    expect(bossTierFor(tiers, 5_000)).toBe(1);
    expect(bossTierFor(tiers, 24_999)).toBe(1);
    expect(bossTierFor(tiers, 25_000)).toBe(2);
    expect(bossTierFor(tiers, 10_000_000)).toBe(3);
  });

  it.each([
    ['no tiers', []],
    ['tiers out of order', [tiers[1], tiers[0]]],
    ['a tier asking no more than the one below', [tiers[0], { ...tiers[1], minDamage: 5_000 }]],
    ['tiers numbered from 0', tiers.map((tier) => ({ ...tier, tier: tier.tier - 1 }))],
    ['a tier with no rewards', [{ ...tiers[0], rewards: [] }]],
  ])('refuses %s', (_label, list) => {
    expect(BossTiersSchema.safeParse(list).success).toBe(false);
  });
});

describe('BossResponseSchema', () => {
  it('round-trips the fixture', () => {
    const { parsed, reparsed } = roundTrip(BossResponseSchema, liveBossResponse);
    expect(reparsed).toEqual(parsed);
  });

  it('opens the claim once the boss falls, overkill included', () => {
    const fallen = {
      ...liveBossResponse,
      boss: defeated,
      contribution: { damage: defeated.maxHealth + 4_000, tier: 3, claimedAt: null },
      claimable: true,
    };
    expect(BossResponseSchema.safeParse(fallen).error).toBeUndefined();
    const paid = {
      ...fallen,
      contribution: { ...fallen.contribution, claimedAt: liveNow },
      claimable: false,
    };
    expect(BossResponseSchema.safeParse(paid).error).toBeUndefined();
  });

  it('opens the claim for an escaped boss too, with no claim for a non-contributor', () => {
    const gone = {
      ...liveBossResponse,
      boss: escaped,
      contribution: { damage: 6_000, tier: 1, claimedAt: null },
      claimable: true,
    };
    expect(BossResponseSchema.safeParse(gone).success).toBe(true);
    const idle = {
      ...gone,
      contribution: { damage: 0, tier: null, claimedAt: null },
      claimable: false,
    };
    expect(BossResponseSchema.safeParse(idle).success).toBe(true);
  });

  it.each([
    [
      'the wrong tier',
      { contribution: { ...liveBossResponse.contribution, tier: 3 } },
      ['contribution', 'tier'],
    ],
    [
      'a tier below the first threshold',
      { contribution: { damage: 100, tier: 1, claimedAt: null } },
      ['contribution', 'tier'],
    ],
    [
      'more damage than the boss lost',
      { contribution: { damage: active.maxHealth, tier: 3, claimedAt: null } },
      ['contribution', 'damage'],
    ],
    [
      'a claim during the fight',
      { contribution: { ...liveBossResponse.contribution, claimedAt: liveNow } },
      ['contribution', 'claimedAt'],
    ],
    ['a claim offered during the fight', { claimable: true }, ['claimable']],
    ['an active boss after its week', { serverTime: active.endsAt }, ['boss', 'status']],
    [
      'an escape before the week is over',
      { boss: { ...escaped, endsAt: liveNow + 1, startsAt: liveNow - 1 } },
      ['boss', 'status'],
    ],
  ])('refuses %s', (_label, change, path) => {
    expect(
      issuePaths(BossResponseSchema.safeParse({ ...liveBossResponse, ...change })),
    ).toContainEqual(path);
  });
});

describe('boss claim', () => {
  it('names the week only, never damage or a tier', () => {
    expect(BossClaimRequestSchema.safeParse({ week: '2026-W45' }).success).toBe(true);
    for (const forged of [
      { week: '2026-W45', damage: 1_000_000 },
      { week: '2026-W45', tier: 3 },
      { week: '2026-W54' },
      {},
    ]) {
      expect(BossClaimRequestSchema.safeParse(forged).success).toBe(false);
    }
  });

  it('round-trips the payout', () => {
    const answer = liveEventsFixtures.liveEventsBossClaim.response;
    const { parsed, reparsed } = roundTrip(BossClaimResponseSchema, answer);
    expect(reparsed).toEqual(parsed);
    expect(BossClaimResponseSchema.safeParse({ ...answer, granted: [] }).success).toBe(false);
  });
});

describe('BossHitSchema', () => {
  const hit = {
    week: active.week,
    kind: active.kind,
    dealt: 1_200,
    damage: 31_400,
    health: active.health,
    maxHealth: active.maxHealth,
    defeated: false,
  };

  it('round-trips a hit and the killing blow, which may overshoot', () => {
    expect(roundTrip(BossHitSchema, hit).reparsed).toEqual(BossHitSchema.parse(hit));
    const blow = { ...hit, dealt: 9_000, health: 0, defeated: true, damage: active.maxHealth + 1 };
    expect(BossHitSchema.safeParse(blow).error).toBeUndefined();
  });

  it.each([
    ['a hit bigger than the week total', { dealt: 31_401 }, ['dealt']],
    ['a defeat with health left', { defeated: true }, ['defeated']],
    ['an empty bar that is not a defeat', { health: 0 }, ['defeated']],
    ['more damage than the boss lost', { damage: active.maxHealth }, ['damage']],
    ['health over the maximum', { health: active.maxHealth + 1 }, ['health']],
  ])('refuses %s', (_label, change, path) => {
    expect(issuePaths(BossHitSchema.safeParse({ ...hit, ...change }))).toContainEqual(path);
  });

  it('refuses a hit that heals or deals nothing', () => {
    for (const dealt of [0, -500]) {
      expect(BossHitSchema.safeParse({ ...hit, dealt }).success).toBe(false);
    }
  });
});
