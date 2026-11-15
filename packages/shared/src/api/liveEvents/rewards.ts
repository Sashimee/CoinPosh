import { z } from 'zod';
import { CurrencySchema, RaritySchema, RewardSchema } from '../../domain.ts';
import { CollectibleIdSchema, CrateIdSchema } from '../../ids.ts';
import { AmountSchema, PositiveAmountSchema } from '../../primitives.ts';
import { StandingCosmeticIdSchema } from '../standing/ids.ts';
import { checkUnique } from './refine.ts';

export const BASIS_POINTS = 10_000;

const currency = z.object({
  kind: z.literal('currency'),
  currency: CurrencySchema,
  amount: PositiveAmountSchema,
});
const repute = z.object({ kind: z.literal('repute'), amount: PositiveAmountSchema });
const cosmetic = z.object({ kind: z.literal('cosmetic'), cosmetic: StandingCosmeticIdSchema });
const collectible = z.object({
  kind: z.literal('collectible'),
  collectibleId: CollectibleIdSchema,
});

/**
 * A reward on offer (a calendar slot, a puzzle or boss tier) before anything exists for it. The
 * amounts are `packages/economy` numbers the server reads out; the contract only carries them.
 */
export const LiveRewardSchema = z.discriminatedUnion('kind', [
  currency,
  repute,
  z.object({ kind: z.literal('crate'), rarity: RaritySchema }),
  cosmetic,
  collectible,
]);
export type LiveReward = z.infer<typeof LiveRewardSchema>;
export type LiveRewardKind = LiveReward['kind'];

/** What a claim paid: any table reward, plus the Repute, crate and cosmetic live events add. */
export const LiveGrantSchema = z.discriminatedUnion('kind', [
  ...RewardSchema.options,
  repute,
  z.object({ kind: z.literal('crate'), crateId: CrateIdSchema, rarity: RaritySchema }),
  cosmetic,
]);
export type LiveGrant = z.infer<typeof LiveGrantSchema>;

/** One row of an odds sheet: the chance, in basis points, that a roll lands on `rarity`. */
export const LiveOddsRowSchema = z.object({
  rarity: RaritySchema,
  chanceBp: PositiveAmountSchema.max(BASIS_POINTS),
});
export type LiveOddsRow = z.infer<typeof LiveOddsRowSchema>;

/** A full odds sheet, shown before every random live reward: one row per rarity, summing to 100 %. */
export const LiveOddsSchema = z
  .array(LiveOddsRowSchema)
  .min(1)
  .superRefine((odds, ctx) => {
    checkUnique(
      odds,
      (row) => row.rarity,
      ctx,
      (i) => [i, 'rarity'],
      'Each rarity has one row on the odds sheet.',
    );
    const total = odds.reduce((sum, row) => sum + row.chanceBp, 0);
    if (total !== BASIS_POINTS) {
      ctx.addIssue({
        code: 'custom',
        message: `The odds sum to ${total} bp; an odds sheet covers exactly ${BASIS_POINTS}.`,
      });
    }
  });
export type LiveOdds = z.infer<typeof LiveOddsSchema>;

/**
 * The pity counter beside a random live reward: `guaranteed` (or better) lands within `within`
 * rolls, and `since` rolls have passed without it. At `within - 1` the next roll is certain.
 */
export const LivePitySchema = z
  .object({
    guaranteed: RaritySchema,
    within: PositiveAmountSchema,
    since: AmountSchema,
  })
  .refine((pity) => pity.since < pity.within, {
    path: ['since'],
    message: 'The pity fires on the roll that reaches its limit, so it never stands at the limit.',
  });
export type LivePity = z.infer<typeof LivePitySchema>;
