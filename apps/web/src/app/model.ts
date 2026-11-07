import {
  cascadeTierFor,
  upgradeCost,
  upgradeStat,
  type CascadeConfig,
  type CascadeTierDef,
  type UpgradeLineDef,
  type UpgradeStatId,
} from './economy.ts';

export interface ComboView {
  readonly count: number;
  readonly tier: CascadeTierDef | null;
  /** 0 = no tier, 1..N = index of the reached tier plus one. */
  readonly rank: number;
  readonly next: CascadeTierDef | null;
  readonly toNext: number;
  /** 0..1 flute fill: each tier owns an equal band, filled by progress toward its threshold. */
  readonly fill: number;
  readonly multiplier: number;
}

export function comboView(count: number, config: CascadeConfig): ComboView {
  const coins = Math.max(0, Math.floor(count));
  const tiers = config.tiers;
  const tier = cascadeTierFor(coins, config);
  const rank = tier ? tiers.indexOf(tier) + 1 : 0;
  const next = tiers[rank] ?? null;
  const band = 1 / tiers.length;
  let fill = 1;
  if (next) {
    const floor = tier?.minCoins ?? 0;
    fill = band * rank + (band * (coins - floor)) / (next.minCoins - floor);
  }
  return {
    count: coins,
    tier,
    rank,
    next,
    toNext: next ? next.minCoins - coins : 0,
    fill,
    multiplier: tier?.multiplier ?? 1,
  };
}

export type DecorumLevel = 'calm' | 'warning' | 'critical' | 'frozen';

export const DECORUM_WARNING_AT = 0.6;
export const DECORUM_CRITICAL_AT = 0.85;

export interface DecorumState {
  readonly used: number;
  readonly capacity: number;
  /** Seconds left on the Concierge freeze; 0 when the table runs. */
  readonly frozenSeconds: number;
}

export interface DecorumView {
  readonly fraction: number;
  readonly level: DecorumLevel;
  readonly frozenSeconds: number;
}

export function decorumView(state: DecorumState): DecorumView {
  const fraction = state.capacity > 0 ? Math.min(1, Math.max(0, state.used / state.capacity)) : 0;
  const frozenSeconds = Math.max(0, Math.ceil(state.frozenSeconds));
  let level: DecorumLevel = 'calm';
  if (frozenSeconds > 0) level = 'frozen';
  else if (fraction >= DECORUM_CRITICAL_AT) level = 'critical';
  else if (fraction >= DECORUM_WARNING_AT) level = 'warning';
  return { fraction, level, frozenSeconds };
}

export type StatFormat = 'multiplier' | 'count' | 'hours';

const STAT_FORMATS: Readonly<Record<UpgradeStatId, StatFormat>> = {
  pusherSpeed: 'multiplier',
  dropRate: 'multiplier',
  coinValue: 'multiplier',
  crateChance: 'multiplier',
  vaultCapacity: 'count',
  offlineHours: 'hours',
  fusionWindow: 'multiplier',
  decorumCapacity: 'count',
  globalCoinValue: 'multiplier',
  globalCrateChance: 'multiplier',
  startingCoins: 'count',
};

export interface Wallet {
  readonly coins: number;
  readonly goldBars: number;
}

export interface UpgradeRow {
  readonly line: UpgradeLineDef;
  readonly level: number;
  readonly maxed: boolean;
  /** Price of the next level, or null once maxed. */
  readonly cost: number | null;
  readonly affordable: boolean;
  readonly current: number;
  readonly nextValue: number | null;
  readonly format: StatFormat;
}

export function upgradeRow(line: UpgradeLineDef, level: number, wallet: Wallet): UpgradeRow {
  const clamped = Math.min(Math.max(0, Math.floor(level)), line.maxLevel);
  const maxed = clamped >= line.maxLevel;
  const cost = maxed ? null : upgradeCost(line, clamped);
  const funds = line.currency === 'coins' ? wallet.coins : wallet.goldBars;
  return {
    line,
    level: clamped,
    maxed,
    cost,
    affordable: cost !== null && funds >= cost,
    current: upgradeStat(line, clamped),
    nextValue: maxed ? null : upgradeStat(line, clamped + 1),
    format: STAT_FORMATS[line.effect.stat],
  };
}

export function upgradeRows(
  lines: readonly UpgradeLineDef[],
  levels: Readonly<Record<string, number>>,
  wallet: Wallet,
): UpgradeRow[] {
  return lines.map((line) => upgradeRow(line, levels[line.id] ?? 0, wallet));
}

export function affordableCount(rows: readonly UpgradeRow[]): number {
  return rows.filter((row) => row.affordable).length;
}
