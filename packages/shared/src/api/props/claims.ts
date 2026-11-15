import { z } from 'zod';
import { FallEdgeSchema } from '../../domain.ts';
import { CoinIdSchema, TableSessionIdSchema } from '../../ids.ts';
import { TickSchema } from '../../primitives.ts';
import { ClaimWithPrizeSchema, MAX_CLAIMS_PER_BATCH } from '../table.ts';
import { JackpotBallIdSchema, TargetIdSchema } from './ids.ts';

/**
 * A coin the client saw enter a target. The server checks the coin is on the table and the target
 * is in the session's layout, credits the coin and rolls the reward; the claim names ids only.
 */
export const TargetClaimSchema = z.strictObject({
  kind: z.literal('target'),
  coinId: CoinIdSchema,
  targetId: TargetIdSchema,
  tick: TickSchema,
});
export type TargetClaim = z.infer<typeof TargetClaimSchema>;

/** A jackpot ball over an edge, checked like a prize; its payout is stored on the server. */
export const JackpotBallClaimSchema = z.strictObject({
  kind: z.literal('jackpotBall'),
  ballId: JackpotBallIdSchema,
  tick: TickSchema,
  edge: FallEdgeSchema,
});
export type JackpotBallClaim = z.infer<typeof JackpotBallClaimSchema>;

export const PropClaimSchema = z.discriminatedUnion('kind', [
  TargetClaimSchema,
  JackpotBallClaimSchema,
]);
export type PropClaim = z.infer<typeof PropClaimSchema>;

// TODO(backend-engineer): T-16.07 swaps the live `ClaimSchema` for this union in the same change
// that teaches `applyClaim` and the mock world to settle `target` and `jackpotBall`; widening the
// live schema first would accept claims nobody settles.
/** Every claim kind once table mechanics ride the table: prizes plus {@link PropClaimSchema}. */
export const ClaimWithPropsSchema = z.discriminatedUnion('kind', [
  ...ClaimWithPrizeSchema.options,
  TargetClaimSchema,
  JackpotBallClaimSchema,
]);
export type ClaimWithProps = z.infer<typeof ClaimWithPropsSchema>;

export const ClaimsWithPropsRequestSchema = z.strictObject({
  session: TableSessionIdSchema.optional(),
  claims: z.array(ClaimWithPropsSchema).min(1).max(MAX_CLAIMS_PER_BATCH),
});
export type ClaimsWithPropsRequest = z.infer<typeof ClaimsWithPropsRequestSchema>;
