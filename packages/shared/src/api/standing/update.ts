import { z } from 'zod';
import { AchievementUnlockSchema } from './achievements.ts';
import { MasteryLevelUpSchema, masteryTrackKey } from './mastery.ts';
import { RankUpSchema } from './perks.ts';
import { RankProgressSchema } from './ranks.ts';
import { checkRankUps, checkUnique } from './refine.ts';
import { ReputeGainSchema } from './repute.ts';

/**
 * What one accepted server step (a claim batch, a crate open, a quest claim) did to standing.
 * Server routes attach it to their answers so the HUD bar, the rank-up seal, the achievement
 * toast and the mastery chime play from server truth; it is never uploaded.
 */
export const StandingUpdateSchema = z
  .object({
    gains: z.array(ReputeGainSchema),
    progress: RankProgressSchema,
    rankUps: z.array(RankUpSchema),
    achievements: z.array(AchievementUnlockSchema),
    mastery: z.array(MasteryLevelUpSchema),
  })
  .superRefine((update, ctx) => {
    checkUnique(
      update.gains,
      (gain) => gain.source,
      ctx,
      (i) => ['gains', i, 'source'],
      'Gains are summed per source.',
    );
    const gained = update.gains.reduce((sum, gain) => sum + gain.amount, 0);
    if (gained > update.progress.repute) {
      ctx.addIssue({
        code: 'custom',
        path: ['gains'],
        message: `${gained} Repute gained exceeds the ${update.progress.repute} lifetime total.`,
      });
    }
    if (update.rankUps.length > 0 && gained === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['rankUps'],
        message: 'Only Repute gained in this step can rank the player up.',
      });
    }
    checkRankUps(update.rankUps, update.progress.rank, ctx, ['rankUps']);
    checkUnique(
      update.achievements,
      (unlock) => unlock.id,
      ctx,
      (i) => ['achievements', i, 'id'],
      'An achievement unlocks once.',
    );
    checkUnique(
      update.mastery,
      (levelUp) => masteryTrackKey(levelUp.track),
      ctx,
      (i) => ['mastery', i, 'track'],
      'Each track reports its newest level once.',
    );
  });
export type StandingUpdate = z.infer<typeof StandingUpdateSchema>;
