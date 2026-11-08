import type { OfflineSettlement } from '@coinposh/shared';

const MINUTE_MS = 60_000;

export interface VaultReturn {
  readonly awayMs: number;
  readonly creditedMs: number;
  readonly coins: number;
  /** The player was away longer than their vault keeps pushing. */
  readonly capped: boolean;
  readonly away: { readonly hours: number; readonly minutes: number };
  readonly credited: { readonly hours: number; readonly minutes: number };
}

function hoursAndMinutes(ms: number): { hours: number; minutes: number } {
  const totalMinutes = Math.floor(ms / MINUTE_MS);
  return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
}

/** What the return screen shows, read straight off the server's settlement; null means skip it. */
export function vaultReturnFrom(settlement: OfflineSettlement | null): VaultReturn | null {
  if (settlement === null || settlement.coins <= 0) return null;
  if (settlement.creditedMs > settlement.awayMs) {
    throw new RangeError(
      `Offline settlement credits ${settlement.creditedMs} ms for ${settlement.awayMs} ms away; the server must clamp credited time to time away`,
    );
  }
  return {
    awayMs: settlement.awayMs,
    creditedMs: settlement.creditedMs,
    coins: settlement.coins,
    capped: settlement.creditedMs < settlement.awayMs,
    away: hoursAndMinutes(settlement.awayMs),
    credited: hoursAndMinutes(settlement.creditedMs),
  };
}

export interface VaultTimeline {
  readonly doorMs: number;
  readonly avalancheAtMs: number;
  readonly countAtMs: number;
  readonly countMs: number;
  /** Collect unlocks here; a tap anywhere before it fast-forwards to the end state. */
  readonly collectAtMs: number;
}

/** Door swings, coins pour out as it clears, the odometer rolls under the pour and lands. */
export const FULL_TIMELINE: VaultTimeline = {
  doorMs: 450,
  avalancheAtMs: 260,
  countAtMs: 420,
  countMs: 1_500,
  collectAtMs: 2_000,
};

/** Reduced motion: the door is already open on a settled pile and the total is shown at once. */
export const REDUCED_TIMELINE: VaultTimeline = {
  doorMs: 0,
  avalancheAtMs: 0,
  countAtMs: 0,
  countMs: 0,
  collectAtMs: 0,
};

export function vaultTimeline(reducedMotion: boolean): VaultTimeline {
  return reducedMotion ? REDUCED_TIMELINE : FULL_TIMELINE;
}

export const AVALANCHE_MIN_COINS = 12;
export const AVALANCHE_MAX_COINS = 90;

/** More coins for bigger hauls, on a log scale so a huge return stays readable and cheap. */
export function avalancheCoinCount(coins: number): number {
  if (!Number.isFinite(coins) || coins <= 0) return 0;
  const scaled = Math.round(AVALANCHE_MIN_COINS + 18 * Math.log10(coins));
  return Math.min(AVALANCHE_MAX_COINS, Math.max(AVALANCHE_MIN_COINS, scaled));
}
