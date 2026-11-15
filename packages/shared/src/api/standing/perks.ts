import { z } from 'zod';
import { EpochMsSchema, PositiveAmountSchema } from '../../primitives.ts';
import {
  PerkIdSchema,
  StandingCosmeticIdSchema,
  StandingFeatureIdSchema,
  StandingStatIdSchema,
} from './ids.ts';
import { compareRanks, RankProgressSchema, RankSchema, rankKey, type Rank } from './ranks.ts';
import { checkUnique } from './refine.ts';

/**
 * What a perk does once its rank is reached. Magnitudes come from `packages/economy` and the
 * server applies them inside the global boost cap; the client only shows them.
 */
export const PerkEffectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unlock'), feature: StandingFeatureIdSchema }),
  z.object({ kind: z.literal('boost'), stat: StandingStatIdSchema, bp: PositiveAmountSchema }),
  z.object({ kind: z.literal('offlineCap'), durationMs: PositiveAmountSchema }),
  z.object({ kind: z.literal('cosmetic'), cosmetic: StandingCosmeticIdSchema }),
]);
export type PerkEffect = z.infer<typeof PerkEffectSchema>;
export type PerkEffectKind = PerkEffect['kind'];

export const PerkSchema = z.object({
  id: PerkIdSchema,
  rank: RankSchema,
  effect: PerkEffectSchema,
});
export type Perk = z.infer<typeof PerkSchema>;

export function isPerkUnlocked(perk: Perk, rank: Rank): boolean {
  return compareRanks(perk.rank, rank) <= 0;
}

/** Perks listed once each, in rank-road order, so the UI can draw them without sorting. */
export const PerkRoadSchema = z.array(PerkSchema).superRefine((perks, ctx) => {
  checkUnique(
    perks,
    (perk) => perk.id,
    ctx,
    (i) => [i, 'id'],
    'Each perk is listed once.',
  );
  perks.forEach((perk, i) => {
    const previous = perks[i - 1];
    if (previous !== undefined && compareRanks(previous.rank, perk.rank) > 0) {
      ctx.addIssue({
        code: 'custom',
        path: [i, 'rank'],
        message: `Perk ${perk.id} at ${rankKey(perk.rank)} comes after one at ${rankKey(previous.rank)}; list perks lowest rank first.`,
      });
    }
  });
});

/** One rank reached, with the perks it just unlocked: what the wax-seal ceremony stamps in. */
export const RankUpSchema = z
  .object({
    rank: RankSchema,
    perks: z.array(PerkSchema),
  })
  .superRefine((rankUp, ctx) => {
    rankUp.perks.forEach((perk, i) => {
      if (compareRanks(perk.rank, rankUp.rank) !== 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['perks', i, 'rank'],
          message: `Perk ${perk.id} belongs to ${rankKey(perk.rank)}, not to ${rankKey(rankUp.rank)}.`,
        });
      }
    });
  });
export type RankUp = z.infer<typeof RankUpSchema>;

/** The HUD crest, the progress bar and the whole rank road with each perk on it. */
export const RanksResponseSchema = z.object({
  serverTime: EpochMsSchema,
  progress: RankProgressSchema,
  perks: PerkRoadSchema,
});
export type RanksResponse = z.infer<typeof RanksResponseSchema>;
