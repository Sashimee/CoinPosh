import { MAX_CLAIMS_PER_BATCH, type Claim, type CoinId } from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import { Outbox, type OutboxOp } from './outbox.ts';
import { newIdempotencyKey } from './request.ts';
import { memoryStore, type KeyValueStore } from './store.ts';

const fall = (tick: number): Claim => ({
  kind: 'fall',
  coinId: 'coin_AAAAAAAAAAAAAAAA' as CoinId,
  tick,
  edge: 'front',
});

function claimsOp(sent = false): OutboxOp {
  return { kind: 'claims', key: newIdempotencyKey(), sent, claims: [fall(1)], estimates: [1] };
}

function noErrors(error: Error): never {
  throw error;
}

describe('Outbox', () => {
  it('persists every op with its idempotency key and restores it after a reload', async () => {
    const store = memoryStore();
    const outbox = await Outbox.open(store, noErrors);
    const drop: OutboxOp = {
      kind: 'drop',
      key: newIdempotencyKey(),
      sent: false,
      body: { x: 0, tick: 1 },
      coin: null,
    };
    await outbox.push(drop);
    await outbox.push(claimsOp());
    await outbox.seal(drop);
    const reopened = await Outbox.open(store, noErrors);
    expect(reopened.ops).toEqual(outbox.ops);
    expect(reopened.head()).toMatchObject({ kind: 'drop', key: drop.key, sent: true });
  });

  it('batches claims into the unsent tail only', async () => {
    const outbox = await Outbox.open(memoryStore(), noErrors);
    expect(outbox.appendClaim(fall(2), 1)).toBe(false);
    await outbox.push(claimsOp());
    expect(outbox.appendClaim(fall(2), 3)).toBe(true);
    expect(outbox.provisionalCoins()).toBe(4);
    const head = outbox.head();
    if (head === undefined) throw new Error('Expected an op.');
    await outbox.seal(head);
    expect(outbox.appendClaim(fall(3), 1)).toBe(false);
  });

  it('starts a new batch once one is full', async () => {
    const outbox = await Outbox.open(memoryStore(), noErrors);
    await outbox.push(claimsOp());
    for (let i = 1; i < MAX_CLAIMS_PER_BATCH; i++)
      expect(outbox.appendClaim(fall(i), 0)).toBe(true);
    expect(outbox.appendClaim(fall(999), 0)).toBe(false);
  });

  it('discards a corrupt or tampered queue loudly instead of replaying it', async () => {
    const store = memoryStore();
    await store.set('outbox', [
      { kind: 'claims', key: 'not-a-uuid', sent: false, claims: [], estimates: [] },
    ]);
    const errors: Error[] = [];
    const outbox = await Outbox.open(store, (error) => errors.push(error));
    expect(outbox.size).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/discarded an unreadable offline queue/);
    expect(await store.get('outbox')).toBeUndefined();
  });

  it('reports a failed save without wedging later writes', async () => {
    const inner = memoryStore();
    let failNext = true;
    const flaky: KeyValueStore = {
      get: (key) => inner.get(key),
      delete: (key) => inner.delete(key),
      set: (key, value) => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error('quota exceeded'));
        }
        return inner.set(key, value);
      },
    };
    const errors: Error[] = [];
    const outbox = await Outbox.open(flaky, (error) => errors.push(error));
    await outbox.push(claimsOp());
    await outbox.push(claimsOp(true));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/could not save the offline queue/);
    expect(await inner.get('outbox')).toHaveLength(2);
  });
});
