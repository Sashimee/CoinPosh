import { z } from 'zod';
import { PositiveAmountSchema } from '../../primitives.ts';

/**
 * Every server-observed event that grants Repute (02-ECONOMY "New currencies"). The amounts per
 * source live in `packages/economy`; no endpoint lets a client name a source or an amount.
 */
export const REPUTE_SOURCES = [
  'coinPushed',
  'fusion',
  'crateOpened',
  'quest',
  'achievement',
  'ascension',
  'dailyPuzzle',
  'bossDamage',
  'visitLike',
] as const;
export const ReputeSourceSchema = z.enum(REPUTE_SOURCES);
export type ReputeSource = z.infer<typeof ReputeSourceSchema>;

/** Repute one source granted in one server step, already credited. */
export const ReputeGainSchema = z.object({
  source: ReputeSourceSchema,
  amount: PositiveAmountSchema,
});
export type ReputeGain = z.infer<typeof ReputeGainSchema>;
