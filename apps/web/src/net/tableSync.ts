import {
  TableSnapshotRequestSchema,
  type Claim,
  type ClaimResult,
  type CoinId,
  type CrateId,
  type CratePoseTuple,
  type DropResponse,
  type EpochMs,
  type FallEdge,
  type Fraction,
  type IdempotencyKey,
  type MintedCoin,
  type NudgeDirection,
  type PoseTuple,
  type StateResponse,
  type TableCrate,
  type TableSessionId,
  type Tick,
  type Wallet,
} from '@coinposh/shared';
import { backoffDelay, type ApiClient, type RetryPolicy } from './client.ts';
import { CoinBuffer } from './coinBuffer.ts';
import type { Connectivity, Scheduler } from './connectivity.ts';
import { ApiRequestError, NetworkError, isRetryable } from './errors.ts';
import {
  noPartitionLocks,
  opSession,
  type ClaimsOp,
  type Outbox,
  type OutboxOp,
  type PartitionLocks,
  type SnapshotOp,
} from './outbox.ts';
import { ContractViolationError, newIdempotencyKey } from './request.ts';
import type { WireRequest } from './wire.ts';

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
  | {
      readonly type: 'snapshotSettled';
      readonly seq: number;
      readonly stored: number;
      readonly ignored: number;
    }
  /** The server is rate limiting snapshots: send the next one no sooner than this. */
  | { readonly type: 'snapshotDeferred'; readonly retryAfterMs: number }
  | { readonly type: 'snapshotRejected'; readonly error: unknown }
  /**
   * Another tab or device booted this table. Stop input and offer a reload: drops, nudges and
   * snapshots are refused from now on, and only claims for what already fell are still sent.
   */
  | { readonly type: 'sessionSuperseded'; readonly session: TableSessionId }
  | { readonly type: 'balance'; readonly balance: Balance }
  | { readonly type: 'status'; readonly status: SyncStatus; readonly pending: number };

/** Where the sim says the table rests now, in the wire's units and the server's ids. */
export interface SnapshotCapture {
  readonly tick: Tick;
  readonly pusher: { readonly tickInCycle: number };
  readonly coins: readonly PoseTuple[];
  readonly crates: readonly CratePoseTuple[];
}

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
  /**
   * Why nudges stay on this device instead of reaching the server, or `null` (the default) to
   * send them. The live server has no nudge endpoint yet, so live mode passes a reason.
   */
  readonly localNudges?: string | null;
  /** Marks this page's table session as live, so another page leaves its queue alone. */
  readonly locks?: PartitionLocks;
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
  #nudgeSkipLogged = false;
  /** A pending resume: re-hydrate once the op queued last before it (if any) has been sent. */
  #resync: { readonly after: OutboxOp | undefined } | null = null;
  #session: TableSessionId | null = null;
  #superseded = false;
  #snapshotSeq = 0;
  /** The newest queued snapshot signed ahead of time, for `pagehide`; kept while it is in flight. */
  #keepalive: { readonly op: SnapshotOp; readonly request: WireRequest } | null = null;
  /** The snapshot whose upload is on the wire now, itself a keepalive request. */
  #onWire: SnapshotOp | null = null;
  readonly #unsubscribeTokens: () => void;

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
    this.#unsubscribeTokens = deps.client.onTokenRefresh(() => {
      const latest = this.#latestSnapshot();
      if (latest !== undefined) this.#presign(latest);
    });
  }

  get status(): SyncStatus {
    return this.#status;
  }

  get pending(): number {
    return this.#deps.outbox.size;
  }

  /** The table session this page plays, once a state named one. */
  get session(): TableSessionId | null {
    return this.#session;
  }

  /** True once another tab or device booted the table; see `sessionSuperseded`. */
  get superseded(): boolean {
    return this.#superseded;
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

  /**
   * Sends everything queued, by this page or an earlier one, before a `hydrate=boot` call: the
   * boot refunds every coin it cannot lay again, so drops, claims and the last snapshot must be
   * on the server first. Rejects while anything is still queued, so the boot is retried.
   */
  async drainBeforeBoot(): Promise<void> {
    await this.flush();
    if (this.#deps.outbox.size > 0) {
      throw new NetworkError(
        `CoinPosh net: ${this.#deps.outbox.size} queued table ops have not reached the server yet; booting now would refund their coins. Retry the boot once online.`,
      );
    }
  }

  #adopt(state: StateResponse): void {
    this.#adoptSession(state);
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
    if (this.#superseded) return null;
    const coin = this.#buffer.take();
    if (coin === null && this.#status === 'offline') return null;
    const key = newIdempotencyKey();
    if (coin !== null) this.#onTable.set(coin.id, coin);
    this.#enqueue({
      kind: 'drop',
      key,
      sent: false,
      body: { ...this.#sessionField(), x, tick, ...(coin === null ? {} : { coinId: coin.id }) },
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
    if (this.#status === 'offline' || this.#superseded) return false;
    const localReason = this.#deps.localNudges ?? null;
    if (localReason !== null) {
      if (!this.#nudgeSkipLogged) console.info(`CoinPosh net: nudges are not sent. ${localReason}`);
      this.#nudgeSkipLogged = true;
      return true;
    }
    this.#enqueue({
      kind: 'nudge',
      key: newIdempotencyKey(),
      sent: false,
      body: { ...this.#sessionField(), tick, direction },
    });
    return true;
  }

  /**
   * Queues where the sim says the table rests, replacing a snapshot not sent yet, behind every
   * drop and claim already queued. Returns `false` when there is no session to name, the table
   * is open elsewhere, or the capture does not fit the contract (reported to `onError`).
   */
  snapshot(capture: SnapshotCapture): boolean {
    const session = this.#session;
    if (session === null || this.#superseded || this.#closed) return false;
    const parsed = TableSnapshotRequestSchema.safeParse({
      session,
      seq: this.#snapshotSeq + 1,
      tick: capture.tick,
      pusher: { tickInCycle: capture.pusher.tickInCycle },
      coins: capture.coins,
      crates: capture.crates,
    });
    if (!parsed.success) {
      this.#deps.onError?.(
        new ContractViolationError(
          `CoinPosh net: refusing to queue a table snapshot outside its contract: ${parsed.error.message}`,
          { cause: parsed.error },
        ),
      );
      return false;
    }
    this.#snapshotSeq = parsed.data.seq;
    const op: SnapshotOp = {
      kind: 'snapshot',
      key: newIdempotencyKey(),
      sent: false,
      body: parsed.data,
    };
    void this.#deps.outbox.pushSnapshot(op);
    this.#presign(op);
    this.#setStatus(this.#status === 'offline' ? 'offline' : 'syncing');
    this.#kick(0);
    return true;
  }

  /**
   * The page is going away: send the queued snapshot with the request signed ahead of time,
   * since nothing can be signed or awaited now. It goes only when nothing is queued before it,
   * so it never overtakes a drop or claim. A drain may already have sealed it and still be
   * signing its own upload, or be waiting to retry one that failed, so a sealed snapshot goes
   * too unless its upload is on the wire, which is a keepalive request already. A copy that
   * lands twice shares its key, so the server replays.
   *
   * Anything else queued, such as the drops made since the last settled snapshot, is drained
   * now instead of after a timer or a retry delay that will never fire: every upload is a
   * keepalive request, so each one the closing page gets onto the wire still arrives, in order.
   */
  pagehide(): void {
    const keepalive = this.#keepalive;
    const { outbox } = this.#deps;
    if (keepalive !== null && outbox.head() === keepalive.op && this.#onWire !== keepalive.op) {
      this.#keepalive = null;
      if (!keepalive.op.sent) void outbox.seal(keepalive.op);
      this.#deps.client.sendKeepalive(keepalive.request);
      return;
    }
    if (outbox.size > 0) void this.flush();
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
    this.#unsubscribeTokens();
    this.#cancelTimer();
  }

  #cancelTimer(): void {
    if (this.#timer !== null) this.#deps.scheduler.clearTimeout(this.#timer);
    this.#timer = null;
  }

  #claim(claim: Claim, estimate: number): void {
    const session = this.#session ?? undefined;
    if (!this.#deps.outbox.appendClaim(claim, estimate, session)) {
      void this.#deps.outbox.push({
        kind: 'claims',
        key: newIdempotencyKey(),
        sent: false,
        ...(session === undefined ? {} : { session }),
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
        if (op.kind === 'snapshot' && this.#snapshotRefused(op, error)) {
          await outbox.remove(op);
          continue;
        }
        if (isRetryable(error)) {
          this.#retryLater(error);
          return;
        }
        await outbox.remove(op);
        this.#reject(op, error);
        continue;
      }
      this.#failures = 0;
      await outbox.remove(op);
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
    const options = { idempotencyKey: op.key, retries: 0, keepalive: true };
    switch (op.kind) {
      case 'drop':
        this.#applyDrop(op, await client.call('tableDrop', { body: op.body }, options));
        return;
      case 'claims':
        this.#applyClaims(
          op,
          await client.call(
            'tableClaims',
            {
              body: {
                ...(op.session === undefined ? {} : { session: op.session }),
                claims: op.claims,
              },
            },
            options,
          ),
        );
        return;
      case 'nudge': {
        const result = await client.call('tableNudge', { body: op.body }, options);
        this.#emit({ type: 'nudgeSettled', ...result });
        return;
      }
      case 'snapshot': {
        try {
          const result = await client.snapshot(op.body, {
            ...options,
            onWire: () => {
              this.#onWire = op;
            },
          });
          if (this.#keepalive?.op === op) this.#keepalive = null;
          this.#emit({ type: 'snapshotSettled', ...result });
        } finally {
          if (this.#onWire === op) this.#onWire = null;
        }
        return;
      }
    }
  }

  /**
   * The answers that end a snapshot without blocking the queue: a newer one is already stored
   * (stale), the server wants fewer (rate limited: the next capture goes later), or another page
   * owns the table now. Each one only ever loses a pose, never value.
   */
  #snapshotRefused(op: SnapshotOp, error: unknown): boolean {
    if (!(error instanceof ApiRequestError)) return false;
    switch (error.code) {
      case 'stale_snapshot':
        return true;
      case 'rate_limited':
        this.#emit({ type: 'snapshotDeferred', retryAfterMs: error.retryAfterMs ?? 0 });
        return true;
      case 'session_superseded':
        if (op.body.session === this.#session) this.#supersede();
        return true;
      default:
        return false;
    }
  }

  #adoptSession(state: StateResponse): void {
    const session = state.table.session;
    if (session === undefined) return;
    const boot = state.table.layout !== null && state.table.layout !== undefined;
    if (this.#session === null || boot) {
      if (session !== this.#session) {
        this.#snapshotSeq = 0;
        void this.#deps.outbox.discardUnsentSnapshots();
      }
      this.#session = session;
      this.#superseded = false;
      (this.#deps.locks ?? noPartitionLocks).hold(session);
      return;
    }
    if (session !== this.#session) this.#supersede();
  }

  #supersede(): void {
    const session = this.#session;
    if (this.#superseded || session === null) return;
    this.#superseded = true;
    this.#keepalive = null;
    void this.#deps.outbox.discardUnsentSnapshots();
    this.#emit({ type: 'sessionSuperseded', session });
  }

  #sessionField(): { session?: TableSessionId } {
    return this.#session === null ? {} : { session: this.#session };
  }

  /** The newest snapshot still in the queue, sent or not: the one `pagehide` may need to send. */
  #latestSnapshot(): SnapshotOp | undefined {
    const { ops } = this.#deps.outbox;
    for (let i = ops.length - 1; i >= 0; i--) {
      const op = ops[i];
      if (op?.kind === 'snapshot') return op;
    }
    return undefined;
  }

  #presign(op: SnapshotOp): void {
    this.#deps.client.presignSnapshot(op.body, op.key).then(
      (request) => {
        if (this.#latestSnapshot() === op && !this.#superseded) {
          this.#keepalive = { op, request };
        }
      },
      (error: unknown) => {
        if (!(error instanceof NetworkError)) this.#deps.onError?.(error);
      },
    );
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
    if (
      error instanceof ApiRequestError &&
      error.code === 'session_superseded' &&
      opSession(op) === this.#session
    ) {
      this.#supersede();
    }
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
      case 'snapshot':
        this.#deps.onError?.(error);
        this.#emit({ type: 'snapshotRejected', error });
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
