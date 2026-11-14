import {
  cascadeTierFor,
  upgradeCost,
  upgradeStat,
  type CascadeConfig,
  type CascadeTierDef,
  type UpgradeLineDef,
  type UpgradeStatId,
} from '@coinposh/economy';

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
  /** What the Vault shows: the server's wallet plus winnings still waiting for its answer. */
  readonly coins: number;
  /**
   * The part of `coins` the server can spend: the wallet alone, since provisional winnings are
   * not yet confirmed. Omitted means all of it.
   */
  readonly spendableCoins?: number;
  readonly goldBars: number;
}

export interface UpgradeRow {
  readonly line: UpgradeLineDef;
  readonly level: number;
  readonly maxed: boolean;
  /** Price of the next level, or null once maxed. */
  readonly cost: number | null;
  /** Whether the server can pay the price now, from spendable coins or gold bars. */
  readonly affordable: boolean;
  readonly current: number;
  readonly nextValue: number | null;
  readonly format: StatFormat;
}

export function spendableCoins(wallet: Wallet): number {
  return Math.min(wallet.coins, wallet.spendableCoins ?? wallet.coins);
}

/** What the table holds for the player, as the server and the outbox report it. */
export interface VaultBalance {
  /** The server's wallet: the only coins it can spend. */
  readonly walletCoins: number;
  /** Worth of the pre-minted drop buffer, already paid for out of the wallet. */
  readonly bufferedCoins: number;
  /** Winnings sent to the server and not yet confirmed. */
  readonly provisionalCoins: number;
  readonly goldBars: number;
}

export interface VaultReadout extends Wallet {
  readonly spendableCoins: number;
  /** True while some of `coins` waits on the server's answer. */
  readonly provisional: boolean;
  /** The drop buffer: paid for, ready to drop, and shown apart from the Vault. */
  readonly inHand: number;
}

/**
 * The Vault figure is the wallet the server spends plus winnings it has yet to confirm, so a
 * price at or below a settled Vault is always one the server accepts. The drop buffer was paid
 * for out of the wallet already and can only be dropped, so it is reported on its own.
 */
export function vaultReadout(balance: VaultBalance): VaultReadout {
  return {
    coins: balance.walletCoins + balance.provisionalCoins,
    spendableCoins: balance.walletCoins,
    goldBars: balance.goldBars,
    provisional: balance.provisionalCoins > 0,
    inHand: balance.bufferedCoins,
  };
}

export function upgradeRow(line: UpgradeLineDef, level: number, wallet: Wallet): UpgradeRow {
  const clamped = Math.min(Math.max(0, Math.floor(level)), line.maxLevel);
  const maxed = clamped >= line.maxLevel;
  const cost = maxed ? null : upgradeCost(line, clamped);
  const spendable = line.currency === 'coins' ? spendableCoins(wallet) : wallet.goldBars;
  return {
    line,
    level: clamped,
    maxed,
    cost,
    affordable: cost !== null && spendable >= cost,
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
