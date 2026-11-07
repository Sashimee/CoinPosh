import type { EconomyConfig } from '../types.ts';
import { cascade, coinTiers, fusion } from './coins.ts';
import { currencies } from './currencies.ts';
import { crateRewards, crateSpawn, dropTables, pity } from './drops.ts';
import { pacing } from './pacing.ts';
import { album, ascension, bullion, offline, season, venues } from './progression.ts';
import { upgradeCostRule, upgradeLines } from './upgrades.ts';

export const economyConfig = {
  currencies,
  coinTiers,
  fusion,
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
  fusion,
  offline,
  pacing,
  pity,
  season,
  upgradeCostRule,
  upgradeLines,
  venues,
};
