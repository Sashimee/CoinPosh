import { z } from 'zod';
import {
  CascadeTierSchema,
  FallEdgeSchema,
  MintedCoinSchema,
  NudgeDirectionSchema,
  TableCrateSchema,
  WalletSchema,
} from '../domain.ts';
import { CoinIdSchema, CrateIdSchema } from '../ids.ts';
import {
  AmountSchema,
  EpochMsSchema,
  FractionSchema,
  SimHashSchema,
  TickSchema,
} from '../primitives.ts';

export const MAX_CLAIMS_PER_BATCH = 256;
export const MAX_INPUT_EVENTS_PER_SEGMENT = 4096;
export const MAX_CHECKPOINTS_PER_SEGMENT = 64;

/** Horizontal aim across the drop rail, -1 (far left) to 1 (far right). */
export const AimSchema = z.number().min(-1).max(1);
export type Aim = z.infer<typeof AimSchema>;

export const TableSnapshotSchema = z.object({
  coins: z.array(MintedCoinSchema),
  crates: z.array(TableCrateSchema),
  /** Pre-minted, already-paid coins the client may drop while offline. */
  buffer: z.array(MintedCoinSchema),
  decorum: FractionSchema,
  frozenUntil: EpochMsSchema.nullable(),
});
export type TableSnapshot = z.infer<typeof TableSnapshotSchema>;

/**
 * Drops one coin at `x`. With `coinId` the drop spends that coin from the pre-minted
 * buffer (offline reconciliation); without it the server debits and mints a fresh coin.
 */
export const DropRequestSchema = z.strictObject({
  x: AimSchema,
  tick: TickSchema,
  coinId: CoinIdSchema.optional(),
});
export type DropRequest = z.infer<typeof DropRequestSchema>;

export const DropResponseSchema = z.object({
  coin: MintedCoinSchema,
  buffer: z.array(MintedCoinSchema),
  spawnedCrates: z.array(TableCrateSchema),
  wallet: WalletSchema,
});
export type DropResponse = z.infer<typeof DropResponseSchema>;

const distinctCoinTriple = z
  .tuple([CoinIdSchema, CoinIdSchema, CoinIdSchema])
  .refine((ids) => new Set(ids).size === ids.length, 'A fusion needs three distinct coins.');

/** What the client saw happen. It never states a value: the server credits what it stored. */
export const ClaimSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('fall'),
    coinId: CoinIdSchema,
    tick: TickSchema,
    edge: FallEdgeSchema,
  }),
  z.strictObject({
    kind: z.literal('fusion'),
    coinIds: distinctCoinTriple,
    tick: TickSchema,
  }),
  z.strictObject({
    kind: z.literal('crate'),
    crateId: CrateIdSchema,
    tick: TickSchema,
    edge: FallEdgeSchema,
  }),
]);
export type Claim = z.infer<typeof ClaimSchema>;

export const ClaimsRequestSchema = z.strictObject({
  claims: z.array(ClaimSchema).min(1).max(MAX_CLAIMS_PER_BATCH),
});
export type ClaimsRequest = z.infer<typeof ClaimsRequestSchema>;

export const CLAIM_REJECTIONS = [
  'unknown_entity',
  'not_on_table',
  'already_claimed',
  'tier_mismatch',
  'max_tier',
  'expired',
  'over_envelope',
] as const;
export const ClaimRejectionSchema = z.enum(CLAIM_REJECTIONS);
export type ClaimRejection = z.infer<typeof ClaimRejectionSchema>;

export const ClaimResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('accepted'),
    credited: AmountSchema,
    cascade: CascadeTierSchema.nullable(),
    minted: MintedCoinSchema.nullable(),
  }),
  z.object({
    status: z.literal('rejected'),
    reason: ClaimRejectionSchema,
  }),
]);
export type ClaimResult = z.infer<typeof ClaimResultSchema>;

/** `results[i]` answers `claims[i]` of the request. */
export const ClaimsResponseSchema = z.object({
  results: z.array(ClaimResultSchema).max(MAX_CLAIMS_PER_BATCH),
  wallet: WalletSchema,
});
export type ClaimsResponse = z.infer<typeof ClaimsResponseSchema>;

export const NudgeRequestSchema = z.strictObject({
  tick: TickSchema,
  direction: NudgeDirectionSchema,
});
export type NudgeRequest = z.infer<typeof NudgeRequestSchema>;

export const NudgeResponseSchema = z.object({
  decorum: FractionSchema,
  frozenUntil: EpochMsSchema.nullable(),
});
export type NudgeResponse = z.infer<typeof NudgeResponseSchema>;

export const InputEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('drop'), tick: TickSchema, x: AimSchema, coinId: CoinIdSchema }),
  z.strictObject({ kind: z.literal('nudge'), tick: TickSchema, direction: NudgeDirectionSchema }),
  z.strictObject({ kind: z.literal('pourStart'), tick: TickSchema }),
  z.strictObject({ kind: z.literal('pourEnd'), tick: TickSchema }),
]);
export type InputEvent = z.infer<typeof InputEventSchema>;

export const SimCheckpointSchema = z.strictObject({
  tick: TickSchema,
  hash: SimHashSchema,
});
export type SimCheckpoint = z.infer<typeof SimCheckpointSchema>;

function isSortedByTick(items: readonly { tick: number }[]): boolean {
  return items.every((item, i) => i === 0 || (items[i - 1]?.tick ?? 0) <= item.tick);
}

/** A replayable slice of the table for audits: ticks in `[fromTick, toTick]`, in order. */
export const InputsRequestSchema = z
  .strictObject({
    fromTick: TickSchema,
    toTick: TickSchema,
    events: z.array(InputEventSchema).max(MAX_INPUT_EVENTS_PER_SEGMENT),
    checkpoints: z.array(SimCheckpointSchema).min(1).max(MAX_CHECKPOINTS_PER_SEGMENT),
  })
  .superRefine((segment, ctx) => {
    if (segment.fromTick > segment.toTick) {
      ctx.addIssue({
        code: 'custom',
        path: ['toTick'],
        message: 'toTick must not be before fromTick.',
      });
    }
    const inRange = ({ tick }: { tick: number }) =>
      tick >= segment.fromTick && tick <= segment.toTick;
    for (const key of ['events', 'checkpoints'] as const) {
      const items = segment[key];
      if (!items.every(inRange)) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `Every ${key} tick must lie within the segment.`,
        });
      }
      if (!isSortedByTick(items)) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} must be in tick order.`,
        });
      }
    }
  });
export type InputsRequest = z.infer<typeof InputsRequestSchema>;

export const InputsResponseSchema = z.object({
  receivedEvents: AmountSchema,
  receivedCheckpoints: AmountSchema,
});
export type InputsResponse = z.infer<typeof InputsResponseSchema>;
