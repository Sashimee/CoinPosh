import { z } from 'zod';
import { AmountSchema, PositiveAmountSchema } from '../../primitives.ts';

/** Lowest to highest. The graded titles have grades I–V; Monarch then counts stars. */
export const RANK_TITLES = ['commoner', 'baron', 'duke', 'monarch'] as const;
export const RankTitleSchema = z.enum(RANK_TITLES);
export type RankTitle = z.infer<typeof RankTitleSchema>;

export const GRADED_RANK_TITLES = ['commoner', 'baron', 'duke'] as const;
export const GradedRankTitleSchema = z.enum(GRADED_RANK_TITLES);
export type GradedRankTitle = z.infer<typeof GradedRankTitleSchema>;

/** Grades per graded title (I–V): part of the rank names, not a tuning number. */
export const RANK_GRADES = 5;
export const RankGradeSchema = z.int().min(1).max(RANK_GRADES);
export type RankGrade = z.infer<typeof RankGradeSchema>;

/**
 * A rank as the server computed it from lifetime Repute. How much Repute each rank needs is a
 * curve in `packages/economy`; the contract only names the rank.
 */
export const RankSchema = z.discriminatedUnion('title', [
  z.object({ title: GradedRankTitleSchema, grade: RankGradeSchema }),
  z.object({ title: z.literal('monarch'), stars: AmountSchema }),
]);
export type Rank = z.infer<typeof RankSchema>;

export const FIRST_RANK: Rank = { title: 'commoner', grade: 1 };

/** Commoner I is step 0, Duke V step 14, Monarch step 15 and each Monarch star one more. */
export const MONARCH_STEP = GRADED_RANK_TITLES.length * RANK_GRADES;

export function rankStep(rank: Rank): number {
  if (rank.title === 'monarch') return MONARCH_STEP + rank.stars;
  return GRADED_RANK_TITLES.indexOf(rank.title) * RANK_GRADES + rank.grade - 1;
}

export function rankFromStep(step: number): Rank {
  if (!Number.isSafeInteger(step) || step < 0) {
    throw new RangeError(`A rank step is a non-negative integer, got ${step}.`);
  }
  if (step >= MONARCH_STEP) return { title: 'monarch', stars: step - MONARCH_STEP };
  const title = GRADED_RANK_TITLES[Math.floor(step / RANK_GRADES)];
  if (title === undefined) throw new RangeError(`No graded title for rank step ${step}.`);
  return { title, grade: (step % RANK_GRADES) + 1 };
}

export function nextRank(rank: Rank): Rank {
  return rankFromStep(rankStep(rank) + 1);
}

/** Negative when `a` is below `b`, zero when equal, positive when above. */
export function compareRanks(a: Rank, b: Rank): number {
  return rankStep(a) - rankStep(b);
}

/** A stable key for i18n, crests and dedup: `commoner-1` … `duke-5`, `monarch-0`, `monarch-3`. */
export function rankKey(rank: Rank): string {
  return rank.title === 'monarch' ? `monarch-${rank.stars}` : `${rank.title}-${rank.grade}`;
}

/** Every rank up to Monarch, lowest first: the rank road the UI draws before the stars. */
export const RANK_ROAD: readonly Rank[] = Array.from({ length: MONARCH_STEP + 1 }, (_, step) =>
  rankFromStep(step),
);

/** The bar toward the next rank, as the server measured it from lifetime Repute. */
export const RankProgressSchema = z
  .object({
    rank: RankSchema,
    /** Lifetime Repute; it never resets, unlike season Stars. */
    repute: AmountSchema,
    /** Repute earned since this rank was reached. */
    reputeIntoRank: AmountSchema,
    /** Repute this rank needs before the next one, from the curve in `packages/economy`. */
    reputeToNext: PositiveAmountSchema,
  })
  .superRefine((progress, ctx) => {
    if (progress.reputeIntoRank >= progress.reputeToNext) {
      ctx.addIssue({
        code: 'custom',
        path: ['reputeIntoRank'],
        message:
          'Repute into a rank stays below what the next rank needs; the server ranks up first.',
      });
    }
    if (progress.reputeIntoRank > progress.repute) {
      ctx.addIssue({
        code: 'custom',
        path: ['reputeIntoRank'],
        message: 'Repute into a rank cannot exceed lifetime Repute.',
      });
    }
  });
export type RankProgress = z.infer<typeof RankProgressSchema>;
