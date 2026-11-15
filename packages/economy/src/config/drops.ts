import type {
  CrateOpenHistory,
  CrateRewardTable,
  CrateSpawnConfig,
  DropTableDef,
  FirstTicketRule,
  PityConfig,
} from '../types.ts';

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
  /**
   * Tickets only come from Exquisite+ crates (4 % of vault crates), so the Capsule machine sat
   * locked for a whole first session (P-737). The scripted first crate pays one, so the dock's
   * Capsules entry opens on the player's first reward beat.
   */
  firstTicket: { byCrate: 1, amount: 1 },
} as const satisfies CrateSpawnConfig;

/**
 * Tickets the first-Ticket guarantee adds to a crate open on top of its roll. It reads only the
 * player's open count and what earlier opens paid, never the fair roll's stream, so every draw
 * stays where it was and server and Demo pay the same.
 */
export function firstTicketBonus(
  rule: FirstTicketRule,
  history: CrateOpenHistory,
  rolledTickets: number,
): number {
  if (history.ticketsBefore > 0 || rolledTickets > 0) return 0;
  return history.opensBefore + 1 === rule.byCrate ? rule.amount : 0;
}

/**
 * Exquisite crates pay a 25 % Gold Safe instead of a Key: with a Key there, crates alone paid
 * 1.6 Keys per safe and Keys piled up unspent (02-ECONOMY.md "Safes").
 */
export const crateRewards = {
  common: {
    incomeSeconds: 5,
    pearls: 0,
    keys: 0,
    tickets: 0,
    charmChance: 0,
    albumCard: true,
    safeChance: 0,
  },
  fine: {
    incomeSeconds: 12,
    pearls: 1,
    keys: 0,
    tickets: 0,
    charmChance: 1_000,
    albumCard: true,
    safeChance: 200,
  },
  rare: {
    incomeSeconds: 30,
    pearls: 3,
    keys: 0,
    tickets: 0,
    charmChance: 3_000,
    albumCard: true,
    safeChance: 1_000,
  },
  exquisite: {
    incomeSeconds: 90,
    pearls: 8,
    keys: 0,
    tickets: 1,
    charmChance: 6_000,
    albumCard: true,
    safeChance: 2_500,
  },
  legendary: {
    incomeSeconds: 300,
    pearls: 20,
    keys: 1,
    tickets: 2,
    charmChance: 10_000,
    albumCard: true,
    safeChance: 5_000,
  },
  heirloom: {
    incomeSeconds: 900,
    pearls: 50,
    keys: 2,
    tickets: 3,
    charmChance: 10_000,
    albumCard: true,
    safeChance: 10_000,
  },
} as const satisfies CrateRewardTable;
