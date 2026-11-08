import type {
  Claim,
  ClaimResult,
  CoinId,
  CrateId,
  DropResponse,
  EpochMs,
  FallEdge,
  Fraction,
  IdempotencyKey,
  MintedCoin,
  NudgeDirection,
  StateResponse,
  TableCrate,
  Tick,
  Wallet,
} from '@coinposh/shared';
import { backoffDelay, type ApiClient, type RetryPolicy } from './client.ts';
import { CoinBuffer } from './coinBuffer.ts';
import type { Connectivity, Scheduler } from './connectivity.ts';
import { NetworkError, isRetryable } from './errors.ts';
import type { ClaimsOp, Outbox, OutboxOp } from './outbox.ts';
import { ContractViolationError, newIdempotencyKey } from './request.ts';

export type SyncStatus = 'synced' | 'syncing' | 'offline';

export interface Balance {
  /** The server's wallet as of its last answer. */
  readonly wallet: Wallet;
  /** Coins reported but not yet settled, shown with a shimmer until the server confirms. */
  readonly provisionalCoins: number;
}

export type TableEvent =
  | {
      readonly type: 'dropSettled';
      readonly key: IdempotencyKey;
      readonly coin: MintedCoin;
      readonly spawnedCrates: readonly TableCrate[];
    }
  | {
      readonly type: 'dropRejected';
      readonly key: IdempotencyKey;
      /** The buffered coin already on screen that must now vanish, if there was one. */
      readonly coinId: CoinId | null;
      readonly error: unknown;
    }
  | { readonly type: 'claimSettled'; readonly claim: Claim; readonly result: ClaimResult }
  | { readonly type: 'claimsFailed'; readonly claims: readonly Claim[]; readonly error: unknown }
  | {
      readonly type: 'nudgeSettled';
      readonly decorum: Fraction;
      readonly frozenUntil: EpochMs | null;
    }
  | { readonly type: 'nudgeRejected'; readonly error: unknown }
  | { readonly type: 'balance'; readonly balance: Balance }
  | { readonly type: 'status'; readonly status: SyncStatus; readonly pending: number };

export interface DropTicket {
  readonly key: IdempotencyKey;
  /** A buffered coin to show immediately, or `null` when the server mints it (see `dropSettled`). */
  readonly coin: MintedCoin | null;
}

export interface TableSyncDeps {
  readonly client: ApiClient;
  readonly outbox: Outbox;
  readonly connectivity: Connectivity;
  readonly scheduler: Scheduler;
  /** Lets a cascade of falls ride in one claims batch instead of one request per coin. */
  readonly claimBatchMs?: number;
  readonly retry?: RetryPolicy;
  readonly jitter?: () => number;
  readonly onError?: (error: unknown) => void;
}

const DEFAULT_CLAIM_BATCH_MS = 120;
const OUTBOX_RETRY: RetryPolicy = { retries: Infinity, baseDelayMs: 1_000, maxDelayMs: 30_000 };

/**
 * The table's link to the server. Every drop, claim and nudge goes through one ordered,
 * persisted outbox so a claim can never overtake the drop that put its coin on the table, and
 * play continues offline on the pre-minted buffer. The client only ever reports what it saw;
 * balances come back from the server and replace whatever was shown.
 */
export class TableSync {
  readonly #deps: TableSyncDeps;
  readonly #buffer = new CoinBuffer();
  readonly #onTable = new Map<CoinId, MintedCoin>();
  readonly #listeners = new Set<(event: TableEvent) => void>();
  readonly #unsubscribeOnline: () => void;
  #wallet: Wallet | null = null;
  #status: SyncStatus = 'synced';
  #flushing: Promise<void> | null = null;
  #timer: unknown = null;
  #failures = 0;
  #closed = false;
  /** A pending resume: re-hydrate once the op queued last before it (if any) has been sent. */
  #resync: { readonly after: OutboxOp | undefined } | null = null;

  constructor(deps: TableSyncDeps) {
    this.#deps = deps;
    for (const op of deps.outbox.ops) {
      if (op.kind === 'drop' && op.coin !== null) {
        this.#buffer.markSpending(op.coin);
        this.#onTable.set(op.coin.id, op.coin);
      }
    }
    this.#unsubscribeOnline = deps.connectivity.onOnline(() => {
      this.#failures = 0;
      this.#cancelTimer();
      this.#kick(0);
    });
  }

  get status(): SyncStatus {
    return this.#status;
  }

  get pending(): number {
    return this.#deps.outbox.size;
  }

  get bufferSize(): number {
    return this.#buffer.size;
  }

  get balance(): Balance | null {
    return this.#wallet === null
      ? null
      : { wallet: this.#wallet, provisionalCoins: this.#deps.outbox.provisionalCoins() };
  }

  /** Coins the server minted that we believe are on the table (theirs, plus our unconfirmed drops). */
  coinOnTable(coinId: CoinId): MintedCoin | undefined {
    return this.#onTable.get(coinId);
  }

  subscribe(listener: (event: TableEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Adopts a server snapshot (boot, resume, or after a long offline spell), then drains the outbox. */
  hydrate(state: StateResponse): void {
    this.#adopt(state);
    this.#kick(0);
  }

  /**
   * Call when the tab comes back after being hidden. What was queued before is sent first and
   * judged by the server's old tick anchor; then a fresh snapshot lets it re-anchor the tick
   * clock, which stood still while the sim was paused. Resolves once both are done, or once the
   * server proves unreachable, in which case the snapshot follows when the queue drains.
   */
  resume(): Promise<void> {
    this.#resync = { after: this.#deps.outbox.ops.at(-1) };
    return this.flush();
  }

  #adopt(state: StateResponse): void {
    this.#wallet = state.wallet;
    this.#onTable.clear();
    for (const coin of state.table.coins) this.#onTable.set(coin.id, coin);
    for (const coin of this.#buffer.spending) this.#onTable.set(coin.id, coin);
    this.#buffer.replace(state.table.buffer);
    this.#emitBalance();
  }

  /**
   * Drops at `x`. A buffered coin appears at once; with a dry buffer the server mints one while
   * online, and offline there is nothing to drop (`null`) until the buffer is refilled.
   */
  drop(x: number, tick: Tick): DropTicket | null {
    const coin = this.#buffer.take();
    if (coin === null && this.#status === 'offline') return null;
    const key = newIdempotencyKey();
    if (coin !== null) this.#onTable.set(coin.id, coin);
    this.#enqueue({
      kind: 'drop',
      key,
      sent: false,
      body: coin === null ? { x, tick } : { x, tick, coinId: coin.id },
      coin,
    });
    return { key, coin };
  }

  claimFall(coinId: CoinId, tick: Tick, edge: FallEdge): void {
    const estimate = edge === 'front' ? (this.#onTable.get(coinId)?.value ?? 0) : 0;
    this.#claim({ kind: 'fall', coinId, tick, edge }, estimate);
  }

  claimFusion(coinIds: readonly [CoinId, CoinId, CoinId], tick: Tick): void {
    this.#claim({ kind: 'fusion', coinIds: [...coinIds], tick }, 0);
  }

  claimCrate(crateId: CrateId, tick: Tick, edge: FallEdge): void {
    this.#claim({ kind: 'crate', crateId, tick, edge }, 0);
  }

  /**
   * Nudges the table, or returns `false` offline: a nudge only matters while the table is live,
   * and one replayed after reconnecting would land on a table that has moved on.
   */
  nudge(tick: Tick, direction: NudgeDirection): boolean {
    if (this.#status === 'offline') return false;
    this.#enqueue({
      kind: 'nudge',
      key: newIdempotencyKey(),
      sent: false,
      body: { tick, direction },
    });
    return true;
  }

  /** Sends everything queued now; resolves once the outbox is empty or the server is unreachable. */
  flush(): Promise<void> {
    this.#cancelTimer();
    this.#flushing ??= this.#drain().finally(() => {
      this.#flushing = null;
    });
    return this.#flushing;
  }

  close(): void {
    this.#closed = true;
    this.#unsubscribeOnline();
    this.#cancelTimer();
  }

  #cancelTimer(): void {
    if (this.#timer !== null) this.#deps.scheduler.clearTimeout(this.#timer);
    this.#timer = null;
  }

  #claim(claim: Claim, estimate: number): void {
    if (!this.#deps.outbox.appendClaim(claim, estimate)) {
      void this.#deps.outbox.push({
        kind: 'claims',
        key: newIdempotencyKey(),
        sent: false,
        claims: [claim],
        estimates: [estimate],
      });
    }
    this.#emitBalance();
    this.#setStatus(this.#status === 'offline' ? 'offline' : 'syncing');
    this.#kick(this.#deps.claimBatchMs ?? DEFAULT_CLAIM_BATCH_MS);
  }

  #enqueue(op: OutboxOp): void {
    void this.#deps.outbox.push(op);
    this.#setStatus(this.#status === 'offline' ? 'offline' : 'syncing');
    this.#kick(0);
  }

  #kick(delayMs: number): void {
    if (this.#closed || this.#timer !== null) return;
    this.#timer = this.#deps.scheduler.setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, delayMs);
  }

  async #drain(): Promise<void> {
    const { outbox } = this.#deps;
    while (!this.#closed) {
      const resync = this.#resync;
      if (resync !== null && (resync.after === undefined || !outbox.ops.includes(resync.after))) {
        try {
          this.#adopt(await this.#deps.client.call('state', undefined, { retries: 0 }));
        } catch (error) {
          if (isRetryable(error)) {
            this.#retryLater(error);
            return;
          }
          this.#deps.onError?.(error);
        }
        this.#failures = 0;
        this.#resync = null;
        continue;
      }
      const op = outbox.head();
      if (op === undefined) break;
      if (!op.sent) await outbox.seal(op);
      try {
        await this.#send(op);
      } catch (error) {
        if (isRetryable(error)) {
          this.#retryLater(error);
          return;
        }
        await outbox.shift();
        this.#reject(op, error);
        continue;
      }
      this.#failures = 0;
      await outbox.shift();
      this.#emitBalance();
    }
    if (outbox.size === 0 && this.#resync === null) this.#setStatus('synced');
  }

  #retryLater(error: unknown): void {
    this.#failures++;
    this.#setStatus(error instanceof NetworkError ? 'offline' : 'syncing');
    this.#kick(
      backoffDelay(
        this.#failures - 1,
        this.#deps.retry ?? OUTBOX_RETRY,
        (this.#deps.jitter ?? Math.random)(),
        null,
      ),
    );
  }

  async #send(op: OutboxOp): Promise<void> {
    const { client } = this.#deps;
    const options = { idempotencyKey: op.key, retries: 0 };
    switch (op.kind) {
      case 'drop':
        this.#applyDrop(op, await client.call('tableDrop', { body: op.body }, options));
        return;
      case 'claims':
        this.#applyClaims(
          op,
          await client.call('tableClaims', { body: { claims: op.claims } }, options),
        );
        return;
      case 'nudge': {
        const result = await client.call('tableNudge', { body: op.body }, options);
        this.#emit({ type: 'nudgeSettled', ...result });
        return;
      }
    }
  }

  #applyDrop(op: Extract<OutboxOp, { kind: 'drop' }>, response: DropResponse): void {
    if (op.coin !== null) {
      this.#buffer.settle(op.coin.id);
      this.#onTable.delete(op.coin.id);
    }
    this.#onTable.set(response.coin.id, response.coin);
    this.#buffer.replace(response.buffer);
    this.#wallet = response.wallet;
    this.#emit({
      type: 'dropSettled',
      key: op.key,
      coin: response.coin,
      spawnedCrates: response.spawnedCrates,
    });
  }

  #applyClaims(op: ClaimsOp, response: { results: readonly ClaimResult[]; wallet: Wallet }): void {
    if (response.results.length !== op.claims.length) {
      throw new ContractViolationError(
        `tableClaims answered ${response.results.length} results for ${op.claims.length} claims.`,
      );
    }
    this.#wallet = response.wallet;
    op.claims.forEach((claim, i) => {
      const result = response.results[i];
      if (result === undefined) return;
      if (result.status === 'accepted') {
        if (claim.kind === 'fall') this.#onTable.delete(claim.coinId);
        if (claim.kind === 'fusion') for (const id of claim.coinIds) this.#onTable.delete(id);
        if (result.minted !== null) this.#onTable.set(result.minted.id, result.minted);
      }
      this.#emit({ type: 'claimSettled', claim, result });
    });
  }

  #reject(op: OutboxOp, error: unknown): void {
    if (error instanceof ContractViolationError) this.#deps.onError?.(error);
    switch (op.kind) {
      case 'drop':
        if (op.coin !== null) {
          this.#buffer.abandon(op.coin.id);
          this.#onTable.delete(op.coin.id);
        }
        this.#emit({ type: 'dropRejected', key: op.key, coinId: op.coin?.id ?? null, error });
        break;
      case 'claims':
        this.#emit({ type: 'claimsFailed', claims: op.claims, error });
        break;
      case 'nudge':
        this.#emit({ type: 'nudgeRejected', error });
        break;
    }
    this.#emitBalance();
  }

  #setStatus(status: SyncStatus): void {
    if (status === this.#status) return;
    this.#status = status;
    this.#emit({ type: 'status', status, pending: this.#deps.outbox.size });
  }

  #emitBalance(): void {
    const balance = this.balance;
    if (balance !== null) this.#emit({ type: 'balance', balance });
  }

  #emit(event: TableEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        this.#deps.onError?.(error);
      }
    }
  }
}
