import { z } from 'zod';
import {
  CharmIdSchema,
  CharmTypeIdSchema,
  CoinIdSchema,
  CollectibleIdSchema,
  CrateIdSchema,
  SafeIdSchema,
  SafeTypeIdSchema,
  ScratchCardIdSchema,
} from './ids.ts';
import { AmountSchema, EpochMsSchema, PositiveAmountSchema } from './primitives.ts';

export const CURRENCIES = [
  'coins',
  'bullion',
  'goldBars',
  'pearls',
  'keys',
  'tickets',
  'stars',
] as const;
export const CurrencySchema = z.enum(CURRENCIES);
export type Currency = z.infer<typeof CurrencySchema>;

/** The names `packages/economy` keys its config by; the same values as {@link CURRENCIES}. */
export const CURRENCY_IDS = CURRENCIES;
export const CurrencyIdSchema = CurrencySchema;
export type CurrencyId = Currency;

export const WalletSchema = z.object({
  coins: AmountSchema,
  bullion: AmountSchema,
  goldBars: AmountSchema,
  pearls: AmountSchema,
  keys: AmountSchema,
  tickets: AmountSchema,
  stars: AmountSchema,
});
export type Wallet = z.infer<typeof WalletSchema>;

/** Lowest to highest; three touching coins of one tier fuse into the next. */
export const COIN_TIERS = ['copper', 'silver', 'gold', 'platinum', 'diamond', 'heirloom'] as const;
export const CoinTierSchema = z.enum(COIN_TIERS);
export type CoinTier = z.infer<typeof CoinTierSchema>;

export const COIN_TIER_IDS = COIN_TIERS;
export const CoinTierIdSchema = CoinTierSchema;
export type CoinTierId = CoinTier;

export function nextCoinTier(tier: CoinTier): CoinTier | null {
  return COIN_TIERS[COIN_TIERS.indexOf(tier) + 1] ?? null;
}

/** Lowest to highest. */
export const RARITIES = ['common', 'fine', 'rare', 'exquisite', 'legendary', 'heirloom'] as const;
export const RaritySchema = z.enum(RARITIES);
export type Rarity = z.infer<typeof RaritySchema>;

export const RARITY_IDS = RARITIES;
export const RarityIdSchema = RaritySchema;
export type RarityId = Rarity;

/** Lowest to highest. */
export const CASCADE_TIERS = ['chic', 'lavish', 'opulent', 'decadent', 'obscene'] as const;
export const CascadeTierSchema = z.enum(CASCADE_TIERS);
export type CascadeTier = z.infer<typeof CascadeTierSchema>;

/** Only the front ledge pays out; side gutters are where coins are lost to the house. */
export const FALL_EDGES = ['front', 'left', 'right'] as const;
export const FallEdgeSchema = z.enum(FALL_EDGES);
export type FallEdge = z.infer<typeof FallEdgeSchema>;

export const NUDGE_DIRECTIONS = ['left', 'right', 'forward'] as const;
export const NudgeDirectionSchema = z.enum(NUDGE_DIRECTIONS);
export type NudgeDirection = z.infer<typeof NudgeDirectionSchema>;

/** Everything that rolls a rarity on a drop table, named as `packages/economy` config keys them. */
export const DROP_SOURCE_IDS = ['vaultCrate', 'goldSafe', 'gacha', 'scratch'] as const;
export const DropSourceIdSchema = z.enum(DROP_SOURCE_IDS);
export type DropSourceId = z.infer<typeof DropSourceIdSchema>;

/** @deprecated Use {@link DROP_SOURCE_IDS}; kept so existing imports compile. */
export const LOOT_SOURCES = DROP_SOURCE_IDS;
/** @deprecated Use {@link DropSourceIdSchema}. */
export const LootSourceSchema = DropSourceIdSchema;
/** @deprecated Use {@link DropSourceId}. */
export type LootSource = DropSourceId;

export const CRATE_KINDS = ['vault'] as const;
export const CrateKindSchema = z.enum(CRATE_KINDS);
export type CrateKind = z.infer<typeof CrateKindSchema>;

export const COLLECTIBLE_KINDS = ['coinSkin', 'charm', 'heirloom'] as const;
export const CollectibleKindSchema = z.enum(COLLECTIBLE_KINDS);
export type CollectibleKind = z.infer<typeof CollectibleKindSchema>;

/**
 * The six Charm Board pieces (00-VISION §2). A charm's catalog id (`CharmTypeId`) may be a kind
 * itself or a named edition of one; `packages/economy` maps every droppable id onto its kind.
 */
export const CHARM_KINDS = [
  'golden-peg',
  'velvet-ropes',
  'magnet-cufflinks',
  'brass-bumper',
  'butler',
  'perfume-atomizer',
] as const;
export const CharmKindSchema = z.enum(CHARM_KINDS);
export type CharmKind = z.infer<typeof CharmKindSchema>;

export function isCharmKind(value: unknown): value is CharmKind {
  return CharmKindSchema.safeParse(value).success;
}

/** Charms sharing a tag unlock that tag's set bonus at 2 and 3 distinct kinds slotted. */
export const SYNERGY_TAGS = ['gilded', 'magnetic', 'kinetic', 'service', 'fragrant'] as const;
export const SynergyTagSchema = z.enum(SYNERGY_TAGS);
export type SynergyTag = z.infer<typeof SynergyTagSchema>;

/** A coin as the server minted it. `value` is the server's stored value, never the client's. */
export const MintedCoinSchema = z.object({
  id: CoinIdSchema,
  tier: CoinTierSchema,
  value: AmountSchema,
});
export type MintedCoin = z.infer<typeof MintedCoinSchema>;

export const TableCrateSchema = z.object({
  id: CrateIdSchema,
  kind: CrateKindSchema,
});
export type TableCrate = z.infer<typeof TableCrateSchema>;

export const SafeSchema = z.object({
  id: SafeIdSchema,
  type: SafeTypeIdSchema,
  unlocksAt: EpochMsSchema,
});
export type Safe = z.infer<typeof SafeSchema>;

export const OwnedCharmSchema = z.object({
  id: CharmIdSchema,
  type: CharmTypeIdSchema,
  level: PositiveAmountSchema,
});
export type OwnedCharm = z.infer<typeof OwnedCharmSchema>;

export const SocketIndexSchema = z.int().min(0).max(31);
export type SocketIndex = z.infer<typeof SocketIndexSchema>;

export const CharmSlotSchema = z.object({
  socket: SocketIndexSchema,
  charmId: CharmIdSchema.nullable(),
});
export type CharmSlot = z.infer<typeof CharmSlotSchema>;

/** Something already granted to the player, carrying the IDs of any entities it created. */
export const RewardSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('currency'), currency: CurrencySchema, amount: PositiveAmountSchema }),
  z.object({
    kind: z.literal('charm'),
    charmId: CharmIdSchema,
    charmType: CharmTypeIdSchema,
    level: PositiveAmountSchema,
    duplicate: z.boolean(),
  }),
  z.object({ kind: z.literal('safe'), safe: SafeSchema }),
  z.object({ kind: z.literal('scratchCard'), cardId: ScratchCardIdSchema }),
  z.object({ kind: z.literal('collectible'), collectibleId: CollectibleIdSchema }),
]);
export type Reward = z.infer<typeof RewardSchema>;

/** A reward on offer (quests, season tiers) before any entity exists for it. */
export const RewardPreviewSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('currency'), currency: CurrencySchema, amount: PositiveAmountSchema }),
  z.object({ kind: z.literal('charm'), charmType: CharmTypeIdSchema }),
  z.object({ kind: z.literal('safe'), safeType: SafeTypeIdSchema }),
  z.object({ kind: z.literal('scratchCard'), count: PositiveAmountSchema }),
  z.object({ kind: z.literal('collectible'), collectibleId: CollectibleIdSchema }),
]);
export type RewardPreview = z.infer<typeof RewardPreviewSchema>;

/** Opens since the last roll at or above each guaranteed rarity, for one loot source. */
export const PityCountersSchema = z.object({
  rare: AmountSchema,
  exquisite: AmountSchema,
  legendary: AmountSchema,
});
export type PityCounters = z.infer<typeof PityCountersSchema>;
