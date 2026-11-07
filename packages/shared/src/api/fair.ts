import { z } from 'zod';
import { ActiveSeedSchema, ClientSeedSchema, RevealedSeedSchema } from '../fair.ts';

export const FairSeedsResponseSchema = z.object({
  active: ActiveSeedSchema,
  revealed: z.array(RevealedSeedSchema),
});
export type FairSeedsResponse = z.infer<typeof FairSeedsResponseSchema>;

/** Reveals the current server seed and commits a new one; `clientSeed` optionally replaces the player's. */
export const FairRotateRequestSchema = z.strictObject({
  clientSeed: ClientSeedSchema.optional(),
});
export type FairRotateRequest = z.infer<typeof FairRotateRequestSchema>;

export const FairRotateResponseSchema = z.object({
  active: ActiveSeedSchema,
  revealed: RevealedSeedSchema,
});
export type FairRotateResponse = z.infer<typeof FairRotateResponseSchema>;
