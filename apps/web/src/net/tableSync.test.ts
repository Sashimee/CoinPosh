import { HEADERS, type CoinId, type MintedCoin } from '@coinposh/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Connectivity, Scheduler } from './connectivity.ts';
import { MOCK_RULES } from './mock/rules.ts';
import type { MockServer } from './mock/server.ts';
import { Outbox } from './outbox.ts';
import { TableSync, type TableEvent } from './tableSync.ts';
import {
  FakeTime,
  connectPlayer,
  createMockServer,
  ledgerWallet,
  requirePlayerId,
  serverWallet,
  type Player,
} from './test/harness.ts';

/** Timers never fire on their own: each test flushes explicitly, so ordering is deterministic. */
const manualScheduler: Scheduler = { setTimeout: () => ({}), clearTimeout: () => undefined };

function manualConnectivity(): Connectivity & { goOnline(): void } {
  const listeners = new Set<() => void>();
  return {
    onOnline(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    goOnline() {
      for (const listener of listeners) listener();
    },
  };
}

function rethrow(error: unknown): never {
  throw error instanceof Error ? error : new Error(String(error));
}

let time: FakeTime;
let server: MockServer;
let alice: Player;

beforeEach(async () => {
  time = new FakeTime();
  server = createMockServer({ now: time.now });
  alice = await connectPlayer(server, time);
});

async function openTable(player: Player = alice) {
  const outbox = await Outbox.open(player.store, rethrow);
  const sync = new TableSync({
    client: player.client,
    outbox,
    connectivity: manualConnectivity(),
    scheduler: manualScheduler,
    jitter: () => 0,
    onError: rethrow,
  });
  const events: TableEvent[] = [];
  sync.subscribe((event) => events.push(event));
  sync.hydrate(await player.client.call('state'));
  await sync.flush();
  return { sync, outbox, events };
}

function expectConserved(player: Player = alice): void {
  const id = requirePlayerId(player);
  expect(ledgerWallet(server, id)).toEqual(serverWallet(server, id));
}

function dropNow(sync: TableSync): MintedCoin {
  time.advance(100);
  const coin = sync.drop(0, time.tick())?.coin ?? null;
  if (coin === null) throw new Error('Expected a buffered coin to drop.');
  return coin;
}

/** Lets the coin cross the table first, as the server's travel envelope requires. */
function fallNow(sync: TableSync, coinId: CoinId): void {
  time.advance(MOCK_RULES.minFallMsAfterDrop);
  sync.claimFall(coinId, time.tick(), 'front');
}

function credits(coinId: CoinId): number {
  return server.ledger().filter((entry) => entry.reason === 'claim.fall' && entry.ref === coinId)
    .length;
}

describe('TableSync online', () => {
  it('shows a buffered coin at once and lets the server settle the drop and the fall', async () => {
    const { sync, events } = await openTable();
    const coin = dropNow(sync);
    expect(sync.coinOnTable(coin.id)).toEqual(coin);
    await sync.flush();
    expect(events).toContainEqual(expect.objectContaining({ type: 'dropSettled', coin }));

    fallNow(sync, coin.id);
    expect(sync.balance?.provisionalCoins).toBe(coin.value);
    await sync.flush();
    expect(events).toContainEqual({
      type: 'claimSettled',
      claim: expect.objectContaining({ coinId: coin.id }) as unknown,
      result: expect.objectContaining({
        status: 'accepted',
        credited: coin.value,
        minted: null,
      }) as unknown,
    });
    expect(sync.balance).toEqual({
      wallet: serverWallet(server, requirePlayerId(alice)),
      provisionalCoins: 0,
    });
    expect(credits(coin.id)).toBe(1);
    expect(sync.status).toBe('synced');
    expectConserved();
  });

  it('reports a forged claim as rejected and keeps draining', async () => {
    const { sync, events } = await openTable();
    fallNow(sync, 'coin_ZZZZZZZZZZZZZZZZ' as CoinId);
    const coin = dropNow(sync);
    await sync.flush();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'claimSettled',
        result: { status: 'rejected', reason: 'unknown_entity' },
      }),
    );
    expect(events).toContainEqual(expect.objectContaining({ type: 'dropSettled', coin }));
    expect(sync.pending).toBe(0);
    expectConserved();
  });

  it('keeps the last trusted wallet when a claims answer breaks the results contract', async () => {
    const tampered: MockServer = {
      ...server,
      transport: async (request) => {
        const response = await server.transport(request);
        if (request.path !== '/v1/table/claims' || response.status !== 200) return response;
        const body = response.body as { wallet: { coins: number } };
        return {
          status: response.status,
          body: { ...body, results: [], wallet: { ...body.wallet, coins: 9_999_999 } },
        };
      },
    };
    const player = await connectPlayer(tampered, time);
    const outbox = await Outbox.open(player.store, rethrow);
    const errors: unknown[] = [];
    const sync = new TableSync({
      client: player.client,
      outbox,
      connectivity: manualConnectivity(),
      scheduler: manualScheduler,
      jitter: () => 0,
      onError: (error) => errors.push(error),
    });
    sync.hydrate(await player.client.call('state'));
    const coin = dropNow(sync);
    await sync.flush();
    const trusted = sync.balance?.wallet;
    fallNow(sync, coin.id);
    await sync.flush();
    expect(errors).toContainEqual(expect.objectContaining({ name: 'ContractViolationError' }));
    expect(sync.balance?.wallet).toEqual(trusted);
    expect(sync.balance?.wallet.coins).not.toBe(9_999_999);
  });
});

describe('TableSync offline queue', () => {
  it('plays offline on the pre-minted buffer and reconciles on reconnect', async () => {
    const { sync, events } = await openTable();
    const buffered = sync.bufferSize;
    expect(buffered).toBeGreaterThan(2);
    server.setNetwork('down');

    const first = dropNow(sync);
    await sync.flush();
    expect(sync.status).toBe('offline');
    expect(events).toContainEqual({ type: 'status', status: 'offline', pending: 1 });
    const second = dropNow(sync);
    fallNow(sync, first.id);
    fallNow(sync, second.id);
    await sync.flush();
    expect(sync.pending).toBe(3);
    expect(sync.balance?.provisionalCoins).toBe(first.value + second.value);

    server.setNetwork('up');
    await sync.flush();
    expect(sync.pending).toBe(0);
    expect(sync.status).toBe('synced');
    expect(credits(first.id)).toBe(1);
    expect(credits(second.id)).toBe(1);
    expect(sync.balance).toEqual({
      wallet: serverWallet(server, requirePlayerId(alice)),
      provisionalCoins: 0,
    });
    expectConserved();
  });

  it('expires a queue replayed after more than the claim expiry, crediting nothing', async () => {
    const { sync, events } = await openTable();
    const settled = dropNow(sync);
    await sync.flush();
    server.setNetwork('down');
    fallNow(sync, settled.id);
    const offlineDrop = dropNow(sync);
    fallNow(sync, offlineDrop.id);
    await sync.flush();
    expect(sync.pending).toBe(3);

    time.advance(MOCK_RULES.claimExpiryMs + 1_000);
    server.setNetwork('up');
    sync.hydrate(await alice.client.call('state'));
    await sync.flush();
    expect(sync.pending).toBe(0);
    expect(sync.status).toBe('synced');
    const claimResults = events.flatMap((event) =>
      event.type === 'claimSettled' ? [event.result] : [],
    );
    expect(claimResults).toEqual([
      { status: 'rejected', reason: 'expired' },
      { status: 'rejected', reason: 'expired' },
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'dropRejected',
        coinId: offlineDrop.id,
        error: expect.objectContaining({ code: 'conflict' }) as unknown,
      }),
    );
    expect(credits(settled.id)).toBe(0);
    expect(credits(offlineDrop.id)).toBe(0);
    expect(sync.balance?.provisionalCoins).toBe(0);
    const { table } = await alice.client.call('state');
    expect(table.coins.map((coin) => coin.id)).toContain(settled.id);
    expect(table.buffer.map((coin) => coin.id)).toContain(offlineDrop.id);
    expectConserved();
  });

  it('returns null for a drop with a dry buffer while offline', async () => {
    const { sync } = await openTable();
    server.setNetwork('down');
    const drop = sync.drop(0, time.tick());
    await sync.flush();
    for (let left = sync.bufferSize; left > 0; left--) dropNow(sync);
    time.advance(100);
    expect(drop).not.toBeNull();
    expect(sync.drop(0, time.tick())).toBeNull();
  });

  it('drains on the online event without waiting for the backoff', async () => {
    const outbox = await Outbox.open(alice.store, rethrow);
    const connectivity = manualConnectivity();
    const fired: (() => void)[] = [];
    const scheduler: Scheduler = {
      setTimeout: (callback) => fired.push(callback),
      clearTimeout: () => undefined,
    };
    const sync = new TableSync({
      client: alice.client,
      outbox,
      connectivity,
      scheduler,
      jitter: () => 0,
    });
    sync.hydrate(await alice.client.call('state'));
    await sync.flush();
    fired.length = 0;
    server.setNetwork('down');
    dropNow(sync);
    await sync.flush();
    server.setNetwork('up');
    fired.length = 0;
    connectivity.goOnline();
    expect(fired).toHaveLength(1);
    fired[0]?.();
    await sync.flush();
    expect(sync.pending).toBe(0);
    sync.close();
  });

  it('never double-spends or double-credits when the answers are lost and the queue is resent', async () => {
    const { sync } = await openTable();
    const claimKeys = () =>
      new Set(
        alice.requests
          .filter((request) => request.path === '/v1/table/claims')
          .map((request) => request.headers[HEADERS.idempotencyKey]),
      );
    const drops = () =>
      server.ledger().filter((entry) => entry.ref === coin.id && entry.reason !== 'claim.fall');
    const coin = dropNow(sync);
    server.setNetwork('dropResponses');
    await sync.flush();
    const dropEntries = drops().length;
    server.setNetwork('up');
    await sync.flush();
    expect(drops()).toHaveLength(dropEntries);

    fallNow(sync, coin.id);
    server.setNetwork('dropResponses');
    await sync.flush();
    expect(sync.pending).toBe(1);
    expect(credits(coin.id)).toBe(1);
    const keysSent = claimKeys();

    server.setNetwork('up');
    await sync.flush();
    expect(sync.pending).toBe(0);
    expect(credits(coin.id)).toBe(1);
    expect(claimKeys()).toEqual(keysSent);
    expect(sync.balance?.wallet).toEqual(serverWallet(server, requirePlayerId(alice)));
    expectConserved();
  });

  it('restores the queue after a reload and settles it once', async () => {
    const first = await openTable();
    server.setNetwork('down');
    const coin = dropNow(first.sync);
    fallNow(first.sync, coin.id);
    await first.sync.flush();
    first.sync.close();
    expect(first.outbox.size).toBe(2);

    server.setNetwork('up');
    const reloaded = await connectPlayer(server, time, {
      store: alice.store,
      device: alice.device,
    });
    const outbox = await Outbox.open(alice.store, rethrow);
    expect(outbox.ops.map((op) => op.kind)).toEqual(['drop', 'claims']);
    const sync = new TableSync({
      client: reloaded.client,
      outbox,
      connectivity: manualConnectivity(),
      scheduler: manualScheduler,
      jitter: () => 0,
      onError: rethrow,
    });
    expect(sync.coinOnTable(coin.id)).toEqual(coin);
    sync.hydrate(await reloaded.client.call('state'));
    expect(sync.bufferSize).toBe(first.sync.bufferSize);
    await sync.flush();
    expect(sync.pending).toBe(0);
    expect(credits(coin.id)).toBe(1);
    expect(requirePlayerId(reloaded)).toBe(requirePlayerId(alice));
    expectConserved();
  });

  it('reports a claim ticked ahead of server time as over the envelope and keeps draining', async () => {
    const { sync, events } = await openTable();
    const coin = dropNow(sync);
    time.advance(100);
    sync.claimFall(coin.id, time.tick() + 60 * 60, 'front');
    await sync.flush();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'claimSettled',
        result: { status: 'rejected', reason: 'over_envelope' },
      }),
    );
    expect(events).toContainEqual(expect.objectContaining({ type: 'dropSettled', coin }));
    expect(sync.pending).toBe(0);
    expectConserved();
  });

  it('rejects a drop whose buffered coin was already spent and removes it from the table', async () => {
    const { sync, events } = await openTable();
    const stale = sync.bufferSize;
    const { table } = await alice.client.call('state');
    const spent = table.buffer[0];
    if (spent === undefined) throw new Error('Expected a buffered coin.');
    time.advance(100);
    await alice.client.call('tableDrop', { body: { x: 0, tick: time.tick(), coinId: spent.id } });
    const coin = dropNow(sync);
    expect(coin.id).toBe(spent.id);
    expect(sync.bufferSize).toBe(stale - 1);
    await sync.flush();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'dropRejected',
        coinId: coin.id,
        error: expect.objectContaining({ code: 'conflict' }) as unknown,
      }),
    );
    expect(sync.pending).toBe(0);
    expect(sync.coinOnTable(coin.id)).toBeUndefined();
    expectConserved();
  });
});
