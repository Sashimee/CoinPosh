import type { Rng } from './rng.ts';
import {
  RARITY_IDS,
  type DropTableDef,
  type PityConfig,
  type PityState,
  type RarityId,
} from './types.ts';

export interface DropRoll {
  readonly rarity: RarityId;
  readonly state: PityState;
  /** The pitied rarity floor that forced this result, or null for a natural roll. */
  readonly pityFloor: RarityId | null;
}

export function rarityRank(rarity: RarityId): number {
  return RARITY_IDS.indexOf(rarity);
}

export function initialPityState(config: PityConfig): PityState {
  return Object.fromEntries(config.rules.map((rule) => [rule.rarity, 0]));
}

function forcedFloor(table: DropTableDef, config: PityConfig, state: PityState): RarityId | null {
  if (!table.pity) return null;
  let floor: RarityId | null = null;
  for (const rule of config.rules) {
    const misses = state[rule.rarity] ?? 0;
    if (
      misses >= rule.within - 1 &&
      (floor === null || rarityRank(rule.rarity) > rarityRank(floor))
    ) {
      floor = rule.rarity;
    }
  }
  return floor;
}

function weightedPick(table: DropTableDef, minRank: number, rng: Rng): RarityId {
  const eligible = RARITY_IDS.filter((rarity) => rarityRank(rarity) >= minRank);
  const total = eligible.reduce((sum, rarity) => sum + table.odds[rarity], 0);
  if (total <= 0) {
    throw new RangeError(
      `Drop table "${table.source}" has no weight at or above ${RARITY_IDS[minRank] ?? minRank}`,
    );
  }
  let roll = rng.nextInt(total);
  for (const rarity of eligible) {
    roll -= table.odds[rarity];
    if (roll < 0) return rarity;
  }
  throw new Error(`Drop table "${table.source}": weighted pick fell through (weights changed?)`);
}

/**
 * One open of a drop source. When a pity counter would expire, the result is drawn from
 * the same table restricted to that rarity and above, so pity never invents odds.
 */
export function rollDrop(
  table: DropTableDef,
  config: PityConfig,
  state: PityState,
  rng: Rng,
): DropRoll {
  const floor = forcedFloor(table, config, state);
  const rarity = weightedPick(table, floor === null ? 0 : rarityRank(floor), rng);
  const rank = rarityRank(rarity);
  const next: Partial<Record<RarityId, number>> = {};
  for (const rule of config.rules) {
    next[rule.rarity] = rank >= rarityRank(rule.rarity) ? 0 : (state[rule.rarity] ?? 0) + 1;
  }
  return { rarity, state: next, pityFloor: floor };
}
