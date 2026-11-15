import { z } from 'zod';
import { RaritySchema } from '../../domain.ts';
import { FairProofSchema } from '../../fair.ts';
import { PrizeIdSchema, PrizeTypeIdSchema } from '../../ids.ts';
import { AmountSchema, EpochMsSchema, PositiveAmountSchema } from '../../primitives.ts';

/** Each family is one compound body in `packages/sim` and one impact sound. */
export const PRIZE_FAMILIES = ['watch', 'perfume', 'cufflinks', 'carKeys'] as const;
export const PrizeFamilySchema = z.enum(PRIZE_FAMILIES);
export type PrizeFamily = z.infer<typeof PrizeFamilySchema>;

/** Lowest to highest: the rarities a prize can spawn at, a prefix of {@link RaritySchema}. */
export const PRIZE_RARITIES = ['common', 'fine', 'rare', 'exquisite', 'legendary'] as const;
export const PrizeRaritySchema = RaritySchema.extract(PRIZE_RARITIES);
export type PrizeRarity = z.infer<typeof PrizeRaritySchema>;

/**
 * One prize in the collecting catalogue. `packages/economy` keys its numbers (spawn share,
 * collection points) by `id` and must cover every family and rarity it lists here.
 */
export const PrizeCatalogEntrySchema = z.object({
  id: PrizeTypeIdSchema,
  family: PrizeFamilySchema,
  rarity: PrizeRaritySchema,
});
export type PrizeCatalogEntry = z.infer<typeof PrizeCatalogEntrySchema>;

/**
 * A prize riding the table, like a crate: the server rolled its kind when it spawned it, and
 * `family` picks the sim body so the client needs no catalogue lookup to lay it.
 */
export const TablePrizeSchema = z.object({
  id: PrizeIdSchema,
  type: PrizeTypeIdSchema,
  family: PrizeFamilySchema,
});
export type TablePrize = z.infer<typeof TablePrizeSchema>;

/**
 * What a front-edge prize claim added to the collection. A duplicate polishes the one already
 * owned instead; `proof` is the fair roll that spawned it.
 */
export const PrizeAwardSchema = z
  .object({
    prizeId: PrizeIdSchema,
    type: PrizeTypeIdSchema,
    rarity: PrizeRaritySchema,
    duplicate: z.boolean(),
    count: PositiveAmountSchema,
    polish: AmountSchema,
    proof: FairProofSchema,
  })
  .refine((award) => award.duplicate === award.count > 1, {
    path: ['duplicate'],
    message: 'A prize is a duplicate exactly when the player now owns more than one.',
  });
export type PrizeAward = z.infer<typeof PrizeAwardSchema>;

/** One kind of prize in the collection; duplicates raise `polish` up to the economy cap. */
export const OwnedPrizeSchema = z.object({
  type: PrizeTypeIdSchema,
  count: PositiveAmountSchema,
  polish: AmountSchema,
  firstFoundAt: EpochMsSchema,
});
export type OwnedPrize = z.infer<typeof OwnedPrizeSchema>;
