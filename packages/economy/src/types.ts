import {
  CASCADE_TIERS,
  COIN_TIERS,
  CURRENCIES,
  RARITIES,
  type CascadeTier,
  type CoinTier,
  type Currency,
  type DropSourceId,
  type Rarity,
  type VenueId,
} from '@coinposh/shared';

export { DROP_SOURCE_IDS, VENUE_IDS, type DropSourceId, type VenueId } from '@coinposh/shared';

export const CURRENCY_IDS = CURRENCIES;
export type CurrencyId = Currency;

export type CurrencyKind = 'soft' | 'progress' | 'prestige' | 'premium' | 'utility' | 'seasonXp';

export interface CurrencyDef {
  readonly id: CurrencyId;
  readonly kind: CurrencyKind;
  readonly resetsOnAscension: boolean;
  readonly sources: readonly string[];
  readonly sinks: readonly string[];
}

export const COIN_TIER_IDS = COIN_TIERS;
export type CoinTierId = CoinTier;

export interface CoinTierDef {
  readonly id: CoinTierId;
  /** Face value before venue and global multipliers. */
  readonly value: number;
  readonly fusesInto: CoinTierId | null;
}

export interface FusionConfig {
  readonly inputCount: number;
  readonly contactSeconds: number;
  /** The fused coin is worth the sum of its inputs times this bonus. */
  readonly bonusMultiplier: number;
}

/**
 * Coins a new player's table opens with, laid at the brink before the first drop and minted
 * on the house: they are not the player's, but every one pushed off the front pays out.
 */
export interface OpeningHeapConfig {
  readonly coins: number;
  readonly tier: CoinTierId;
}

export const CASCADE_TIER_IDS = CASCADE_TIERS;
export type CascadeTierId = CascadeTier;

export interface CascadeTierDef {
  readonly id: CascadeTierId;
  /** Coins that must fall inside one combo window to reach this tier. */
  readonly minCoins: number;
  readonly multiplier: number;
}

export interface CascadeConfig {
  readonly windowMs: number;
  readonly tiers: readonly CascadeTierDef[];
}

export const RARITY_IDS = RARITIES;
export type RarityId = Rarity;

/** Weights in basis points of a percent: 10 000 = 100 %. Integers only, so sums are exact. */
export type OddsTable = Readonly<Record<RarityId, number>>;

export interface DropTableDef {
  readonly source: DropSourceId;
  readonly odds: OddsTable;
  readonly pity: boolean;
}

export interface PityRule {
  /** An open of at least this rarity is guaranteed within `within` consecutive opens. */
  readonly rarity: RarityId;
  readonly within: number;
}

export interface PityConfig {
  readonly rules: readonly PityRule[];
}

/** Opens since the last result at or above each pitied rarity. */
export type PityState = Readonly<Partial<Record<RarityId, number>>>;

export interface CrateSpawnConfig {
  readonly dropsPerCrate: number;
  readonly ftueScriptedDrop: number;
  readonly ftueScriptedRarity: RarityId;
  readonly ftueScriptedCharm: boolean;
}

export interface CrateRewardDef {
  /** Coins granted, as seconds of the player's measured active earning rate. */
  readonly incomeSeconds: number;
  readonly pearls: number;
  readonly keys: number;
  readonly tickets: number;
  /** Basis points (10 000 = always). */
  readonly charmChance: number;
  readonly albumCard: boolean;
}

export type CrateRewardTable = Readonly<Record<RarityId, CrateRewardDef>>;

export const UPGRADE_STAT_IDS = [
  'pusherSpeed',
  'dropRate',
  'coinValue',
  'crateChance',
  'vaultCapacity',
  'offlineHours',
  'fusionWindow',
  'decorumCapacity',
  'globalCoinValue',
  'globalCrateChance',
  'startingCoins',
] as const;
export type UpgradeStatId = (typeof UPGRADE_STAT_IDS)[number];

export interface UpgradeEffect {
  readonly stat: UpgradeStatId;
  /** Stat value at level 0. */
  readonly base: number;
  /** Added per level; the stat at level L is `base + perLevel × L`. */
  readonly perLevel: number;
}

export type UpgradeScope = 'venue' | 'global';

export interface UpgradeLineDef {
  readonly id: string;
  readonly scope: UpgradeScope;
  readonly currency: Extract<CurrencyId, 'coins' | 'goldBars'>;
  readonly baseCost: number;
  readonly growth: number;
  readonly maxLevel: number;
  readonly effect: UpgradeEffect;
}

export interface UpgradeCostRule {
  readonly minGrowth: number;
  readonly maxGrowth: number;
}

export interface VenueDef {
  readonly id: VenueId;
  readonly order: number;
  readonly bullionThreshold: number;
  readonly coinValueMultiplier: number;
  readonly charmSockets: number;
}

export interface AlbumItemDef {
  readonly id: string;
  readonly rarity: RarityId;
}

export interface AlbumSetDef {
  readonly id: string;
  readonly venue: VenueId;
  readonly items: readonly AlbumItemDef[];
  /** Added to the permanent global coin multiplier once the set is complete. */
  readonly globalBonus: number;
}

export interface OfflineConfig {
  readonly activeRateFactor: number;
  readonly baseCapHours: number;
  readonly maxCapHours: number;
}

export interface BullionConfig {
  readonly valuePerBullion: number;
}

export interface AscensionConfig {
  readonly goldBarScale: number;
}

export interface SeasonConfig {
  readonly weeks: number;
  readonly freeTiers: number;
  readonly starsPerTier: number;
  readonly dropsPerStar: number;
  readonly starsPerCrate: number;
  readonly starsPerAlbumSet: number;
}

export type PacingMetric = 'activeSeconds' | 'casualDays' | 'ratio' | 'activeHours';

export const PACING_TARGET_IDS = [
  'firstUpgrade',
  'firstCharm',
  'firstAlbumSet',
  'ascendVenue1',
  'ascendVenue1Casual',
  'ascendVenue2Ratio',
  'seasonFreeTrack',
] as const;
export type PacingTargetId = (typeof PACING_TARGET_IDS)[number];

export interface PacingTargetDef {
  readonly id: PacingTargetId;
  readonly label: string;
  readonly metric: PacingMetric;
  /** Percentile of simulated players the bound applies to (50 = median). */
  readonly percentile: number;
  readonly min?: number;
  readonly max?: number;
}

/** How a play style in the physics ladder fixture taps (sim/ladder.ts). */
export const PLAY_STYLE_IDS = [
  'casual',
  'steady',
  'aimed',
  'aimedPinpoint',
  'rapidScatter',
  'rapid',
  'rapidPinpoint',
  'franticScatter',
  'frantic',
  'franticPinpoint',
  'franticPour',
  'overdrive',
] as const;
export type PlayStyleId = (typeof PLAY_STYLE_IDS)[number];

/** Seconds until a play style first fuses a coin into `tier`, at `percentile` of seeds. */
export interface LadderTargetDef {
  readonly id: string;
  readonly label: string;
  readonly style: PlayStyleId;
  readonly tier: CoinTierId;
  readonly metric: 'activeSeconds';
  readonly percentile: number;
  readonly min?: number;
  readonly max?: number;
}

export interface EconomyConfig {
  readonly currencies: readonly CurrencyDef[];
  readonly coinTiers: readonly CoinTierDef[];
  readonly fusion: FusionConfig;
  readonly openingHeap: OpeningHeapConfig;
  readonly cascade: CascadeConfig;
  readonly upgradeCostRule: UpgradeCostRule;
  readonly upgradeLines: readonly UpgradeLineDef[];
  readonly dropTables: readonly DropTableDef[];
  readonly pity: PityConfig;
  readonly crateSpawn: CrateSpawnConfig;
  readonly crateRewards: CrateRewardTable;
  readonly venues: readonly VenueDef[];
  readonly album: readonly AlbumSetDef[];
  readonly offline: OfflineConfig;
  readonly bullion: BullionConfig;
  readonly ascension: AscensionConfig;
  readonly season: SeasonConfig;
  readonly pacing: readonly PacingTargetDef[];
  readonly rateEnvelope: RateEnvelopeConfig;
}

/** What the server's sliding-window envelope meters (01-ARCHITECTURE.md, Layer 2). */
export const RATE_ENVELOPE_METRIC_IDS = [
  'drops',
  'falls',
  'fallValue',
  'fusions',
  'crates',
] as const;
export type RateEnvelopeMetricId = (typeof RATE_ENVELOPE_METRIC_IDS)[number];

/** At most `max` units of a metric inside any `windowMs` span of server time. */
export interface RateEnvelopeLimit {
  readonly windowMs: number;
  readonly max: number;
}

export type RateEnvelopeLimits = Readonly<Record<RateEnvelopeMetricId, RateEnvelopeLimit>>;

export interface RateEnvelopeMetricDef extends RateEnvelopeLimit {
  /**
   * How each upgrade stat stretches `max`, as an elasticity: the limit is multiplied by
   * `1 + weight × (stat / base − 1)`, so 1 scales in proportion and 0 ignores the stat.
   */
  readonly scaleBy: Readonly<Partial<Record<UpgradeStatId, number>>>;
  /** Non-null when the metric is coin value, so venue, Charms and album sets stretch it too. */
  readonly value: { readonly perCharm: number } | null;
}

/** `max` is the base table (every line at level 0, first venue, no Charms, no album bonus). */
export type RateEnvelopeConfig = Readonly<Record<RateEnvelopeMetricId, RateEnvelopeMetricDef>>;

/** One table configuration, as the server knows it. */
export interface RateEnvelopeTable {
  /** Upgrade line id → level; missing lines are at level 0. */
  readonly levels: Readonly<Record<string, number>>;
  readonly venue: VenueId;
  /** Charms owned; only as many as the venue has sockets count. */
  readonly charms: number;
  /** Sum of completed album set bonuses. */
  readonly albumBonus: number;
}

/**
 * The honest-play burst model the base limits are derived from. The economy sim gives
 * mean rates only; these describe how an honest player's drops, cascades and crates
 * bunch up inside a window, so the 99.9th percentile has something to measure.
 */
export interface RateEnvelopeDerivation {
  readonly percentile: number;
  /** Multiplier over the simulated percentile for model error until physics telemetry lands. */
  readonly headroom: number;
  readonly sessions: number;
  readonly seed: number;
  readonly slotMs: number;
  /** Share of play time spent in a Sommelier Pour. */
  readonly pourShare: number;
  /** Drop cadence while pouring, as a multiple of the sim's mean cadence. */
  readonly pourCadence: number;
  readonly meanPourSeconds: number;
  /** How long the pusher takes to turn a burst of drops into falls. */
  readonly tableLagSeconds: number;
  /** Largest clump an OBSCENE cascade drops in one go. */
  readonly obsceneMaxCoins: number;
  /** Largest clump of loose coins below the first cascade tier. */
  readonly looseMaxCoins: number;
  /** A crate falls this many seconds after it spawns, uniformly. */
  readonly crateFallSeconds: { readonly min: number; readonly max: number };
  /**
   * Fastest sustained honest tapping. Physics-measured metrics (fusions) take the busiest
   * window of every measured play style up to this cadence, Sommelier Pours included.
   */
  readonly honestTapsPerSecond: number;
}
