import type { CoinId, MintedCoin } from '@coinposh/shared';
import { MAX_DROP_OFFSET_MM } from '../simWorker/sim-api.ts';

export function clampAim(aim: number): number {
  if (Number.isNaN(aim)) throw new RangeError('clampAim: aim is NaN');
  return Math.min(1, Math.max(-1, aim));
}

/** The sim takes integer millimetres; the server takes the aim it was derived from. */
export function aimToMm(aim: number): number {
  return Math.round(clampAim(aim) * MAX_DROP_OFFSET_MM) || 0;
}

/**
 * Which server coin each sim body is. The sim numbers bodies in drop order and each drop makes
 * one body, so the n-th new body is the n-th coin handed to the sim. Coins the server later
 * rejects stay mapped but are never claimed.
 */
export class CoinLedger {
  readonly #expected: MintedCoin[] = [];
  readonly #bySim = new Map<number, MintedCoin>();
  readonly #simOf = new Map<CoinId, number>();
  readonly #voided = new Set<CoinId>();

  /** Records a coin just handed to `SimBridge.drop`. */
  expect(coin: MintedCoin): void {
    this.#expected.push(coin);
  }

  /** Pairs a new sim body with the oldest coin still waiting for one. */
  assign(simId: number): MintedCoin | null {
    const coin = this.#expected.shift();
    if (!coin) return null;
    this.#bySim.set(simId, coin);
    this.#simOf.set(coin.id, simId);
    return coin;
  }

  /** The coin a sim body is, or null when it is not one the server can be asked to pay for. */
  claimable(simId: number): MintedCoin | null {
    const coin = this.#bySim.get(simId);
    return coin && !this.#voided.has(coin.id) ? coin : null;
  }

  coinOf(simId: number): MintedCoin | null {
    return this.#bySim.get(simId) ?? null;
  }

  /** Swaps in the server's coin when it settled a buffered drop under a different identity. */
  replace(previous: CoinId, coin: MintedCoin): void {
    const queued = this.#expected.findIndex((candidate) => candidate.id === previous);
    if (queued >= 0) {
      this.#expected[queued] = coin;
      return;
    }
    const simId = this.#simOf.get(previous);
    if (simId === undefined) return;
    this.#simOf.delete(previous);
    this.#bySim.set(simId, coin);
    this.#simOf.set(coin.id, simId);
  }

  void(coinId: CoinId): void {
    this.#voided.add(coinId);
  }

  /** Forgets a body that left the table; its coin can never be claimed twice. */
  release(simId: number): void {
    const coin = this.#bySim.get(simId);
    this.#bySim.delete(simId);
    if (!coin) return;
    this.#simOf.delete(coin.id);
    this.#voided.delete(coin.id);
  }

  get waiting(): number {
    return this.#expected.length;
  }

  get mapped(): number {
    return this.#bySim.size;
  }
}
