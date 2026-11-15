import { z } from 'zod';
import { CollectibleIdSchema, PrizeTypeIdSchema, TrophyIdSchema } from '../../ids.ts';
import { AmountSchema } from '../../primitives.ts';

/** Transport bound on vitrines; how many the player has comes from `packages/economy`. */
export const MAX_LOUNGE_SLOTS = 64;

/** Something the lounge shows. It names an owned thing only; the server checks ownership. */
export const LoungeItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('prize'), prize: PrizeTypeIdSchema }),
  z.strictObject({ kind: z.literal('heirloom'), collectible: CollectibleIdSchema }),
  z.strictObject({ kind: z.literal('trophy'), trophy: TrophyIdSchema }),
]);
export type LoungeItem = z.infer<typeof LoungeItemSchema>;

export const LoungeSlotIndexSchema = z
  .int()
  .min(0)
  .max(MAX_LOUNGE_SLOTS - 1);

export const LoungePlacementSchema = z.strictObject({
  slot: LoungeSlotIndexSchema,
  item: LoungeItemSchema,
});
export type LoungePlacement = z.infer<typeof LoungePlacementSchema>;

function itemKey(item: LoungeItem): string {
  switch (item.kind) {
    case 'prize':
      return `prize:${item.prize}`;
    case 'heirloom':
      return `heirloom:${item.collectible}`;
    case 'trophy':
      return `trophy:${item.trophy}`;
  }
}

/** Which item stands in which vitrine; empty vitrines are left out. */
export const LoungeLayoutSchema = z
  .array(LoungePlacementSchema)
  .max(MAX_LOUNGE_SLOTS)
  .superRefine((placements, ctx) => {
    const slots = new Set<number>();
    const items = new Set<string>();
    placements.forEach(({ slot, item }, i) => {
      if (slots.has(slot)) {
        ctx.addIssue({
          code: 'custom',
          path: [i, 'slot'],
          message: `Vitrine ${slot} holds one item.`,
        });
      }
      const key = itemKey(item);
      if (items.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: [i, 'item'],
          message: 'An item stands in one vitrine at a time.',
        });
      }
      slots.add(slot);
      items.add(key);
    });
  });
export type LoungeLayout = z.infer<typeof LoungeLayoutSchema>;

/** `slots` vitrines are open; every placement sits in one of them. */
export const LoungeResponseSchema = z
  .object({
    slots: AmountSchema.max(MAX_LOUNGE_SLOTS),
    layout: LoungeLayoutSchema,
    trophies: z.array(TrophyIdSchema),
  })
  .superRefine((lounge, ctx) => {
    lounge.layout.forEach(({ slot }, i) => {
      if (slot >= lounge.slots) {
        ctx.addIssue({
          code: 'custom',
          path: ['layout', i, 'slot'],
          message: `Vitrine ${slot} is not open; the lounge has ${lounge.slots}.`,
        });
      }
    });
  });
export type LoungeResponse = z.infer<typeof LoungeResponseSchema>;

/** Replaces the whole arrangement. Positions only: no value, rarity or polish is uploaded. */
export const LoungeArrangeRequestSchema = z.strictObject({
  layout: LoungeLayoutSchema,
});
export type LoungeArrangeRequest = z.infer<typeof LoungeArrangeRequestSchema>;
