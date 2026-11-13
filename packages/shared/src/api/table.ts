import { z } from 'zod';
import {
  CascadeTierSchema,
  FallEdgeSchema,
  MintedCoinSchema,
  NudgeDirectionSchema,
  TableCrateSchema,
  WalletSchema,
} from '../domain.ts';
import { CoinIdSchema, CrateIdSchema, TableSessionIdSchema } from '../ids.ts';
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

// TODO(backend-engineer): make `session` required on drop, claims and nudge once T-92.05 sends
// it and T-92.08 fences on it; until then an absent session must not bypass the lease check.
const StagedSessionSchema = TableSessionIdSchema.optional();

/** Horizontal aim across the drop rail, -1 (far left) to 1 (far right). */
export const AimSchema = z.number().min(-1).max(1);
export type Aim = z.infer<typeof AimSchema>;

export const MAX_SNAPSHOT_COINS = 320;
export const MAX_SNAPSHOT_CRATES = 16;
/** Transport bound on a quantized position, in 10 µm units: 1 m either side of the origin. */
export const POSE_POSITION_LIMIT = 100_000;
export const POSE_QUATERNION_MIN = -32_768;
export const POSE_QUATERNION_MAX = 32_767;
export const CRATE_POSE_MAX_ELAPSED_MS = 600_000;

const PosePositionSchema = z.int().min(-POSE_POSITION_LIMIT).max(POSE_POSITION_LIMIT);
const PoseQuaternionSchema = z.int().min(POSE_QUATERNION_MIN).max(POSE_QUATERNION_MAX);

export const COIN_POSE_STATES = ['awake', 'asleep'] as const;
export const CoinPoseStateSchema = z.enum(COIN_POSE_STATES);
export type CoinPoseState = z.infer<typeof CoinPoseStateSchema>;

/**
 * Where one coin rests: `[id, x, y, z, qx, qy, qz, qw, state]`, positions in 10 µm units and
 * the quaternion as int16. These are transport limits only; `checkPose` in `packages/sim`
 * decides whether a pose is physically plausible.
 */
export const PoseTupleSchema = z.tuple([
  CoinIdSchema,
  PosePositionSchema,
  PosePositionSchema,
  PosePositionSchema,
  PoseQuaternionSchema,
  PoseQuaternionSchema,
  PoseQuaternionSchema,
  PoseQuaternionSchema,
  CoinPoseStateSchema,
]);
export type PoseTuple = z.infer<typeof PoseTupleSchema>;

export const CRATE_POSE_STATES = ['riding', 'teeter'] as const;
export const CratePoseStateSchema = z.enum(CRATE_POSE_STATES);
export type CratePoseState = z.infer<typeof CratePoseStateSchema>;

/** One crate on its ride: `[id, x, z, elapsedMs, state]`, positions in 10 µm units. */
export const CratePoseTupleSchema = z.tuple([
  CrateIdSchema,
  PosePositionSchema,
  PosePositionSchema,
  z.int().nonnegative().max(CRATE_POSE_MAX_ELAPSED_MS),
  CratePoseStateSchema,
]);
export type CratePoseTuple = z.infer<typeof CratePoseTupleSchema>;

const pusherPhaseShape = { tickInCycle: z.int().nonnegative() };

function firstDuplicate(ids: readonly string[]): number {
  const seen = new Set<string>();
  for (const [i, id] of ids.entries()) {
    if (seen.has(id)) return i;
    seen.add(id);
  }
  return -1;
}

/**
 * Positions only, named by server ids. The client never uploads a value, tier or wallet field,
 * and unknown keys are rejected.
 */
export const TableSnapshotRequestSchema = z
  .strictObject({
    session: TableSessionIdSchema,
    seq: z.int().positive(),
    tick: TickSchema,
    pusher: z.strictObject(pusherPhaseShape),
    coins: z.array(PoseTupleSchema).max(MAX_SNAPSHOT_COINS),
    crates: z.array(CratePoseTupleSchema).max(MAX_SNAPSHOT_CRATES),
  })
  .superRefine((snapshot, ctx) => {
    for (const key of ['coins', 'crates'] as const) {
      const duplicate = firstDuplicate(snapshot[key].map(([id]) => id));
      if (duplicate !== -1) {
        ctx.addIssue({
          code: 'custom',
          path: [key, duplicate, 0],
          message: `Each of ${key} may be posed at most once per snapshot.`,
        });
      }
    }
  });
export type TableSnapshotRequest = z.infer<typeof TableSnapshotRequestSchema>;

export const TableSnapshotResponseSchema = z.object({
  seq: z.int().positive(),
  /** Coin and crate poses accepted. */
  stored: AmountSchema,
  /** Poses dropped: unknown, gone or implausible. */
  ignored: AmountSchema,
});
export type TableSnapshotResponse = z.infer<typeof TableSnapshotResponseSchema>;

export const CoinPlacementSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pose'), pose: PoseTupleSchema }),
  /** A heap coin without a valid pose is laid again at its opening heap slot. */
  z.object({ kind: z.literal('heapSlot'), slot: z.int().nonnegative() }),
]);
export type CoinPlacement = z.infer<typeof CoinPlacementSchema>;

export const CratePlacementSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pose'), pose: CratePoseTupleSchema }),
  /** A crate without a valid pose starts its ride again from the spawn point. */
  z.object({ kind: z.literal('chute') }),
]);
export type CratePlacement = z.infer<typeof CratePlacementSchema>;

/** `coins[i]` places `table.coins[i]` and `crates[i]` places `table.crates[i]`. */
export const TableLayoutSchema = z.object({
  pusher: z.object(pusherPhaseShape),
  coins: z.array(CoinPlacementSchema),
  crates: z.array(CratePlacementSchema),
});
export type TableLayout = z.infer<typeof TableLayoutSchema>;

function checkPlacements(
  ctx: z.RefinementCtx,
  key: 'coins' | 'crates',
  entities: readonly { id: string }[],
  placements: readonly (CoinPlacement | CratePlacement)[],
): void {
  if (placements.length !== entities.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['layout', key],
      message: `layout.${key} must place every one of the ${entities.length} table ${key}, in order.`,
    });
    return;
  }
  placements.forEach((placement, i) => {
    if (placement.kind === 'pose' && placement.pose[0] !== entities[i]?.id) {
      ctx.addIssue({
        code: 'custom',
        path: ['layout', key, i, 'pose', 0],
        message: `layout.${key}[${i}] must pose ${key}[${i}].`,
      });
    }
  });
}

export const TableSnapshotSchema = z
  .object({
    // TODO(backend-engineer): make `session` and `layout` required once T-92.04 serves them
    // and T-92.05 reads them; optional for now so current servers and mocks still parse.
    session: TableSessionIdSchema.optional(),
    coins: z.array(MintedCoinSchema),
    crates: z.array(TableCrateSchema),
    /** Pre-minted, already-paid coins the client may drop while offline. */
    buffer: z.array(MintedCoinSchema),
    decorum: FractionSchema,
    frozenUntil: EpochMsSchema.nullable(),
    /** Set only on `hydrate=boot`; a resync keeps its live sim and gets `null`. */
    layout: TableLayoutSchema.nullable().optional(),
  })
  .superRefine((table, ctx) => {
    if (table.layout === null || table.layout === undefined) return;
    checkPlacements(ctx, 'coins', table.coins, table.layout.coins);
    checkPlacements(ctx, 'crates', table.crates, table.layout.crates);
  });
export type TableSnapshot = z.infer<typeof TableSnapshotSchema>;

/**
 * Drops one coin at `x`. With `coinId` the drop spends that coin from the pre-minted
 * buffer (offline reconciliation); without it the server debits and mints a fresh coin.
 */
export const DropRequestSchema = z.strictObject({
  session: StagedSessionSchema,
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
  session: StagedSessionSchema,
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
  session: StagedSessionSchema,
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
