import type {
  AlbumSetDef,
  AscensionConfig,
  BullionConfig,
  OfflineConfig,
  SeasonConfig,
  VenueDef,
} from '../types.ts';

export const venues = [
  {
    id: 'rivieraYacht',
    order: 1,
    bullionThreshold: 2_800,
    coinValueMultiplier: 1,
    charmSockets: 3,
  },
  {
    id: 'salonDeParis',
    order: 2,
    bullionThreshold: 20_000,
    coinValueMultiplier: 2,
    charmSockets: 4,
  },
  {
    id: 'tokyoPenthouse',
    order: 3,
    bullionThreshold: 108_000,
    coinValueMultiplier: 4,
    charmSockets: 5,
  },
  {
    id: 'alpineChalet',
    order: 4,
    bullionThreshold: 648_000,
    coinValueMultiplier: 8,
    charmSockets: 6,
  },
  {
    id: 'orbitalCasino',
    order: 5,
    bullionThreshold: 3_888_000,
    coinValueMultiplier: 16,
    charmSockets: 7,
  },
] as const satisfies readonly VenueDef[];

export const album = [
  {
    id: 'deckEssentials',
    venue: 'rivieraYacht',
    globalBonus: 0.05,
    items: [
      { id: 'teakDeckCoin', rarity: 'common' },
      { id: 'brassCleatCoin', rarity: 'common' },
      { id: 'lifebuoyCoin', rarity: 'common' },
      { id: 'anchorCoin', rarity: 'common' },
      { id: 'compassRoseCoin', rarity: 'fine' },
      { id: 'captainsBellCharm', rarity: 'fine' },
    ],
  },
  {
    id: 'captainsTable',
    venue: 'rivieraYacht',
    globalBonus: 0.08,
    items: [
      { id: 'sailclothCoin', rarity: 'common' },
      { id: 'portholeCoin', rarity: 'common' },
      { id: 'sextantCoin', rarity: 'fine' },
      { id: 'champagneBucketCharm', rarity: 'fine' },
      { id: 'navyLacquerCoin', rarity: 'rare' },
      { id: 'harbourLightsCoin', rarity: 'rare' },
    ],
  },
  {
    id: 'sunsetGala',
    venue: 'rivieraYacht',
    globalBonus: 0.15,
    items: [
      { id: 'coralSunsetCoin', rarity: 'fine' },
      { id: 'yachtClubPennant', rarity: 'rare' },
      { id: 'pearlNecklaceCharm', rarity: 'rare' },
      { id: 'brushedGoldHelmCoin', rarity: 'exquisite' },
      { id: 'monacoGrandPrixCoin', rarity: 'exquisite' },
      { id: 'admiralsSovereign', rarity: 'legendary' },
      { id: 'duchessSovereign1891', rarity: 'heirloom' },
    ],
  },
] as const satisfies readonly AlbumSetDef[];

export const offline = {
  activeRateFactor: 0.35,
  baseCapHours: 2,
  maxCapHours: 12,
} as const satisfies OfflineConfig;

export const bullion = {
  valuePerBullion: 1_000,
} as const satisfies BullionConfig;

export const ascension = {
  goldBarScale: 10,
} as const satisfies AscensionConfig;

export const season = {
  weeks: 6,
  freeTiers: 50,
  starsPerTier: 350,
  dropsPerStar: 25,
  starsPerCrate: 2,
  starsPerAlbumSet: 50,
} as const satisfies SeasonConfig;
