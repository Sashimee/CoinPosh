import { z } from 'zod';
import { AmountSchema } from '../../primitives.ts';
import { OwnedPrizeSchema } from './prizes.ts';
import { FoundVariantSchema } from './variants.ts';

/** Draws since the pity last fired, for the odds sheet beside each random reward. */
export const CollectingPitySchema = z.object({
  /** Prizes spawned since the last one the player did not own yet. */
  prizesSinceNew: AmountSchema,
  /** Coins minted since the last misprint. */
  mintsSinceMisprint: AmountSchema,
});
export type CollectingPity = z.infer<typeof CollectingPitySchema>;

/**
 * The collection book, read-only: the server says what is owned and what it is worth.
 * `multiplierBp` is the capped coin-value boost Collection Value grants, in basis points.
 */
export const CollectionResponseSchema = z
  .object({
    prizes: z.array(OwnedPrizeSchema),
    variants: z.array(FoundVariantSchema),
    collectionValue: AmountSchema,
    multiplierBp: AmountSchema,
    pity: CollectingPitySchema,
  })
  .superRefine((book, ctx) => {
    if (new Set(book.prizes.map((p) => p.type)).size !== book.prizes.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['prizes'],
        message: 'Each prize kind is listed once, with its count.',
      });
    }
    const cells = book.variants.map((v) => `${v.tier}:${v.variant}`);
    if (new Set(cells).size !== cells.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['variants'],
        message: 'Each tier and variant is found once.',
      });
    }
  });
export type CollectionResponse = z.infer<typeof CollectionResponseSchema>;
