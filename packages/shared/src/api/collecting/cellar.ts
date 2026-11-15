import { z } from 'zod';
import { WalletSchema } from '../../domain.ts';
import { BottleIdSchema, BottleTypeIdSchema } from '../../ids.ts';
import { AmountSchema, EpochMsSchema, PositiveAmountSchema } from '../../primitives.ts';

/** Each class has its own ageing curve in `packages/economy`; none of them ever declines. */
export const BOTTLE_CLASSES = ['tableWine', 'grandCru', 'legendaryVintage'] as const;
export const BottleClassSchema = z.enum(BOTTLE_CLASSES);
export type BottleClass = z.infer<typeof BottleClassSchema>;

/** `racked` bottles age and can be sold; a `kept` bottle leaves the rack for the collection. */
export const BOTTLE_STATES = ['racked', 'kept'] as const;
export const BottleStateSchema = z.enum(BOTTLE_STATES);
export type BottleState = z.infer<typeof BottleStateSchema>;

/**
 * A bottle as the server ages it. `laidAt` is the server's clock when the bottle was laid down,
 * and `value` its curve value at the response's `serverTime`; `peakAt` is when it reaches 95 %
 * of its ceiling, the moment the cellar UI points at.
 */
export const BottleSchema = z
  .object({
    id: BottleIdSchema,
    type: BottleTypeIdSchema,
    class: BottleClassSchema,
    state: BottleStateSchema,
    laidAt: EpochMsSchema,
    peakAt: EpochMsSchema,
    value: AmountSchema,
  })
  .refine((bottle) => bottle.peakAt >= bottle.laidAt, {
    path: ['peakAt'],
    message: 'A bottle cannot peak before it is laid down.',
  });
export type Bottle = z.infer<typeof BottleSchema>;

export const CellarResponseSchema = z
  .object({
    serverTime: EpochMsSchema,
    rackSlots: AmountSchema,
    bottles: z.array(BottleSchema),
  })
  .superRefine((cellar, ctx) => {
    const seen = new Set<string>();
    cellar.bottles.forEach((bottle, i) => {
      if (seen.has(bottle.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['bottles', i, 'id'],
          message: 'Each bottle is listed once.',
        });
      }
      seen.add(bottle.id);
      if (bottle.laidAt > cellar.serverTime) {
        ctx.addIssue({
          code: 'custom',
          path: ['bottles', i, 'laidAt'],
          message: 'A bottle cannot be laid down after the server time it is valued at.',
        });
      }
    });
    const racked = cellar.bottles.filter((bottle) => bottle.state === 'racked').length;
    if (racked > cellar.rackSlots) {
      ctx.addIssue({
        code: 'custom',
        path: ['bottles'],
        message: `${racked} racked bottles do not fit in ${cellar.rackSlots} rack slots.`,
      });
    }
  });
export type CellarResponse = z.infer<typeof CellarResponseSchema>;

/** Names the bottle only: the server values it from its own `laidAt` and clock. */
export const CellarSellRequestSchema = z.strictObject({
  bottleId: BottleIdSchema,
});
export type CellarSellRequest = z.infer<typeof CellarSellRequestSchema>;

export const CellarSellResponseSchema = z.object({
  bottleId: BottleIdSchema,
  soldAt: EpochMsSchema,
  credited: AmountSchema,
  wallet: WalletSchema,
});
export type CellarSellResponse = z.infer<typeof CellarSellResponseSchema>;

/** Takes a racked bottle off the market for good and frees its rack slot. */
export const CellarKeepRequestSchema = z.strictObject({
  bottleId: BottleIdSchema,
});
export type CellarKeepRequest = z.infer<typeof CellarKeepRequestSchema>;

export const CellarKeepResponseSchema = z.object({
  bottle: BottleSchema.refine((bottle) => bottle.state === 'kept', {
    path: ['state'],
    message: 'A bottle the player kept is in the collection.',
  }),
  collectionValue: AmountSchema,
});
export type CellarKeepResponse = z.infer<typeof CellarKeepResponseSchema>;

/**
 * `slots` is the rack size being bought, as an upgrade names its next level: a stale client
 * asking for a size it already has gets `conflict` instead of paying twice. The server prices it.
 */
export const CellarRackRequestSchema = z.strictObject({
  slots: PositiveAmountSchema,
});
export type CellarRackRequest = z.infer<typeof CellarRackRequestSchema>;

export const CellarRackResponseSchema = z.object({
  rackSlots: PositiveAmountSchema,
  wallet: WalletSchema,
});
export type CellarRackResponse = z.infer<typeof CellarRackResponseSchema>;

/** A bottle a crate granted, already laid down: the member T-11.12 adds to `RewardSchema`. */
export const BottleRewardSchema = z.object({
  kind: z.literal('bottle'),
  bottle: BottleSchema,
});
export type BottleReward = z.infer<typeof BottleRewardSchema>;
