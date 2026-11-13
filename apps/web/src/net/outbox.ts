import {
  AmountSchema,
  ClaimSchema,
  DropRequestSchema,
  IdempotencyKeySchema,
  MAX_CLAIMS_PER_BATCH,
  MintedCoinSchema,
  NudgeRequestSchema,
  TableSessionIdSchema,
  TableSnapshotRequestSchema,
  type Claim,
  type TableSessionId,
} from '@coinposh/shared';
import { z } from 'zod';
import type { KeyValueStore } from './store.ts';

/**
 * One mutating request waiting for the server, in the order it happened. Each op owns its
 * Idempotency-Key from the moment it is queued, so a resend after a crash, a reload or a
 * lost response is replayed by the server instead of being applied twice. `sent` seals an
 * op: once it may have reached the server its body can never change under the same key.
 */
const OutboxOpSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('drop'),
    key: IdempotencyKeySchema,
    sent: z.boolean(),
    body: DropRequestSchema,
    /** The buffered coin this drop spends, or `null` when the server mints a fresh one. */
    coin: MintedCoinSchema.nullable(),
  }),
  z.object({
    kind: z.literal('claims'),
    key: IdempotencyKeySchema,
    sent: z.boolean(),
    session: TableSessionIdSchema.optional(),
    claims: z.array(ClaimSchema).min(1).max(MAX_CLAIMS_PER_BATCH),
    /** Display-only provisional value per claim; the server credits what it stored. */
    estimates: z.array(AmountSchema),
  }),
  z.object({
    kind: z.literal('nudge'),
    key: IdempotencyKeySchema,
    sent: z.boolean(),
    body: NudgeRequestSchema,
  }),
  /** Where the sim says the table rests. Positions only; the newest unsent one replaces the last. */
  z.object({
    kind: z.literal('snapshot'),
    key: IdempotencyKeySchema,
    sent: z.boolean(),
    body: TableSnapshotRequestSchema,
  }),
]);
export type OutboxOp = z.infer<typeof OutboxOpSchema>;
export type ClaimsOp = Extract<OutboxOp, { kind: 'claims' }>;
export type SnapshotOp = Extract<OutboxOp, { kind: 'snapshot' }>;

/** Ops queued before table sessions existed, or before the first state named one. */
const LEGACY_KEY = 'outbox';
const PARTITION_PREFIX = 'outbox:';

export function outboxKey(session: TableSessionId | undefined): string {
  return session === undefined ? LEGACY_KEY : `${PARTITION_PREFIX}${session}`;
}

export function opSession(op: OutboxOp): TableSessionId | undefined {
  return op.kind === 'claims' ? op.session : op.body.session;
}

/**
 * Which table sessions a live page is playing. Each page keeps its session's ops under its own
 * key, so two tabs never overwrite each other's queue, and a page opening while another is
 * still playing leaves that page's queue to it instead of sending it twice.
 */
export interface PartitionLocks {
  /** Holds `session` for as long as this page lives. */
  hold(session: TableSessionId): void;
  /** Sessions another live page holds. */
  held(): Promise<ReadonlySet<string>>;
}

export const noPartitionLocks: PartitionLocks = {
  hold: () => undefined,
  held: () => Promise.resolve(new Set()),
};

const LOCK_PREFIX = 'coinposh-outbox:';

/** Web Locks, released by the browser when the page that holds one goes away. */
export function webPartitionLocks(locks: LockManager): PartitionLocks {
  const holding = new Set<string>();
  return {
    hold(session) {
      if (holding.has(session)) return;
      holding.add(session);
      void locks.request(`${LOCK_PREFIX}${session}`, () => new Promise<never>(() => undefined));
    },
    async held() {
      const snapshot = await locks.query();
      return new Set(
        (snapshot.held ?? []).flatMap((lock) =>
          lock.name?.startsWith(LOCK_PREFIX) === true ? [lock.name.slice(LOCK_PREFIX.length)] : [],
        ),
      );
    },
  };
}

export class Outbox {
  readonly #store: KeyValueStore;
  readonly #onError: (error: Error) => void;
  #ops: OutboxOp[] = [];
  /** Store keys this page wrote or adopted, so one emptied is deleted rather than left stale. */
  readonly #keys = new Set<string>();
  #writing: Promise<void> = Promise.resolve();

  private constructor(store: KeyValueStore, onError: (error: Error) => void) {
    this.#store = store;
    this.#onError = onError;
  }

  /**
   * Restores what earlier pages left unsent: the legacy queue and every session's queue that no
   * live page holds. A corrupt or tampered entry is reported and dropped rather than replayed:
   * the server would refuse it anyway, and it must not wedge the queue.
   */
  static async open(
    store: KeyValueStore,
    onError: (error: Error) => void,
    locks: PartitionLocks = noPartitionLocks,
  ): Promise<Outbox> {
    const outbox = new Outbox(store, onError);
    const held = await locks.held();
    const keys = (await store.keys())
      .filter((key) => key.startsWith(PARTITION_PREFIX))
      .filter((key) => !held.has(key.slice(PARTITION_PREFIX.length)))
      .sort();
    for (const key of [LEGACY_KEY, ...keys]) {
      const raw = await store.get(key);
      if (raw === undefined) continue;
      const parsed = z.array(OutboxOpSchema).safeParse(raw);
      const misfiled = parsed.success && parsed.data.find((op) => outboxKey(opSession(op)) !== key);
      if (parsed.success && misfiled === undefined) {
        outbox.#ops.push(...parsed.data);
        outbox.#keys.add(key);
        continue;
      }
      onError(
        new Error(
          `CoinPosh net: discarded an unreadable offline queue (${parsed.success ? `${key} holds an op of another table session` : parsed.error.message}).`,
        ),
      );
      await store.delete(key);
    }
    return outbox;
  }

  get ops(): readonly OutboxOp[] {
    return this.#ops;
  }

  get size(): number {
    return this.#ops.length;
  }

  head(): OutboxOp | undefined {
    return this.#ops[0];
  }

  push(op: OutboxOp): Promise<void> {
    this.#ops.push(op);
    return this.#persist();
  }

  /**
   * Queues `op` as the table's newest snapshot, after every drop and claim already queued. An
   * unsent snapshot is only ever superseded by a newer one, so it is replaced rather than sent.
   */
  pushSnapshot(op: SnapshotOp): Promise<void> {
    this.#ops = this.#ops.filter((queued) => queued.kind !== 'snapshot' || queued.sent);
    this.#ops.push(op);
    return this.#persist();
  }

  /** The unsent snapshot waiting in the queue, if any. */
  pendingSnapshot(): SnapshotOp | undefined {
    return this.#ops.find((op): op is SnapshotOp => op.kind === 'snapshot' && !op.sent);
  }

  /** Adds to the newest unsent claims batch of `session`, or reports that a new batch is needed. */
  appendClaim(claim: Claim, estimate: number, session?: TableSessionId): boolean {
    const tail = this.#ops.at(-1);
    if (
      tail?.kind !== 'claims' ||
      tail.sent ||
      tail.session !== session ||
      tail.claims.length >= MAX_CLAIMS_PER_BATCH
    ) {
      return false;
    }
    tail.claims.push(claim);
    tail.estimates.push(estimate);
    void this.#persist();
    return true;
  }

  seal(op: OutboxOp): Promise<void> {
    op.sent = true;
    return this.#persist();
  }

  shift(): Promise<void> {
    this.#ops.shift();
    return this.#persist();
  }

  /** Removes `op` wherever it sits; a no-op if it already left. */
  remove(op: OutboxOp): Promise<void> {
    const at = this.#ops.indexOf(op);
    if (at === -1) return this.#writing;
    this.#ops.splice(at, 1);
    return this.#persist();
  }

  /** Removes the snapshots not yet sent; those of a superseded session can never be stored. */
  discardUnsentSnapshots(): Promise<void> {
    this.#ops = this.#ops.filter((op) => op.kind !== 'snapshot' || op.sent);
    return this.#persist();
  }

  provisionalCoins(): number {
    let total = 0;
    for (const op of this.#ops) {
      if (op.kind === 'claims') for (const estimate of op.estimates) total += estimate;
    }
    return total;
  }

  #persist(): Promise<void> {
    const partitions = new Map<string, OutboxOp[]>();
    for (const op of this.#ops) {
      const key = outboxKey(opSession(op));
      const partition = partitions.get(key) ?? [];
      partition.push(op);
      partitions.set(key, partition);
    }
    const writes = structuredClone([...partitions]);
    const emptied = [...this.#keys].filter((key) => !partitions.has(key));
    for (const key of emptied) this.#keys.delete(key);
    for (const key of partitions.keys()) this.#keys.add(key);
    this.#writing = this.#writing
      .then(async () => {
        for (const [key, ops] of writes) await this.#store.set(key, ops);
        for (const key of emptied) await this.#store.delete(key);
      })
      .catch((error: unknown) => {
        this.#onError(
          new Error(
            'CoinPosh net: could not save the offline queue; unsent play may be lost on reload.',
            {
              cause: error,
            },
          ),
        );
      });
    return this.#writing;
  }
}
