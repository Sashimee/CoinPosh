import { describe, expect, it } from 'vitest';
import { roundTrip } from '../../test/roundTrip.ts';
import {
  ACHIEVEMENT_STATUSES,
  AchievementClaimRequestSchema,
  AchievementClaimResponseSchema,
  AchievementGrantSchema,
  AchievementSchema,
  AchievementShowcaseRequestSchema,
  AchievementShowcaseResponseSchema,
  AchievementShowcaseSchema,
  AchievementsResponseSchema,
  AchievementUnlockSchema,
  MAX_ACHIEVEMENT_SHOWCASE,
} from './achievements.ts';
import { standingAchievements, standingFixtures, standingNow } from './fixtures.ts';

const { locked, unlocked, claimed } = standingAchievements;
const book = standingFixtures.standingAchievements.response;
const claim = standingFixtures.standingAchievementClaim.response;
const issuePaths = (result: { error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => issue.path);

describe('AchievementSchema', () => {
  it.each(ACHIEVEMENT_STATUSES)('round-trips a %s badge', (status) => {
    const { parsed, reparsed } = roundTrip(AchievementSchema, standingAchievements[status]);
    expect(reparsed).toEqual(parsed);
  });

  it('accepts a badge claimed the moment it unlocked', () => {
    const instant = { ...claimed, claimedAt: claimed.unlockedAt };
    expect(AchievementSchema.safeParse(instant).success).toBe(true);
  });

  it.each([
    ['progress past the goal', locked, { progress: 101 }, ['progress']],
    ['a locked badge at its goal', locked, { progress: 100 }, ['status']],
    ['a locked badge with an unlock time', locked, { unlockedAt: standingNow }, ['unlockedAt']],
    ['a locked badge with a claim time', locked, { claimedAt: standingNow }, ['claimedAt']],
    ['an unlocked badge short of its goal', unlocked, { goal: 2 }, ['progress']],
    ['an unlocked badge with no unlock time', unlocked, { unlockedAt: null }, ['unlockedAt']],
    ['an unclaimed badge with a claim time', unlocked, { claimedAt: standingNow }, ['claimedAt']],
    ['a claimed badge with no claim time', claimed, { claimedAt: null }, ['claimedAt']],
    ['a claim before the unlock', claimed, { claimedAt: claimed.unlockedAt - 1 }, ['claimedAt']],
  ] as const)('rejects %s', (_label, badge, change, path) => {
    expect(issuePaths(AchievementSchema.safeParse({ ...badge, ...change }))).toEqual([path]);
  });

  it.each([
    ['no reward', { rewards: [] }],
    ['a reward of zero Repute', { rewards: [{ kind: 'repute', amount: 0 }] }],
    ['an unknown category', { category: 'gambling' }],
    ['an unknown grade', { grade: 'diamond' }],
    ['an unknown status', { status: 'pending' }],
    ['a goal of zero', { goal: 0, progress: 0 }],
  ])('rejects %s', (_label, change) => {
    expect(AchievementSchema.safeParse({ ...locked, ...change }).success).toBe(false);
  });
});

describe('AchievementShowcaseSchema', () => {
  it(`holds up to ${MAX_ACHIEVEMENT_SHOWCASE} badges and may be empty`, () => {
    const six = Array.from({ length: MAX_ACHIEVEMENT_SHOWCASE }, (_, i) => `badge${i}`);
    expect(AchievementShowcaseSchema.safeParse([]).success).toBe(true);
    expect(AchievementShowcaseSchema.safeParse(six).success).toBe(true);
    expect(AchievementShowcaseSchema.safeParse([...six, 'badge6']).success).toBe(false);
  });

  it('rejects a badge showcased twice', () => {
    const twice = AchievementShowcaseSchema.safeParse(['firstCascade', 'firstCascade']);
    expect(issuePaths(twice)).toEqual([[1]]);
  });
});

describe('AchievementsResponseSchema', () => {
  it('round-trips the badge list with its showcase', () => {
    const { parsed, reparsed } = roundTrip(AchievementsResponseSchema, book);
    expect(reparsed).toEqual(parsed);
  });

  it('rejects a showcased badge that is still locked', () => {
    const result = AchievementsResponseSchema.safeParse({ ...book, showcase: ['hundredFusions'] });
    expect(issuePaths(result)).toEqual([['showcase', 0]]);
  });

  it('rejects a showcased badge missing from the list', () => {
    const result = AchievementsResponseSchema.safeParse({ ...book, showcase: ['ghostBadge'] });
    expect(issuePaths(result)).toEqual([['showcase', 0]]);
  });

  it('rejects a badge listed twice', () => {
    const twice = { ...book, achievements: [unlocked, unlocked], showcase: [] };
    expect(issuePaths(AchievementsResponseSchema.safeParse(twice))).toEqual([
      ['achievements', 1, 'id'],
    ]);
  });

  it('rejects an unlock stamped after the server time', () => {
    const future = { ...book, serverTime: claimed.unlockedAt - 1, showcase: [] };
    expect(issuePaths(AchievementsResponseSchema.safeParse(future))).toEqual([
      ['achievements', 1, 'unlockedAt'],
      ['achievements', 2, 'unlockedAt'],
      ['achievements', 2, 'claimedAt'],
    ]);
  });
});

describe('achievement uploads', () => {
  it('round-trips a claim and a showcase request', () => {
    for (const [schema, body] of [
      [AchievementClaimRequestSchema, standingFixtures.standingAchievementClaim.body],
      [AchievementShowcaseRequestSchema, standingFixtures.standingShowcase.body],
    ] as const) {
      const { parsed, reparsed } = roundTrip(schema, body);
      expect(reparsed).toEqual(parsed);
    }
  });

  it.each([
    ['its own progress', { progress: 1 }],
    ['an unlock time', { unlockedAt: standingNow }],
    ['the Repute it pays', { repute: 500 }],
    ['the rewards it wants', { rewards: [{ kind: 'currency', currency: 'pearls', amount: 25 }] }],
  ])('refuses a claim that carries %s', (_label, extra) => {
    const result = AchievementClaimRequestSchema.safeParse({
      achievementId: 'firstCascade',
      ...extra,
    });
    expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
  });

  it('refuses a showcase of seven badges or one that marks badges unlocked', () => {
    const seven = Array.from({ length: 7 }, (_, i) => `badge${i}`);
    expect(AchievementShowcaseRequestSchema.safeParse({ showcase: seven }).success).toBe(false);
    const forged = AchievementShowcaseRequestSchema.safeParse({
      showcase: ['firstCascade'],
      unlocked: ['firstCascade'],
    });
    expect(forged.error?.issues[0]?.code).toBe('unrecognized_keys');
  });
});

describe('achievement answers', () => {
  it('round-trips a claim that ranked the player up, and a showcase', () => {
    const answers = [
      [AchievementClaimResponseSchema, claim],
      [AchievementShowcaseResponseSchema, standingFixtures.standingShowcase.response],
    ] as const;
    for (const [schema, body] of answers) {
      const { parsed, reparsed } = roundTrip(schema, body);
      expect(reparsed).toEqual(parsed);
    }
  });

  it('rejects a claim whose last rank-up is not the rank reached', () => {
    const stale = { ...claim, progress: { ...claim.progress, rank: { title: 'baron', grade: 2 } } };
    expect(issuePaths(AchievementClaimResponseSchema.safeParse(stale))).toEqual([
      ['rankUps', 0, 'rank'],
    ]);
  });

  it('rejects a claim that granted nothing', () => {
    expect(AchievementClaimResponseSchema.safeParse({ ...claim, granted: [] }).success).toBe(false);
  });

  it('grants table rewards as well as Repute, trophies and cosmetics', () => {
    for (const grant of [
      { kind: 'repute', amount: 500 },
      { kind: 'currency', currency: 'pearls', amount: 25 },
      { kind: 'trophy', trophy: 'firstTrophy' },
      { kind: 'cosmetic', cosmetic: 'gildedVitrine' },
      { kind: 'safe', safe: { id: 'safe_Za1Xs2Cd3V', type: 'goldSafe', unlocksAt: standingNow } },
    ]) {
      const { parsed, reparsed } = roundTrip(AchievementGrantSchema, grant);
      expect(reparsed).toEqual(parsed);
    }
  });

  it('round-trips the unlock toast', () => {
    const toast = {
      id: 'firstCascade',
      category: 'pushing',
      grade: 'bronze',
      unlockedAt: standingNow,
    };
    const { parsed, reparsed } = roundTrip(AchievementUnlockSchema, toast);
    expect(reparsed).toEqual(parsed);
  });
});
