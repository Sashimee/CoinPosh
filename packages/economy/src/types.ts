export const CURRENCY_IDS = [
  'coins',
  'bullion',
  'goldBars',
  'pearls',
  'keys',
  'tickets',
  'stars',
] as const;
export type CurrencyId = (typeof CURRENCY_IDS)[number];

export type CurrencyKind = 'soft' | 'progress' | 'prestige' | 'premium' | 'utility' | 'seasonXp';

export interface CurrencyDef {
  readonly id: CurrencyId;
  readonly kind: CurrencyKind;
  readonly resetsOnAscension: boolean;
  readonly sources: readonly string[];
  readonly sinks: readonly string[];
}

export const COIN_TIER_IDS = [
  'copper',
  'silver',
  'gold',
  'platinum',
  'diamond',
  'heirloom',
] as const;
export type CoinTierId = (typeof COIN_TIER_IDS)[number];

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

export const CASCADE_TIER_IDS = ['chic', 'lavish', 'opulent', 'decadent', 'obscene'] as const;
export type CascadeTierId = (typeof CASCADE_TIER_IDS)[number];

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

export const RARITY_IDS = ['common', 'fine', 'rare', 'exquisite', 'legendary', 'heirloom'] as const;
export type RarityId = (typeof RARITY_IDS)[number];

/** Weights in basis points of a percent: 10 000 = 100 %. Integers only, so sums are exact. */
export type OddsTable = Readonly<Record<RarityId, number>>;

export const DROP_SOURCE_IDS = ['vaultCrate', 'goldSafe', 'gacha', 'scratch'] as const;
export type DropSourceId = (typeof DROP_SOURCE_IDS)[number];

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

export const VENUE_IDS = [
  'rivieraYacht',
  'salonDeParis',
  'tokyoPenthouse',
  'alpineChalet',
  'orbitalCasino',
] as const;
export type VenueId = (typeof VENUE_IDS)[number];

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

export interface EconomyConfig {
  readonly currencies: readonly CurrencyDef[];
  readonly coinTiers: readonly CoinTierDef[];
  readonly fusion: FusionConfig;
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
}
