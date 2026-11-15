import { z } from 'zod';
import { TableCrateSchema } from '../../domain.ts';
import { EpochMsSchema } from '../../primitives.ts';
import { TargetIdSchema } from './ids.ts';

/** Upper bounds for wire sanity only; the tuned sizes live in `packages/economy` (T-16.02). */
export const MAX_SHOWER_COINS = 64;
export const MAX_MULTIPLIER_FACTOR = 10;

export const PROP_REWARD_KINDS = ['shower', 'crate', 'multiplierWindow'] as const;
export const PropRewardKindSchema = z.enum(PROP_REWARD_KINDS);
export type PropRewardKind = z.infer<typeof PropRewardKindSchema>;

/**
 * What a target rolled, sent by the server for display. Nothing here is ever read back from the
 * client: shower coins arrive through the drop buffer as minted coins, the crate is already on the
 * server's table, and the multiplier window is timed on the server clock.
 */
export const PropRewardSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('shower'),
    coins: z.int().min(1).max(MAX_SHOWER_COINS),
  }),
  z.strictObject({
    kind: z.literal('crate'),
    crate: TableCrateSchema,
  }),
  z
    .strictObject({
      kind: z.literal('multiplierWindow'),
      factor: z.number().gt(1).max(MAX_MULTIPLIER_FACTOR),
      startsAt: EpochMsSchema,
      endsAt: EpochMsSchema,
    })
    .refine((w) => w.endsAt > w.startsAt, 'A multiplier window must end after it starts.'),
]);
export type PropReward = z.infer<typeof PropRewardSchema>;

/** One target entry the server settled, so the render, VFX and audio layers can play it. */
export const TargetHitSchema = z.strictObject({
  targetId: TargetIdSchema,
  reward: PropRewardSchema,
});
export type TargetHit = z.infer<typeof TargetHitSchema>;
