import type { EconomyConfig } from '../types.ts';
import { cascade, coinTiers, fusion, openingHeap } from './coins.ts';
import { currencies } from './currencies.ts';
import { crateRewards, crateSpawn, dropTables, pity } from './drops.ts';
import { ftueTargets, ladderTargets, pacing } from './pacing.ts';
import { album, ascension, bullion, offline, season, venues } from './progression.ts';
import { upgradeCostRule, upgradeLines } from './upgrades.ts';
// Imported last and read through a getter: ../config.ts imports this module back, so
// the leaf tables above must be initialised before it runs, and rateEnvelope may still be
// uninitialised while this module evaluates when ../config.ts is the entry point.
import { rateEnvelope } from '../config.ts';

export const economyConfig = {
  currencies,
  coinTiers,
  fusion,
  openingHeap,
  cascade,
  upgradeCostRule,
  upgradeLines,
  dropTables,
  pity,
  crateSpawn,
  crateRewards,
  venues,
  album,
  offline,
  bullion,
  ascension,
  season,
  pacing,
  get rateEnvelope() {
    return rateEnvelope;
  },
} as const satisfies EconomyConfig;

export {
  album,
  ascension,
  bullion,
  cascade,
  coinTiers,
  crateRewards,
  crateSpawn,
  currencies,
  dropTables,
  ftueTargets,
  fusion,
  ladderTargets,
  offline,
  openingHeap,
  pacing,
  pity,
  season,
  upgradeCostRule,
  upgradeLines,
  venues,
};

export * from './allowance.ts';
export * from './offlineRate.ts';
export * from './quests.ts';
export * from './season.ts';
