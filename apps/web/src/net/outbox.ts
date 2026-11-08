import {
  AmountSchema,
  ClaimSchema,
  DropRequestSchema,
  IdempotencyKeySchema,
  MAX_CLAIMS_PER_BATCH,
  MintedCoinSchema,
  NudgeRequestSchema,
  type Claim,
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
]);
export type OutboxOp = z.infer<typeof OutboxOpSchema>;
export type ClaimsOp = Extract<OutboxOp, { kind: 'claims' }>;

const STORE_KEY = 'outbox';

export class Outbox {
  readonly #store: KeyValueStore;
  readonly #onError: (error: Error) => void;
  #ops: OutboxOp[] = [];
  #writing: Promise<void> = Promise.resolve();

  private constructor(store: KeyValueStore, onError: (error: Error) => void) {
    this.#store = store;
    this.#onError = onError;
  }

  /**
   * Restores what an earlier session left unsent. A corrupt or tampered entry is reported and
   * dropped rather than replayed: the server would refuse it anyway, and it must not wedge the queue.
   */
  static async open(store: KeyValueStore, onError: (error: Error) => void): Promise<Outbox> {
    const outbox = new Outbox(store, onError);
    const raw = await store.get(STORE_KEY);
    if (raw === undefined) return outbox;
    const parsed = z.array(OutboxOpSchema).safeParse(raw);
    if (parsed.success) {
      outbox.#ops = parsed.data;
    } else {
      onError(
        new Error(`CoinPosh net: discarded an unreadable offline queue (${parsed.error.message}).`),
      );
      await store.delete(STORE_KEY);
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

  /** Adds to the newest unsent claims batch, or reports that a new batch is needed. */
  appendClaim(claim: Claim, estimate: number): boolean {
    const tail = this.#ops.at(-1);
    if (tail?.kind !== 'claims' || tail.sent || tail.claims.length >= MAX_CLAIMS_PER_BATCH) {
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

  provisionalCoins(): number {
    let total = 0;
    for (const op of this.#ops) {
      if (op.kind === 'claims') for (const estimate of op.estimates) total += estimate;
    }
    return total;
  }

  #persist(): Promise<void> {
    const snapshot = structuredClone(this.#ops);
    this.#writing = this.#writing
      .then(() => this.#store.set(STORE_KEY, snapshot))
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
