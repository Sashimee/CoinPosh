import {
  MAX_CLAIMS_PER_BATCH,
  type Claim,
  type CoinId,
  type TableSessionId,
} from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import {
  Outbox,
  outboxKey,
  type OutboxOp,
  type PartitionLocks,
  type SnapshotOp,
} from './outbox.ts';
import { newIdempotencyKey } from './request.ts';
import { memoryStore, type KeyValueStore } from './store.ts';

const fall = (tick: number): Claim => ({
  kind: 'fall',
  coinId: 'coin_AAAAAAAAAAAAAAAA' as CoinId,
  tick,
  edge: 'front',
});

function claimsOp(sent = false, session?: TableSessionId): OutboxOp {
  return {
    kind: 'claims',
    key: newIdempotencyKey(),
    sent,
    ...(session === undefined ? {} : { session }),
    claims: [fall(1)],
    estimates: [1],
  };
}

const A = 'session_AAAAAAAA' as TableSessionId;
const B = 'session_BBBBBBBB' as TableSessionId;

function snapshotOp(seq: number, session: TableSessionId = A): SnapshotOp {
  return {
    kind: 'snapshot',
    key: newIdempotencyKey(),
    sent: false,
    body: { session, seq, tick: seq * 10, pusher: { tickInCycle: 0 }, coins: [], crates: [] },
  };
}

function dropOp(session?: TableSessionId): OutboxOp {
  return {
    kind: 'drop',
    key: newIdempotencyKey(),
    sent: false,
    body: { ...(session === undefined ? {} : { session }), x: 0, tick: 1 },
    coin: null,
  };
}

function heldLocks(...sessions: string[]): PartitionLocks {
  return { hold: () => undefined, held: () => Promise.resolve(new Set(sessions)) };
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
      keys: () => inner.keys(),
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

  it('coalesces unsent snapshots behind the drops and claims already queued', async () => {
    const outbox = await Outbox.open(memoryStore(), noErrors);
    await outbox.pushSnapshot(snapshotOp(1));
    await outbox.push(dropOp(A));
    await outbox.push(claimsOp());
    const latest = snapshotOp(2);
    await outbox.pushSnapshot(latest);
    expect(outbox.ops.map((op) => op.kind)).toEqual(['drop', 'claims', 'snapshot']);
    expect(outbox.pendingSnapshot()).toBe(latest);
  });

  it('never replaces a snapshot that may already have reached the server', async () => {
    const outbox = await Outbox.open(memoryStore(), noErrors);
    const inFlight = snapshotOp(1);
    await outbox.pushSnapshot(inFlight);
    await outbox.seal(inFlight);
    await outbox.pushSnapshot(snapshotOp(2));
    expect(outbox.ops.map((op) => op.kind === 'snapshot' && op.body.seq)).toEqual([1, 2]);
    await outbox.discardUnsentSnapshots();
    expect(outbox.ops).toEqual([inFlight]);
  });

  it('removes an op by identity, wherever it sits', async () => {
    const outbox = await Outbox.open(memoryStore(), noErrors);
    const first = dropOp(A);
    const second = dropOp(A);
    await outbox.push(first);
    await outbox.push(second);
    await outbox.remove(second);
    await outbox.remove(second);
    expect(outbox.ops).toEqual([first]);
  });

  it('keeps each table session under its own key and deletes a key once emptied', async () => {
    const store = memoryStore();
    const outbox = await Outbox.open(store, noErrors);
    const legacy = dropOp();
    const ofA = dropOp(A);
    await outbox.push(legacy);
    await outbox.push(ofA);
    await outbox.push(claimsOp(false, B));
    expect((await store.keys()).sort()).toEqual(['outbox', outboxKey(A), outboxKey(B)]);
    expect(await store.get(outboxKey(A))).toEqual([ofA]);
    await outbox.remove(ofA);
    expect(await store.get(outboxKey(A))).toBeUndefined();
    expect(await store.get('outbox')).toEqual([legacy]);
  });

  it('leaves the queue of a session another live page holds to that page', async () => {
    const store = memoryStore();
    const writer = await Outbox.open(store, noErrors);
    await writer.push(dropOp(A));
    await writer.push(dropOp(B));
    const reopened = await Outbox.open(store, noErrors, heldLocks(A));
    expect(reopened.ops.map((op) => op.kind === 'drop' && op.body.session)).toEqual([B]);
    await reopened.shift();
    expect(await store.get(outboxKey(A))).toHaveLength(1);
    expect(await store.get(outboxKey(B))).toBeUndefined();
  });

  it('discards a partition holding an op of another session instead of sending it', async () => {
    const store = memoryStore();
    await store.set(outboxKey(A), [dropOp(B)]);
    const errors: Error[] = [];
    const outbox = await Outbox.open(store, (error) => errors.push(error));
    expect(outbox.size).toBe(0);
    expect(errors[0]?.message).toMatch(/holds an op of another table session/);
    expect(await store.get(outboxKey(A))).toBeUndefined();
  });

  it('refuses a persisted snapshot carrying a value field', async () => {
    const store = memoryStore();
    const forged = snapshotOp(1);
    await store.set(outboxKey(A), [{ ...forged, body: { ...forged.body, wallet: 1e9 } }]);
    const errors: Error[] = [];
    const outbox = await Outbox.open(store, (error) => errors.push(error));
    expect(outbox.size).toBe(0);
    expect(errors).toHaveLength(1);
  });

  it('batches a claim only with the tail of the same session', async () => {
    const outbox = await Outbox.open(memoryStore(), noErrors);
    await outbox.push(claimsOp(false, A));
    expect(outbox.appendClaim(fall(2), 1, B)).toBe(false);
    expect(outbox.appendClaim(fall(2), 1)).toBe(false);
    expect(outbox.appendClaim(fall(2), 1, A)).toBe(true);
  });
});
