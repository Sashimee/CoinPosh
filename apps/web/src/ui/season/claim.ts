import type { IdempotencyKey, QuestClaimResponse, QuestId } from '@coinposh/shared';
import { ApiRequestError } from '../../net/errors.ts';
import type { SeasonData } from './model.ts';

export type ClaimStatus = 'idle' | 'pending' | 'claimed' | 'already' | 'failed';

export type ClaimOutcome =
  | { readonly kind: 'claimed'; readonly response: QuestClaimResponse }
  | { readonly kind: 'already' }
  | { readonly kind: 'failed'; readonly error: unknown }
  /** A second tap while the first claim is still in flight. */
  | { readonly kind: 'ignored' };

/** The server refuses a quest it already paid with `conflict`; nothing is lost, just shown. */
export function isAlreadyClaimed(error: unknown): boolean {
  return error instanceof ApiRequestError && error.code === 'conflict';
}

/**
 * Per-quest claim state. A failed claim keeps its idempotency key, so "Try again" resends the
 * same request and a claim that did land the first time is answered, not paid twice.
 */
export class QuestClaims {
  readonly #statuses = new Map<QuestId, ClaimStatus>();
  readonly #keys = new Map<QuestId, IdempotencyKey>();

  constructor(
    private readonly send: SeasonData['claim'],
    private readonly newKey: () => IdempotencyKey,
  ) {}

  status(questId: QuestId): ClaimStatus {
    return this.#statuses.get(questId) ?? 'idle';
  }

  /** Whether any claim is waiting on the server, so a reload does not paint over it. */
  get busy(): boolean {
    return [...this.#statuses.values()].includes('pending');
  }

  async claim(questId: QuestId): Promise<ClaimOutcome> {
    if (this.status(questId) === 'pending') return { kind: 'ignored' };
    let key = this.#keys.get(questId);
    if (key === undefined) {
      key = this.newKey();
      this.#keys.set(questId, key);
    }
    this.#statuses.set(questId, 'pending');
    try {
      const response = await this.send(questId, key);
      if (response.quest.id !== questId || !response.quest.claimed) {
        throw new Error(
          `questsClaim for ${questId} answered with quest ${response.quest.id} (claimed: ${String(response.quest.claimed)}); the server must return the claimed quest`,
        );
      }
      this.#settle(questId, 'claimed');
      return { kind: 'claimed', response };
    } catch (error) {
      if (isAlreadyClaimed(error)) {
        this.#settle(questId, 'already');
        return { kind: 'already' };
      }
      this.#statuses.set(questId, 'failed');
      return { kind: 'failed', error };
    }
  }

  /** Forgets settled outcomes once a fresh load shows the server's word on them. */
  forgetSettled(): void {
    for (const [id, status] of this.#statuses) {
      if (status === 'claimed' || status === 'already') this.#statuses.delete(id);
    }
  }

  #settle(questId: QuestId, status: 'claimed' | 'already'): void {
    this.#statuses.set(questId, status);
    this.#keys.delete(questId);
  }
}

/**
 * Claim settlements waiting out the hit-stop. Closing the panel flushes them, so a claim the
 * server paid is never left painted as pending or missing from the live status line.
 */
export class HeldSettlements {
  readonly #held = new Map<string, () => void>();

  hold(id: string, settle: () => void): void {
    this.#held.set(id, settle);
  }

  /** Settles `id` if it is still held; false when a flush already did. */
  run(id: string): boolean {
    const settle = this.#held.get(id);
    if (settle === undefined) return false;
    this.#held.delete(id);
    settle();
    return true;
  }

  flush(): void {
    for (const id of [...this.#held.keys()]) this.run(id);
  }

  clear(): void {
    this.#held.clear();
  }
}
