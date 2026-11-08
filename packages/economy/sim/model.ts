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
 *
 * The table a player first sits at holds `economyConfig.openingHeap` instead, laid at the
 * brink, so it starts paying far sooner than its coin count suggests. Re-measured for P-238
 * on sim version 4 (the P-176 cam knock walks a small heap to the lip sooner than P-193
 * measured): the same table without fusion or tower, as the game's worker runs it, centre
 * drops, seeds 1 to 3 at 0.8 and 2.4 drops/s, 120 s each:
 *
 * | Heap | First front fall after (drops) | Front coins per drop over 120 s |
 * | ---- | ------------------------------ | ------------------------------- |
 * | 0    | 130 – 158 (T-1.01)              | 0.90 once steady                |
 * | 25   | 11 – 43, mean 24                | 0.72 – 0.79, still building     |
 * | 50   | 11 – 15, mean 13                | 0.79 – 0.97                     |
 * | 60   | 5 – 15, mean 10                 | 0.81 – 1.02                     |
 * | 100  | 5 – 15, mean 10                 | 0.92 – 1.40, steady from start  |
 */
export interface TablePile {
  /** Coins a table holds once returns are steady. */
  readonly steadyCoins: number;
  /** Coins dropped onto an empty table before the first one leaves the front edge. */
  readonly firstFallAfterDrops: number;
  /**
   * Measured `[heap coins, drops before the first front fall]` points for an opening heap,
   * ascending by heap. Between points the sim interpolates; past the last it holds it.
   */
  readonly firstFallOnHeap: readonly (readonly [heapCoins: number, drops: number])[];
}

/**
 * Drops a player pays into a table that opens with `heapCoins` before anything leaves the
 * front edge: the measured curve, rounded to whole drops.
 */
export function dropsBeforeFirstFall(pile: TablePile, heapCoins: number): number {
  if (!(Number.isFinite(heapCoins) && heapCoins >= 0)) {
    throw new RangeError(`heapCoins must be a finite number ≥ 0, got ${heapCoins}`);
  }
  let prev: readonly [number, number] = [0, pile.firstFallAfterDrops];
  for (const next of pile.firstFallOnHeap) {
    const [x0, y0] = prev;
    const [x1, y1] = next;
    if (!(x1 > x0)) throw new RangeError('pile.firstFallOnHeap must be ascending by heap size');
    if (heapCoins <= x1) return Math.round(y0 + ((heapCoins - x0) / (x1 - x0)) * (y1 - y0));
    prev = next;
  }
  return Math.round(prev[1]);
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
  // The opening heap is a hard FTUE dependency: from an empty table, 20 starting coins
  // never reach the front edge (balance report T-1.16, "First upgrade").
  pile: {
    steadyCoins: 195,
    firstFallAfterDrops: 145,
    firstFallOnHeap: [
      [25, 24],
      [50, 13],
      [60, 10],
      [100, 10],
    ],
  },
} as const satisfies SimModel;
