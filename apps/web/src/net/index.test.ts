import type { CoinId } from '@coinposh/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connectivity, Scheduler } from './connectivity.ts';
import { contractGrid } from './contract/tableSnapshot.contract.ts';
import { createNet } from './index.ts';
import type { MockServer } from './mock/server.ts';
import { Outbox } from './outbox.ts';
import { memoryStore, type KeyValueStore } from './store.ts';
import { TableSync } from './tableSync.ts';
import {
  FakeTime,
  connectPlayer,
  createMockServer,
  ledgerWallet,
  serverWallet,
} from './test/harness.ts';
import type { WireRequest } from './wire.ts';

const manualScheduler: Scheduler = { setTimeout: () => ({}), clearTimeout: () => undefined };
const neverReconnects: Connectivity = { onOnline: () => () => undefined };
const API_URL = 'https://api.coinposh.test';
const BOOT_PATH = '/v1/state?hydrate=boot';

function rethrow(error: unknown): never {
  throw error instanceof Error ? error : new Error(String(error));
}

describe('createNet in Demo Mode', () => {
  it('boots against the in-browser server through the same client, without Turnstile', async () => {
    const net = await createNet({
      mode: { kind: 'demo' },
      locale: () => 'fr',
      turnstileToken: () => Promise.reject(new Error('Demo Mode must not ask for Turnstile.')),
      onError: rethrow,
      scheduler: manualScheduler,
      monotonic: () => 0,
    });
    expect(net.mock).not.toBeNull();
    const state = await net.client.call('state');
    expect(state.table.buffer.length).toBeGreaterThan(0);
    net.table.hydrate(state);
    await net.table.flush();
    expect(net.table.balance?.wallet).toEqual(state.wallet);
    expect(net.session.playerId).not.toBeNull();
    expect(net.clock.now()).toBe(state.serverTime);
    net.table.close();
  });
});

describe('createNet boot gate', () => {
  let time: FakeTime;
  let server: MockServer;
  /** Requests the mock answered, in order, as the live page sent them through fetch. */
  let reached: WireRequest[];

  function playPaths(): string[] {
    return reached
      .map((request) => request.path)
      .filter((path) => path.startsWith('/v1/table/') || path.startsWith('/v1/state'));
  }

  beforeEach(() => {
    time = new FakeTime();
    server = createMockServer({ now: time.now });
    reached = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit): Promise<Response> => {
      const request: WireRequest = {
        method: init.method as WireRequest['method'],
        path: url.slice(API_URL.length),
        headers: init.headers as Record<string, string>,
        body: typeof init.body === 'string' ? init.body : null,
      };
      const response = await server.transport(request);
      reached.push(request);
      return new Response(response.body === undefined ? null : JSON.stringify(response.body), {
        status: response.status,
      });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** An earlier page booted, dropped a coin and posed it, then went away before either was sent. */
  async function earlierPageQueuedADrop(store: KeyValueStore): Promise<CoinId> {
    const page = await connectPlayer(server, time, { store });
    const outbox = await Outbox.open(store, rethrow);
    const sync = new TableSync({
      client: page.client,
      outbox,
      connectivity: neverReconnects,
      scheduler: manualScheduler,
      jitter: () => 0,
      onError: () => undefined,
    });
    const state = await page.client.call('state', { query: { hydrate: 'boot' } });
    const bootedAt = time.now();
    const simTick = () => Math.floor(((time.now() - bootedAt) / 1000) * 60);
    sync.hydrate(state);
    await sync.flush();
    server.setNetwork('down');
    time.advance(1_000);
    const coin = sync.drop(0, simTick())?.coin;
    if (coin === null || coin === undefined) throw new Error('Expected a buffered coin to drop.');
    time.advance(1_000);
    const queued = sync.snapshot({
      tick: simTick(),
      pusher: { tickInCycle: 0 },
      coins: contractGrid([coin.id]),
      crates: [],
    });
    expect(queued).toBe(true);
    await sync.flush();
    expect(sync.pending).toBe(2);
    sync.close();
    return coin.id;
  }

  function nextPage(store: KeyValueStore) {
    return createNet({
      mode: { kind: 'live', apiUrl: API_URL },
      locale: () => 'en',
      turnstileToken: () => Promise.reject(new Error('The stored session must be reused.')),
      onError: rethrow,
      store,
      connectivity: neverReconnects,
      scheduler: manualScheduler,
      monotonic: time.now,
    });
  }

  it('sends the queue an earlier page persisted before the boot, so the coin is laid', async () => {
    const store = memoryStore();
    const coinId = await earlierPageQueuedADrop(store);
    const net = await nextPage(store);
    server.setNetwork('up');
    time.advance(1_000);

    const booted = await net.client.call('state', { query: { hydrate: 'boot' } });

    expect(playPaths()).toEqual(['/v1/table/drop', '/v1/table/snapshot', BOOT_PATH]);
    const index = booted.table.coins.findIndex((coin) => coin.id === coinId);
    expect(booted.table.layout?.coins[index]).toEqual({
      kind: 'pose',
      pose: contractGrid([coinId])[0],
    });
    const id = net.session.playerId;
    if (id === null) throw new Error('The next page did not reuse the stored session.');
    expect(
      server.ledger().filter((entry) => entry.playerId === id && entry.reason === 'refund.table'),
    ).toEqual([]);
    expect(ledgerWallet(server, id)).toEqual(serverWallet(server, id));
    net.table.close();
  });

  it('refuses the boot while the persisted queue cannot reach the server', async () => {
    const store = memoryStore();
    await earlierPageQueuedADrop(store);
    const net = await nextPage(store);

    await expect(net.client.call('state', { query: { hydrate: 'boot' } })).rejects.toThrow(
      /queued table ops/,
    );

    expect(reached).toEqual([]);
    server.setNetwork('up');
    await net.client.call('state', { query: { hydrate: 'boot' } });
    expect(playPaths()).toEqual(['/v1/table/drop', '/v1/table/snapshot', BOOT_PATH]);
    net.table.close();
  });
});
