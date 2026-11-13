import type { StateResponse } from '@coinposh/shared';

/** How many times a booted state is laid on a fresh sim before play goes back to the old one. */
export const LAY_ATTEMPTS = 2;

export interface TableRelaySteps<Laid> {
  /** The state the table being played was laid from. */
  readonly state: StateResponse;
  /** Stops play on the table being played; its sim keeps drawing the coins where they lie. */
  readonly hold: () => void;
  /** GET /v1/state with `hydrate=boot`: the new venue's heap, crates and session. */
  readonly boot: () => Promise<StateResponse>;
  /** Starts a sim laid from `state` and resolves once that sim is ready. */
  readonly lay: (state: StateResponse) => Promise<Laid>;
  /** Hands the table to the laid sim and starts play on it. */
  readonly play: (laid: Laid, state: StateResponse) => void;
  /** Throws away a laid sim that never got the table. */
  readonly discard: (laid: Laid) => void;
  /**
   * Starts play again on the held sim. `booted` says whether `state` is a fresh boot, whose
   * session the table now holds, or the state the held table was laid from.
   */
  readonly resume: (state: StateResponse, booted: boolean) => void;
  readonly onError: (error: unknown) => void;
}

export interface TableRelay {
  /** Holds play on the old table, then boots the new venue; rejects for the caller to retry. */
  bootState(): Promise<StateResponse>;
  /**
   * Lays a booted state on a fresh sim, retrying the lay once. When no sim takes it, play
   * restarts on the held sim under the booted session, so the table never goes dead.
   */
  layTable(state: StateResponse): Promise<void>;
  /** Every boot failed: play restarts on the held sim from the state it was laid from. */
  failed(error: unknown): void;
  dispose(): void;
}

/**
 * Re-lays the table after an ascension the way the boot lays it: the server forgot every coin
 * and crate on the old table, so the new venue is laid from a `hydrate=boot` state and every
 * coin on screen is one the server will pay. The old sim keeps drawing until the new one is
 * ready, so the swap never flashes an empty table, and a relay that fails puts play back on it.
 */
export function createTableRelay<Laid>(steps: TableRelaySteps<Laid>): TableRelay {
  let good = steps.state;
  let held = false;
  let disposed = false;

  const resume = (state: StateResponse, booted: boolean): void => {
    if (!held || disposed) return;
    held = false;
    good = state;
    steps.resume(state, booted);
  };

  const layOnce = async (state: StateResponse): Promise<void> => {
    const laid = await steps.lay(state);
    if (disposed) {
      steps.discard(laid);
      return;
    }
    try {
      steps.play(laid, state);
    } catch (error) {
      steps.discard(laid);
      throw error;
    }
  };

  return {
    async bootState() {
      if (disposed) throw new Error('CoinPosh ascension: the table relay was disposed.');
      if (!held) {
        held = true;
        steps.hold();
      }
      return steps.boot();
    },
    async layTable(state) {
      let failure: unknown = null;
      for (let attempt = 0; attempt < LAY_ATTEMPTS; attempt += 1) {
        if (disposed) return;
        try {
          await layOnce(state);
          held = false;
          good = state;
          return;
        } catch (error) {
          failure = error;
        }
      }
      if (disposed) return;
      steps.onError(failure);
      resume(state, true);
    },
    failed(error) {
      if (disposed) return;
      steps.onError(error);
      resume(good, false);
    },
    dispose() {
      disposed = true;
    },
  };
}
