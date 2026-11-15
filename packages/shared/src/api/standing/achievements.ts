import { z } from 'zod';
import { CurrencySchema, RewardSchema, WalletSchema } from '../../domain.ts';
import { TrophyIdSchema } from '../../ids.ts';
import { AmountSchema, EpochMsSchema, PositiveAmountSchema } from '../../primitives.ts';
import { AchievementIdSchema, StandingCosmeticIdSchema } from './ids.ts';
import { RankUpSchema } from './perks.ts';
import { RankProgressSchema } from './ranks.ts';
import { checkRankUps, checkUnique } from './refine.ts';

/** The filters of the achievement list; every definition in `packages/economy` names one. */
export const ACHIEVEMENT_CATEGORIES = [
  'pushing',
  'fusion',
  'loot',
  'charms',
  'collecting',
  'venues',
  'standing',
  'social',
  'events',
] as const;
export const AchievementCategorySchema = z.enum(ACHIEVEMENT_CATEGORIES);
export type AchievementCategory = z.infer<typeof AchievementCategorySchema>;

/** Lowest to highest: the badge metal, and how loud the unlock flourish plays. */
export const ACHIEVEMENT_GRADES = ['bronze', 'silver', 'gold', 'platinum'] as const;
export const AchievementGradeSchema = z.enum(ACHIEVEMENT_GRADES);
export type AchievementGrade = z.infer<typeof AchievementGradeSchema>;

/** `unlocked` is earned but its reward not yet taken; `claimed` has paid out. */
export const ACHIEVEMENT_STATUSES = ['locked', 'unlocked', 'claimed'] as const;
export const AchievementStatusSchema = z.enum(ACHIEVEMENT_STATUSES);
export type AchievementStatus = z.infer<typeof AchievementStatusSchema>;

/** Transport bound and design rule: the profile showcases at most six badges. */
export const MAX_ACHIEVEMENT_SHOWCASE = 6;

const reputeReward = z.object({ kind: z.literal('repute'), amount: PositiveAmountSchema });
const trophyReward = z.object({ kind: z.literal('trophy'), trophy: TrophyIdSchema });
const cosmeticReward = z.object({
  kind: z.literal('cosmetic'),
  cosmetic: StandingCosmeticIdSchema,
});

/** What an achievement promises, shown before it is claimed. */
export const AchievementRewardSchema = z.discriminatedUnion('kind', [
  reputeReward,
  z.object({ kind: z.literal('currency'), currency: CurrencySchema, amount: PositiveAmountSchema }),
  trophyReward,
  cosmeticReward,
]);
export type AchievementReward = z.infer<typeof AchievementRewardSchema>;

/** What a claim granted: any table reward, plus the Repute, trophy or cosmetic standing adds. */
export const AchievementGrantSchema = z.discriminatedUnion('kind', [
  ...RewardSchema.options,
  reputeReward,
  trophyReward,
  cosmeticReward,
]);
export type AchievementGrant = z.infer<typeof AchievementGrantSchema>;

/**
 * One badge as the server counts it. `progress` comes from server counters only and is capped at
 * `goal`; `hidden` badges keep their name secret in the UI until unlocked.
 */
export const AchievementSchema = z
  .object({
    id: AchievementIdSchema,
    category: AchievementCategorySchema,
    grade: AchievementGradeSchema,
    hidden: z.boolean(),
    goal: PositiveAmountSchema,
    progress: AmountSchema,
    rewards: z.array(AchievementRewardSchema).min(1),
    status: AchievementStatusSchema,
    unlockedAt: EpochMsSchema.nullable(),
    claimedAt: EpochMsSchema.nullable(),
  })
  .superRefine((badge, ctx) => {
    const issue = (path: string, message: string) => {
      ctx.addIssue({ code: 'custom', path: [path], message });
    };
    if (badge.progress > badge.goal) issue('progress', 'Progress is capped at the goal.');
    if (badge.status === 'locked') {
      if (badge.progress === badge.goal) issue('status', 'A badge at its goal is unlocked.');
      if (badge.unlockedAt !== null) issue('unlockedAt', 'A locked badge has no unlock time.');
      if (badge.claimedAt !== null) issue('claimedAt', 'A locked badge cannot be claimed.');
      return;
    }
    if (badge.progress !== badge.goal) issue('progress', 'An unlocked badge has met its goal.');
    if (badge.unlockedAt === null) issue('unlockedAt', 'An unlocked badge has an unlock time.');
    if (badge.status === 'unlocked' && badge.claimedAt !== null) {
      issue('claimedAt', 'A badge with a claim time is claimed.');
    }
    if (badge.status === 'claimed') {
      if (badge.claimedAt === null) issue('claimedAt', 'A claimed badge has a claim time.');
      else if (badge.unlockedAt !== null && badge.claimedAt < badge.unlockedAt) {
        issue('claimedAt', 'A badge is claimed after it unlocks.');
      }
    }
  });
export type Achievement = z.infer<typeof AchievementSchema>;

/** Badges in showcase order, each once; the server checks every one is unlocked. */
export const AchievementShowcaseSchema = z
  .array(AchievementIdSchema)
  .max(MAX_ACHIEVEMENT_SHOWCASE)
  .superRefine((showcase, ctx) => {
    checkUnique(
      showcase,
      (id) => id,
      ctx,
      (i) => [i],
      'A badge is showcased once.',
    );
  });
export type AchievementShowcase = z.infer<typeof AchievementShowcaseSchema>;

export const AchievementsResponseSchema = z
  .object({
    serverTime: EpochMsSchema,
    achievements: z.array(AchievementSchema),
    showcase: AchievementShowcaseSchema,
  })
  .superRefine((book, ctx) => {
    checkUnique(
      book.achievements,
      (badge) => badge.id,
      ctx,
      (i) => ['achievements', i, 'id'],
      'Each achievement is listed once.',
    );
    book.achievements.forEach((badge, i) => {
      for (const key of ['unlockedAt', 'claimedAt'] as const) {
        const at = badge[key];
        if (at !== null && at > book.serverTime) {
          ctx.addIssue({
            code: 'custom',
            path: ['achievements', i, key],
            message: 'A badge cannot change state after the server time it is reported at.',
          });
        }
      }
    });
    const statusById = new Map(book.achievements.map((badge) => [badge.id, badge.status]));
    book.showcase.forEach((id, i) => {
      const status = statusById.get(id);
      if (status === undefined || status === 'locked') {
        ctx.addIssue({
          code: 'custom',
          path: ['showcase', i],
          message: `Badge ${id} is not unlocked, so it cannot be showcased.`,
        });
      }
    });
  });
export type AchievementsResponse = z.infer<typeof AchievementsResponseSchema>;

/** Names the badge only: the server knows whether it is unlocked and what it pays. */
export const AchievementClaimRequestSchema = z.strictObject({
  achievementId: AchievementIdSchema,
});
export type AchievementClaimRequest = z.infer<typeof AchievementClaimRequestSchema>;

/** The payout, plus the rank bar after the claim's Repute, with any rank-ups it caused. */
export const AchievementClaimResponseSchema = z
  .object({
    achievementId: AchievementIdSchema,
    claimedAt: EpochMsSchema,
    granted: z.array(AchievementGrantSchema).min(1),
    wallet: WalletSchema,
    progress: RankProgressSchema,
    rankUps: z.array(RankUpSchema),
  })
  .superRefine((claim, ctx) => {
    checkRankUps(claim.rankUps, claim.progress.rank, ctx, ['rankUps']);
  });
export type AchievementClaimResponse = z.infer<typeof AchievementClaimResponseSchema>;

/** Replaces the whole showcase, in display order. Ids only. */
export const AchievementShowcaseRequestSchema = z.strictObject({
  showcase: AchievementShowcaseSchema,
});
export type AchievementShowcaseRequest = z.infer<typeof AchievementShowcaseRequestSchema>;

export const AchievementShowcaseResponseSchema = z.object({
  showcase: AchievementShowcaseSchema,
});
export type AchievementShowcaseResponse = z.infer<typeof AchievementShowcaseResponseSchema>;

/** A badge the server just unlocked, for the toast; claiming it is a separate step. */
export const AchievementUnlockSchema = z.object({
  id: AchievementIdSchema,
  category: AchievementCategorySchema,
  grade: AchievementGradeSchema,
  unlockedAt: EpochMsSchema,
});
export type AchievementUnlock = z.infer<typeof AchievementUnlockSchema>;
