import type { CascadeTierId } from '../src/types.ts';

/**
 * Behavioural and physics-proxy assumptions the balancing sim needs but that are not
 * economy rules. They stand in for measured table rates until T-1.02's physics and
 * playtest telemetry replace them; every number here is a tuning input, not a promise.
 */
export interface SimModel {
  readonly tickSeconds: number;
  /** Coins a player drops per second at dropRate 1 (tap / pour cadence). */
  readonly baseDropsPerSecond: number;
  /** Value pushed off the ledge per unit of face value dropped, before any multiplier. */
  readonly baseReturnRatio: number;
  /** Share of pushed-off coins landing in each cascade tier (the rest earn no combo). */
  readonly cascadeShare: Readonly<Record<CascadeTierId, number>>;
  /** Share of returned value that passed through one Contact Fusion at fusionWindow 1. */
  readonly fusionShare: number;
  /** Income bonus per slotted Charm (proxy for pegs, ropes, magnets...). */
  readonly charmIncomeBonus: number;
  /** Coins a player keeps in hand for dropping instead of spending on upgrades. */
  readonly dropReserve: number;
  /** Active-play ceiling for the FTUE-to-season cohort. */
  readonly activeCapHours: number;
  readonly casual: CasualSchedule;
  readonly pile: TablePile;
}

/**
 * The coin pile the pusher works. Measured on packages/sim's PusherTable (T-1.01) with
 * copper drops across the full chute width, seeds 1 to 3 at 0.8 to 2.4 drops/s: an empty
 * table pays nothing until 130 to 158 coins sit on it and settles at 165 to 212 coins.
 */
export interface TablePile {
  /** Coins a table holds once returns are steady. */
  readonly steadyCoins: number;
  /** Coins dropped onto an empty table before the first one leaves the front edge. */
  readonly firstFallAfterDrops: number;
  /** Coins already on the table when a player first sits down (house stock, not theirs). */
  readonly startingCoins: number;
}

export interface CasualSchedule {
  /** Local hour each session starts at, in order within a day. */
  readonly sessionStartHours: readonly number[];
  readonly sessionMinutes: number;
}

export const simModel = {
  tickSeconds: 1,
  baseDropsPerSecond: 0.8,
  baseReturnRatio: 1.25,
  cascadeShare: { chic: 0.3, lavish: 0.15, opulent: 0.09, decadent: 0.045, obscene: 0.015 },
  fusionShare: 0.15,
  charmIncomeBonus: 0.06,
  dropReserve: 10,
  activeCapHours: 60,
  casual: {
    sessionStartHours: [8, 20],
    sessionMinutes: 25,
  },
  // A seeded table is a hard FTUE dependency: from an empty one, 20 starting coins never
  // reach the front edge (balance report T-1.16, "First upgrade").
  pile: {
    steadyCoins: 195,
    firstFallAfterDrops: 145,
    startingCoins: 195,
  },
} as const satisfies SimModel;
