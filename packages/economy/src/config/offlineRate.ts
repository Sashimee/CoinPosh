/**
 * The Velvet Vault's measured active rate: what `min(hoursAway, cap) × 0.35 × measuredActiveRate`
 * (02-ECONOMY) multiplies by. Defined here rather than in ../types.ts so the rule ships with its
 * numbers; the server measures it from its ledger and the Demo mock from its own, both through
 * these functions, and the client never supplies or sees the rate.
 *
 * The rate is net coins the wallet gained from play (falls won minus drops paid) over the last
 * stretch of active play, never over account age, so time spent away or idle cannot inflate it
 * and Vault payouts, crate loot and the Steward's allowance never compound into it.
 */
import { offlineEarnings } from '../formulas.ts';
import type { OfflineConfig } from '../types.ts';
import { offline } from './progression.ts';

export interface OfflineRateConfig {
  /** Only play within this long before the latest play entry counts: the stretch before leaving. */
  readonly windowMs: number;
  /**
   * The measured span is never shorter than this, so a lucky cascade seconds before leaving
   * does not read as a sustained rate.
   */
  readonly minSpanMs: number;
  /**
   * Active coins per hour the Vault assumes for a player whose measured rate is lower,
   * including a fresh profile that has won nothing yet. A copper a minute: away for the base
   * 2 h cap it pays `2 × 0.35 × 60 = 42` coins, a warm welcome back that never out-earns play
   * (the economy sim's starter nets ≥ 2,000 coins per active hour once the ledge pays).
   */
  readonly starterRatePerHour: number;
  /**
   * Coins per second a Vault Crate's `incomeSeconds` are worth at least. Crate coins are paid
   * during play, so they keep the one-copper-per-second floor instead of the starter floor.
   */
  readonly crateIncomeFloorPerSecond: number;
}

export const offlineRate = {
  windowMs: 30 * 60_000,
  minSpanMs: 10 * 60_000,
  starterRatePerHour: 60,
  crateIncomeFloorPerSecond: 1,
} as const satisfies OfflineRateConfig;

const HOUR_MS = 3_600_000;
const FLOAT_SLACK = 1e-9;

/** Net wallet coins from play over one stretch, between its first and last play entry. */
export interface PlayStretch {
  readonly netCoins: number;
  readonly firstAt: number;
  readonly lastAt: number;
}

/** One wallet coin movement from play: a fall won (positive) or a drop paid (negative). */
export interface PlayEntry {
  readonly at: number;
  readonly coins: number;
}

/** Where a stretch ending at `lastAt` starts counting play, inclusive. */
export function playWindowStart(lastAt: number, config: OfflineRateConfig = offlineRate): number {
  return lastAt - config.windowMs;
}

/** The stretch of `entries` (any order) inside the window before the latest one, or null if none. */
export function playStretchOf(
  entries: readonly PlayEntry[],
  config: OfflineRateConfig = offlineRate,
): PlayStretch | null {
  if (entries.length === 0) return null;
  const lastAt = Math.max(...entries.map((entry) => entry.at));
  const start = playWindowStart(lastAt, config);
  let netCoins = 0;
  let firstAt = lastAt;
  for (const entry of entries) {
    if (entry.at < start) continue;
    netCoins += entry.coins;
    firstAt = Math.min(firstAt, entry.at);
  }
  return { netCoins, firstAt, lastAt };
}

/** Net coins per active hour over `stretch`; 0 when there is none or play lost coins. */
export function measuredActiveRatePerHour(
  stretch: PlayStretch | null,
  config: OfflineRateConfig = offlineRate,
): number {
  if (stretch === null) return 0;
  const { netCoins, firstAt, lastAt } = stretch;
  if (!Number.isFinite(netCoins) || !(lastAt >= firstAt)) {
    throw new RangeError(
      `measuredActiveRatePerHour: need finite net coins and lastAt ≥ firstAt, got ${JSON.stringify(stretch)}`,
    );
  }
  if (netCoins <= 0) return 0;
  return (netCoins * HOUR_MS) / Math.max(lastAt - firstAt, config.minSpanMs);
}

/** The active rate the Vault pays on: the measured rate, never below the starter floor. */
export function vaultRatePerHour(
  measuredPerHour: number,
  config: OfflineRateConfig = offlineRate,
): number {
  return Math.max(measuredPerHour, config.starterRatePerHour);
}

/** Whole coins the Vault pays for `hoursAway`, with the cap clamped to the offline config range. */
export function offlineVaultCoins(
  hoursAway: number,
  capHours: number,
  measuredPerHour: number,
  config: OfflineRateConfig = offlineRate,
  vault: OfflineConfig = offline,
): number {
  const coins = offlineEarnings(
    hoursAway,
    capHours,
    vaultRatePerHour(measuredPerHour, config),
    vault,
  );
  // 12 × 0.35 × 60 is 251.99999999999997 in floating point; a whole payout must not lose a coin.
  return Math.floor(coins + FLOAT_SLACK);
}

/** The most a profile that has won nothing can collect from one absence at `capHours`. */
export function starterVaultCoins(
  capHours: number,
  config: OfflineRateConfig = offlineRate,
  vault: OfflineConfig = offline,
): number {
  return offlineVaultCoins(Number.MAX_SAFE_INTEGER, capHours, 0, config, vault);
}

/** Coins a crate worth `incomeSeconds` of active income pays at the measured rate. */
export function crateIncomeCoins(
  incomeSeconds: number,
  measuredPerHour: number,
  config: OfflineRateConfig = offlineRate,
): number {
  const perSecond = Math.max(measuredPerHour / 3_600, config.crateIncomeFloorPerSecond);
  return Math.max(1, Math.round(incomeSeconds * perSecond));
}
