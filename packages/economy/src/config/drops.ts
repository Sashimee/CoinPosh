import type { CrateRewardTable, CrateSpawnConfig, DropTableDef, PityConfig } from '../types.ts';

/** Weights in basis points of a percent (10 000 = 100 %). Mirrors 02-ECONOMY.md "Drop tables". */
export const dropTables = [
  {
    source: 'vaultCrate',
    pity: true,
    odds: { common: 6_200, fine: 2_500, rare: 900, exquisite: 300, legendary: 95, heirloom: 5 },
  },
  {
    source: 'goldSafe',
    pity: true,
    odds: { common: 3_500, fine: 3_500, rare: 2_000, exquisite: 750, legendary: 240, heirloom: 10 },
  },
  {
    source: 'gacha',
    pity: true,
    odds: { common: 5_500, fine: 2_700, rare: 1_200, exquisite: 450, legendary: 140, heirloom: 10 },
  },
  {
    source: 'scratch',
    pity: true,
    odds: { common: 7_000, fine: 2_000, rare: 750, exquisite: 200, legendary: 50, heirloom: 0 },
  },
] as const satisfies readonly DropTableDef[];

export const pity = {
  rules: [
    { rarity: 'rare', within: 10 },
    { rarity: 'exquisite', within: 40 },
    { rarity: 'legendary', within: 120 },
  ],
} as const satisfies PityConfig;

export const crateSpawn = {
  dropsPerCrate: 40,
  ftueScriptedDrop: 12,
  ftueScriptedRarity: 'fine',
  ftueScriptedCharm: true,
} as const satisfies CrateSpawnConfig;

export const crateRewards = {
  common: { incomeSeconds: 5, pearls: 0, keys: 0, tickets: 0, charmChance: 0, albumCard: true },
  fine: { incomeSeconds: 12, pearls: 1, keys: 0, tickets: 0, charmChance: 1_000, albumCard: true },
  rare: { incomeSeconds: 30, pearls: 3, keys: 0, tickets: 0, charmChance: 3_000, albumCard: true },
  exquisite: {
    incomeSeconds: 90,
    pearls: 8,
    keys: 1,
    tickets: 1,
    charmChance: 6_000,
    albumCard: true,
  },
  legendary: {
    incomeSeconds: 300,
    pearls: 20,
    keys: 1,
    tickets: 2,
    charmChance: 10_000,
    albumCard: true,
  },
  heirloom: {
    incomeSeconds: 900,
    pearls: 50,
    keys: 2,
    tickets: 3,
    charmChance: 10_000,
    albumCard: true,
  },
} as const satisfies CrateRewardTable;
