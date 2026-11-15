/**
 * Soirée Nights (T-3.06): an 8-minute run on a fresh, server-chosen table seed. Guests arrive in
 * order with a request; the server judges each one from the front-edge falls it already accepted
 * through `/v1/table/claims`, so the client never reports a request as fulfilled. Fulfilled
 * requests earn Favors, spent between guests on one of three temporary perks the server rolled
 * from its provably fair seed. The run pays crates and keys only, and every number behind it
 * (roster, perks, odds, cap) lives in `packages/economy` `soireeConfig`.
 */
import { z } from 'zod';
import { CoinTierIdSchema, RaritySchema, WalletSchema } from '../domain.ts';
import { FairProofSchema } from '../fair.ts';
import {
  CrateIdSchema,
  SoireeFavorIdSchema,
  SoireeGuestIdSchema,
  SoireeRunIdSchema,
} from '../ids.ts';
import { AmountSchema, EpochMsSchema, PositiveAmountSchema } from '../primitives.ts';

/** Perks offered per draft; the player keeps at most one of them. */
export const SOIREE_DRAFT_SIZE = 3;

/** The upgrade stats a Favor may lift for its duration, on top of the player's own levels. */
export const SOIREE_PERK_STATS = [
  'pusherSpeed',
  'dropRate',
  'coinValue',
  'crateChance',
  'fusionWindow',
] as const;
export const SoireePerkStatSchema = z.enum(SOIREE_PERK_STATS);
export type SoireePerkStat = z.infer<typeof SoireePerkStatSchema>;

const PositiveMsSchema = z.int().positive();

/** `count` coins of `tier` over the front edge within `windowMs` of the guest's arrival. */
export const SoireeRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('falls'),
    tier: CoinTierIdSchema,
    count: PositiveAmountSchema,
    windowMs: PositiveMsSchema,
  }),
]);
export type SoireeRequest = z.infer<typeof SoireeRequestSchema>;

export const SoireeGuestSchema = z.object({
  id: SoireeGuestIdSchema,
  /** 1-based arrival order; a guest's window opens only once the one before is resolved. */
  order: PositiveAmountSchema,
  request: SoireeRequestSchema,
  /** Favors paid when the request is fulfilled. */
  favors: PositiveAmountSchema,
});
export type SoireeGuest = z.infer<typeof SoireeGuestSchema>;

/** One perk on offer: `stat` is multiplied by `1 + magnitudeBp / 10 000` for `durationMs`. */
export const SoireeFavorSchema = z.object({
  id: SoireeFavorIdSchema,
  stat: SoireePerkStatSchema,
  magnitudeBp: PositiveAmountSchema,
  durationMs: PositiveMsSchema,
  cost: PositiveAmountSchema,
});
export type SoireeFavor = z.infer<typeof SoireeFavorSchema>;

/** A drafted perk, timed by the server clock. Drafting another replaces it. */
export const SoireeActiveFavorSchema = z
  .object({
    id: SoireeFavorIdSchema,
    startsAt: EpochMsSchema,
    endsAt: EpochMsSchema,
  })
  .refine((f) => f.endsAt > f.startsAt, { message: 'endsAt must be after startsAt.' });
export type SoireeActiveFavor = z.infer<typeof SoireeActiveFavorSchema>;

const SoireeOfferSchema = z
  .array(SoireeFavorSchema)
  .length(SOIREE_DRAFT_SIZE)
  .refine((offer) => new Set(offer.map((f) => f.id)).size === offer.length, {
    message: 'A draft offers distinct perks.',
  });

const SoireeGuestsSchema = z
  .array(SoireeGuestSchema)
  .min(1)
  .refine((guests) => guests.every((g, i) => g.order === i + 1), {
    message: 'Guests are listed in arrival order, numbered from 1.',
  })
  .refine((guests) => new Set(guests.map((g) => g.id)).size === guests.length, {
    message: 'A guest attends a run once.',
  });

/** The 32-bit seed `packages/sim` lays the run's fresh table from. */
export const SoireeTableSeedSchema = z.int().min(0).max(0xffff_ffff);

export const SoireeStartRequestSchema = z.strictObject({});
export type SoireeStartRequest = z.infer<typeof SoireeStartRequestSchema>;

export const SoireeStartResponseSchema = z.object({
  runId: SoireeRunIdSchema,
  seed: SoireeTableSeedSchema,
  /** Server clock; the run ends at `startedAt + durationMs` whatever the client shows. */
  startedAt: EpochMsSchema,
  durationMs: PositiveMsSchema,
  /** Pause between one guest resolving and the next one's window opening, for the draft. */
  interludeMs: AmountSchema,
  guests: SoireeGuestsSchema,
  /** The first draft, open once the first guest is resolved. */
  offered: SoireeOfferSchema,
  /** Commitment the seat plan, table seed and every draft are rolled from. */
  proof: FairProofSchema,
});
export type SoireeStartResponse = z.infer<typeof SoireeStartResponseSchema>;

/** `favorId: null` passes on the draft and keeps the Favors for a later one. */
export const SoireeDraftRequestSchema = z.strictObject({
  runId: SoireeRunIdSchema,
  favorId: SoireeFavorIdSchema.nullable(),
});
export type SoireeDraftRequest = z.infer<typeof SoireeDraftRequestSchema>;

export const SoireeDraftResponseSchema = z.object({
  runId: SoireeRunIdSchema,
  /** 1-based: draft `n` follows guest `n`. */
  draft: PositiveAmountSchema,
  picked: SoireeActiveFavorSchema.nullable(),
  favorsLeft: AmountSchema,
  /** The next guest's draft, or empty after the last one. */
  offered: z.union([SoireeOfferSchema, z.array(SoireeFavorSchema).length(0)]),
});
export type SoireeDraftResponse = z.infer<typeof SoireeDraftResponseSchema>;

export const SoireeFinishRequestSchema = z.strictObject({
  runId: SoireeRunIdSchema,
});
export type SoireeFinishRequest = z.infer<typeof SoireeFinishRequestSchema>;

export const SoireeGuestResultSchema = z.object({
  guestId: SoireeGuestIdSchema,
  fulfilled: z.boolean(),
  /** Qualifying falls the server counted inside the guest's window. */
  progress: AmountSchema,
});
export type SoireeGuestResult = z.infer<typeof SoireeGuestResultSchema>;

/** Soirée crates arrive with their rarity already rolled, then open like any Vault Crate. */
export const SoireeRewardSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('crate'), crateId: CrateIdSchema, rarity: RaritySchema }),
  z.object({
    kind: z.literal('currency'),
    currency: z.literal('keys'),
    amount: PositiveAmountSchema,
  }),
]);
export type SoireeReward = z.infer<typeof SoireeRewardSchema>;

/** Idempotent: a repeat returns the same payout without paying it twice. */
export const SoireeFinishResponseSchema = z
  .object({
    runId: SoireeRunIdSchema,
    guestsServed: AmountSchema,
    favorsEarned: AmountSchema,
    results: z.array(SoireeGuestResultSchema).min(1),
    rewards: z.array(SoireeRewardSchema),
    proof: FairProofSchema,
    wallet: WalletSchema,
  })
  .refine((r) => r.guestsServed === r.results.filter((g) => g.fulfilled).length, {
    message: 'guestsServed counts the fulfilled results.',
  });
export type SoireeFinishResponse = z.infer<typeof SoireeFinishResponseSchema>;
