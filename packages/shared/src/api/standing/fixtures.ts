import type { z } from 'zod';
import type { AchievementSchema, AchievementStatus } from './achievements.ts';
import type { StandingEndpointName, StandingEndpoints } from './endpoints.ts';
import type { PerkSchema } from './perks.ts';
import type { RankProgressSchema } from './ranks.ts';
import type { StaffMemberSchema, StaffStatus } from './staff.ts';

type BodyInput<N extends StandingEndpointName> = StandingEndpoints[N]['body'] extends z.ZodType
  ? z.input<StandingEndpoints[N]['body']>
  : never;

type BodyField<N extends StandingEndpointName> = [BodyInput<N>] extends [never]
  ? object
  : { body: BodyInput<N> };

export type StandingEndpointFixture<N extends StandingEndpointName> = BodyField<N> & {
  response: z.input<StandingEndpoints[N]['response']>;
};

const day = 86_400_000;
export const standingNow = 1_763_164_800_000;

const wallet = {
  coins: 18_400,
  bullion: 2,
  goldBars: 1,
  pearls: 46,
  keys: 1,
  tickets: 3,
  stars: 0,
};

const baronCrest = {
  id: 'baron1-crest',
  rank: { title: 'baron', grade: 1 },
  effect: { kind: 'cosmetic', cosmetic: 'baronsCrest' },
} satisfies z.input<typeof PerkSchema>;
const baronAutoDrop = {
  id: 'baron1-autoDrop',
  rank: { title: 'baron', grade: 1 },
  effect: { kind: 'unlock', feature: 'autoDrop' },
} satisfies z.input<typeof PerkSchema>;
const dukeOfflineCap = {
  id: 'duke1-offlineCap',
  rank: { title: 'duke', grade: 1 },
  effect: { kind: 'offlineCap', durationMs: 3_600_000 },
} satisfies z.input<typeof PerkSchema>;
const monarchThrone = {
  id: 'monarch-throne',
  rank: { title: 'monarch', stars: 0 },
  effect: { kind: 'cosmetic', cosmetic: 'loungeThrone' },
} satisfies z.input<typeof PerkSchema>;

/** Perks lowest rank first, as `RanksResponse.perks` lists them. */
export const standingPerks = [baronCrest, baronAutoDrop, dukeOfflineCap, monarchThrone];

/** Commoner V, 120 Repute short of Baron I. */
export const standingProgress = {
  rank: { title: 'commoner', grade: 5 },
  repute: 4_930,
  reputeIntoRank: 1_930,
  reputeToNext: 2_050,
} satisfies z.input<typeof RankProgressSchema>;

/** The same player after a claim that made Baron I. */
const baronProgress = {
  rank: { title: 'baron', grade: 1 },
  repute: 5_180,
  reputeIntoRank: 130,
  reputeToNext: 3_075,
} satisfies z.input<typeof RankProgressSchema>;

export const standingAchievements = {
  locked: {
    id: 'hundredFusions',
    category: 'fusion',
    grade: 'silver',
    hidden: false,
    goal: 100,
    progress: 64,
    rewards: [
      { kind: 'repute', amount: 150 },
      { kind: 'currency', currency: 'pearls', amount: 5 },
    ],
    status: 'locked',
    unlockedAt: null,
    claimedAt: null,
  },
  unlocked: {
    id: 'firstCascade',
    category: 'pushing',
    grade: 'bronze',
    hidden: false,
    goal: 1,
    progress: 1,
    rewards: [{ kind: 'repute', amount: 250 }],
    status: 'unlocked',
    unlockedAt: standingNow - 3_600_000,
    claimedAt: null,
  },
  claimed: {
    id: 'firstTrophy',
    category: 'collecting',
    grade: 'gold',
    hidden: true,
    goal: 1,
    progress: 1,
    rewards: [
      { kind: 'trophy', trophy: 'firstTrophy' },
      { kind: 'cosmetic', cosmetic: 'gildedVitrine' },
    ],
    status: 'claimed',
    unlockedAt: standingNow - 2 * day,
    claimedAt: standingNow - 2 * day + 60_000,
  },
} satisfies Record<AchievementStatus, z.input<typeof AchievementSchema>>;

export const standingStaff = {
  vacant: { role: 'valet', status: 'vacant', hireCost: 54_000 },
  employed: {
    role: 'butler',
    status: 'employed',
    level: 3,
    maxLevel: 10,
    hiredAt: standingNow - 9 * day,
    training: { level: 4, fee: 64_800, eligibleAt: standingNow - 2 * day },
    idleBoostBp: 1_500,
    dailyWage: 2_250,
    wagesPaidUntil: standingNow + 6 * 3_600_000,
  },
  onLeave: {
    role: 'sommelier',
    status: 'onLeave',
    level: 1,
    maxLevel: 10,
    hiredAt: standingNow - 4 * day,
    training: { level: 2, fee: 32_400, eligibleAt: standingNow - 2 * day },
    leaveSince: standingNow - day,
    wagesOwed: 900,
  },
} satisfies Record<StaffStatus, z.input<typeof StaffMemberSchema>>;

/** One valid wire example per standing endpoint; the mapped type fails to compile if one is missing. */
export const standingFixtures: {
  [N in StandingEndpointName]: StandingEndpointFixture<N>;
} = {
  standingRanks: {
    response: { serverTime: standingNow, progress: standingProgress, perks: standingPerks },
  },
  standingAchievements: {
    response: {
      serverTime: standingNow,
      achievements: [
        standingAchievements.locked,
        standingAchievements.unlocked,
        standingAchievements.claimed,
      ],
      showcase: ['firstTrophy', 'firstCascade'],
    },
  },
  standingAchievementClaim: {
    body: { achievementId: 'firstCascade' },
    response: {
      achievementId: 'firstCascade',
      claimedAt: standingNow,
      granted: [{ kind: 'repute', amount: 250 }],
      wallet,
      progress: baronProgress,
      rankUps: [{ rank: { title: 'baron', grade: 1 }, perks: [baronCrest, baronAutoDrop] }],
    },
  },
  standingShowcase: {
    body: { showcase: ['firstCascade', 'firstTrophy'] },
    response: { showcase: ['firstCascade', 'firstTrophy'] },
  },
  standingMastery: {
    response: {
      tracks: [
        {
          track: { kind: 'coinTier', tier: 'copper' },
          level: 4,
          maxLevel: 10,
          points: 1_740,
          pointsIntoLevel: 240,
          pointsToNext: 800,
          bonusBp: 400,
        },
        {
          track: { kind: 'coinTier', tier: 'heirloom' },
          level: 0,
          maxLevel: 10,
          points: 0,
          pointsIntoLevel: 0,
          pointsToNext: 100,
          bonusBp: 0,
        },
        {
          track: { kind: 'charm', charm: 'butler' },
          level: 10,
          maxLevel: 10,
          points: 51_900,
          pointsIntoLevel: 750,
          pointsToNext: null,
          bonusBp: 2_000,
        },
      ],
    },
  },
  standingStaff: {
    response: {
      serverTime: standingNow,
      staff: [standingStaff.employed, standingStaff.vacant, standingStaff.onLeave],
      idleBoostBp: 1_500,
      idleBoostCapBp: 6_000,
    },
  },
  standingStaffHire: {
    body: { role: 'valet' },
    response: {
      staff: {
        role: 'valet',
        status: 'employed',
        level: 1,
        maxLevel: 10,
        hiredAt: standingNow,
        training: { level: 2, fee: 32_400, eligibleAt: standingNow + 2 * day },
        idleBoostBp: 500,
        dailyWage: 0,
        wagesPaidUntil: standingNow + day,
      },
      wallet,
      idleBoostBp: 2_000,
    },
  },
  standingStaffTrain: {
    body: { role: 'butler', level: 4 },
    response: {
      staff: {
        ...standingStaff.employed,
        level: 4,
        training: { level: 5, fee: 81_000, eligibleAt: standingNow + day },
        idleBoostBp: 2_000,
      },
      wallet,
      idleBoostBp: 2_000,
    },
  },
  standingStaffPay: {
    body: { role: 'sommelier' },
    response: {
      staff: {
        role: 'sommelier',
        status: 'employed',
        level: 1,
        maxLevel: 10,
        hiredAt: standingStaff.onLeave.hiredAt,
        training: standingStaff.onLeave.training,
        idleBoostBp: 500,
        dailyWage: 450,
        wagesPaidUntil: standingNow + day,
      },
      wallet,
      idleBoostBp: 2_000,
    },
  },
};
