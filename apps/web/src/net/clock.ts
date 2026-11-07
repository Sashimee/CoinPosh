import type { EpochMs } from '@coinposh/shared';

/** Milliseconds from an arbitrary origin that only moves forward; immune to wall-clock edits. */
export type Monotonic = () => number;

export const monotonicNow: Monotonic = () => performance.now();

/**
 * The server's clock as last reported, advanced by the monotonic clock. It drives countdowns
 * on screen only: nothing derived from it is ever sent to, or trusted by, the server.
 */
export class ServerClock {
  readonly #monotonic: Monotonic;
  #anchor: { serverTime: EpochMs; at: number } | null = null;

  constructor(monotonic: Monotonic = monotonicNow) {
    this.#monotonic = monotonic;
  }

  sync(serverTime: EpochMs): void {
    this.#anchor = { serverTime, at: this.#monotonic() };
  }

  /** Best estimate of server time now, or `null` before the first sync. */
  now(): EpochMs | null {
    if (this.#anchor === null) return null;
    return this.#anchor.serverTime + Math.max(0, Math.round(this.#monotonic() - this.#anchor.at));
  }

  /** Milliseconds until `at` on the server clock, never negative; `null` before the first sync. */
  msUntil(at: EpochMs): number | null {
    const now = this.now();
    return now === null ? null : Math.max(0, at - now);
  }
}
