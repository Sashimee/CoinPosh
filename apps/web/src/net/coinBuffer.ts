import type { CoinId, MintedCoin } from '@coinposh/shared';

/**
 * The pre-minted, already-paid coins the server handed us. Dropping one shows a real,
 * server-minted coin instantly (and keeps play going offline); the drop request then spends
 * it on the server. The server's list is always the truth: `replace` adopts it wholesale and
 * only hides the coins we have spent locally but the server has not yet confirmed.
 */
export class CoinBuffer {
  #available: MintedCoin[] = [];
  readonly #spending = new Map<CoinId, MintedCoin>();

  get size(): number {
    return this.#available.length;
  }

  /** Coins dropped locally whose spend the server has not acknowledged yet. */
  get spending(): readonly MintedCoin[] {
    return [...this.#spending.values()];
  }

  replace(serverBuffer: readonly MintedCoin[]): void {
    const seen = new Set<CoinId>();
    this.#available = serverBuffer.filter((coin) => {
      if (seen.has(coin.id) || this.#spending.has(coin.id)) return false;
      seen.add(coin.id);
      return true;
    });
  }

  peek(): MintedCoin | null {
    return this.#available[0] ?? null;
  }

  /** Takes the oldest coin for a local drop, or `null` when the buffer is dry. */
  take(): MintedCoin | null {
    const coin = this.#available.shift();
    if (coin === undefined) return null;
    this.#spending.set(coin.id, coin);
    return coin;
  }

  /** Marks a coin as spent before the server has seen it (restoring a persisted queue). */
  markSpending(coin: MintedCoin): void {
    this.#available = this.#available.filter((candidate) => candidate.id !== coin.id);
    this.#spending.set(coin.id, coin);
  }

  /** The server accepted the spend; the coin is now on the table. */
  settle(coinId: CoinId): void {
    this.#spending.delete(coinId);
  }

  /**
   * The server refused the spend (table frozen, unknown coin). The coin is not put back:
   * the next server buffer says whether it still exists.
   */
  abandon(coinId: CoinId): void {
    this.#spending.delete(coinId);
  }
}
