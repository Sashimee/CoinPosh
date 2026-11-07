import { z } from 'zod';
import { PityCountersSchema, RaritySchema, RewardSchema, WalletSchema } from '../domain.ts';
import { FairProofSchema } from '../fair.ts';
import { CrateIdSchema, SafeIdSchema, ScratchCardIdSchema } from '../ids.ts';

export const MAX_GACHA_PULLS = 10;
export const SCRATCH_GRID_SIZE = 9;

/** One server-side provably fair roll and what it granted. */
export const RollSchema = z.object({
  rarity: RaritySchema,
  rewards: z.array(RewardSchema).min(1),
  proof: FairProofSchema,
  pity: PityCountersSchema,
});
export type Roll = z.infer<typeof RollSchema>;

export const CrateOpenRequestSchema = z.strictObject({
  crateId: CrateIdSchema,
});
export type CrateOpenRequest = z.infer<typeof CrateOpenRequestSchema>;

export const CrateOpenResponseSchema = z.object({
  crateId: CrateIdSchema,
  roll: RollSchema,
  wallet: WalletSchema,
});
export type CrateOpenResponse = z.infer<typeof CrateOpenResponseSchema>;

export const SAFE_OPEN_METHODS = ['key', 'timer'] as const;
export const SafeOpenMethodSchema = z.enum(SAFE_OPEN_METHODS);
export type SafeOpenMethod = z.infer<typeof SafeOpenMethodSchema>;

/** `timer` succeeds only once the server clock passes the safe's `unlocksAt`. */
export const SafeOpenRequestSchema = z.strictObject({
  safeId: SafeIdSchema,
  method: SafeOpenMethodSchema,
});
export type SafeOpenRequest = z.infer<typeof SafeOpenRequestSchema>;

export const SafeOpenResponseSchema = z.object({
  safeId: SafeIdSchema,
  roll: RollSchema,
  wallet: WalletSchema,
});
export type SafeOpenResponse = z.infer<typeof SafeOpenResponseSchema>;

export const GachaPullRequestSchema = z.strictObject({
  count: z.int().min(1).max(MAX_GACHA_PULLS),
});
export type GachaPullRequest = z.infer<typeof GachaPullRequestSchema>;

export const GachaPullResponseSchema = z.object({
  pulls: z.array(RollSchema).min(1).max(MAX_GACHA_PULLS),
  wallet: WalletSchema,
});
export type GachaPullResponse = z.infer<typeof GachaPullResponseSchema>;

export const ScratchRevealRequestSchema = z.strictObject({
  cardId: ScratchCardIdSchema,
});
export type ScratchRevealRequest = z.infer<typeof ScratchRevealRequestSchema>;

/** The 3×3 gem grid, row-major; three of a rarity is the match the roll paid out. */
export const ScratchRevealResponseSchema = z.object({
  cardId: ScratchCardIdSchema,
  grid: z.array(RaritySchema).length(SCRATCH_GRID_SIZE),
  roll: RollSchema,
  wallet: WalletSchema,
});
export type ScratchRevealResponse = z.infer<typeof ScratchRevealResponseSchema>;
