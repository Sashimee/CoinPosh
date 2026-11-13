import { HEADERS, tableSnapshotEndpoint, type StateResponse } from '@coinposh/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connectivity, Scheduler } from './connectivity.ts';
import { contractGrid } from './contract/tableSnapshot.contract.ts';
import { MOCK_RULES } from './mock/rules.ts';
import type { MockServer } from './mock/server.ts';
import { SNAPSHOT_RATE } from './mock/snapshot.ts';
import { Outbox, outboxKey } from './outbox.ts';
import { ContractViolationError } from './request.ts';
import { TableSync, type SnapshotCapture, type TableEvent } from './tableSync.ts';
import {
  FakeTime,
  connectPlayer,
  createMockServer,
  ledgerWallet,
  requirePlayerId,
  serverWallet,
  type Player,
} from './test/harness.ts';
import type { WireRequest } from './wire.ts';

const manualScheduler: Scheduler = { setTimeout: () => ({}), clearTimeout: () => undefined };
const neverReconnects: Connectivity = { onOnline: () => () => undefined };

let time: FakeTime;
let server: MockServer;
let alice: Player;

beforeEach(async () => {
  time = new FakeTime();
  server = createMockServer({ now: time.now });
  alice = await connectPlayer(server, time);
});

async function openTable(player: Player = alice) {
  const errors: unknown[] = [];
  const outbox = await Outbox.open(player.store, (error) => errors.push(error));
  const sync = new TableSync({
    client: player.client,
    outbox,
    connectivity: neverReconnects,
    scheduler: manualScheduler,
    jitter: () => 0,
    onError: (error) => errors.push(error),
  });
  const events: TableEvent[] = [];
  sync.subscribe((event) => events.push(event));
  const state = await player.client.call('state', { query: { hydrate: 'boot' } });
  sync.hydrate(state);
  await sync.flush();
  return { sync, outbox, events, errors, state };
}

function capture(state: StateResponse, tick: number, count = 3): SnapshotCapture {
  return {
    tick,
    pusher: { tickInCycle: 0 },
    coins: contractGrid(state.table.coins.slice(0, count).map((coin) => coin.id)),
    crates: [],
  };
}

function sentBodies(path: string): Record<string, unknown>[] {
  return alice.requests
    .filter((request) => request.path === path && request.body !== null)
    .map((request) => JSON.parse(request.body ?? 'null') as Record<string, unknown>);
}

function keepalives(): WireRequest[] {
  return alice.requests.filter((request) => request.keepalive === true);
}

function stored() {
  return server.world.player(requirePlayerId(alice))?.tableSnapshot ?? null;
}

describe('TableSync table session', () => {
  it('names the booted session on every drop, claim and nudge it sends', async () => {
    const { sync, state } = await openTable();
    expect(sync.session).toBe(state.table.session);
    time.advance(100);
    const coin = sync.drop(0, time.tick())?.coin;
    if (coin === null || coin === undefined) throw new Error('Expected a buffered coin to drop.');
    await sync.flush();
    time.advance(MOCK_RULES.minFallMsAfterDrop);
    sync.claimFall(coin.id, time.tick(), 'front');
    sync.nudge(time.tick(), 'left');
    await sync.flush();
    for (const path of ['/v1/table/drop', '/v1/table/claims', '/v1/table/nudge']) {
      const bodies = sentBodies(path);
      expect(bodies.length, path).toBeGreaterThan(0);
      for (const body of bodies) expect(body.session, path).toBe(state.table.session);
    }
  });

  it('keeps each session queue under its own key', async () => {
    const { sync } = await openTable();
    time.advance(100);
    server.setNetwork('down');
    sync.drop(0, time.tick());
    await sync.flush();
    const session = sync.session;
    if (session === null) throw new Error('No session.');
    expect(await alice.store.get(outboxKey(session))).toHaveLength(1);
    expect(await alice.store.get('outbox')).toBeUndefined();
  });

  it('surfaces another boot as sessionSuperseded and stops drops, nudges and snapshots', async () => {
    const { sync, events, state } = await openTable();
    const otherTab = await alice.client.call('state', { query: { hydrate: 'boot' } });
    expect(otherTab.table.session).not.toBe(state.table.session);

    time.advance(1_000);
    expect(sync.snapshot(capture(state, time.tick()))).toBe(true);
    await sync.flush();
    expect(events).toContainEqual({ type: 'sessionSuperseded', session: state.table.session });
    expect(sync.superseded).toBe(true);
    time.advance(100);
    expect(sync.drop(0, time.tick())).toBeNull();
    expect(sync.nudge(time.tick(), 'left')).toBe(false);
    expect(sync.snapshot(capture(state, time.tick()))).toBe(false);
    expect(sync.pending).toBe(0);
    expect(events.filter((event) => event.type === 'sessionSuperseded')).toHaveLength(1);
  });

  it('notices a newer session on a resync too', async () => {
    const { sync, events } = await openTable();
    await alice.client.call('state', { query: { hydrate: 'boot' } });
    await sync.resume();
    expect(sync.superseded).toBe(true);
    expect(events.some((event) => event.type === 'sessionSuperseded')).toBe(true);
  });

  it('drains every queued op before a boot, and refuses the boot while any stays queued', async () => {
    const { sync, events } = await openTable();
    server.setNetwork('down');
    time.advance(100);
    sync.drop(0, time.tick());
    await expect(sync.drainBeforeBoot()).rejects.toThrow(/queued table ops/);
    server.setNetwork('up');
    await sync.drainBeforeBoot();
    expect(sync.pending).toBe(0);
    expect(events.filter((event) => event.type === 'dropSettled')).toHaveLength(1);
  });
});

describe('TableSync snapshots', () => {
  it('uploads a capture behind the queued drop with the next seq', async () => {
    const { sync, events, state } = await openTable();
    time.advance(1_000);
    sync.drop(0, time.tick());
    expect(sync.snapshot(capture(state, time.tick()))).toBe(true);
    await sync.flush();
    const order = alice.requests
      .map((request) => request.path)
      .filter((path) => path === '/v1/table/drop' || path === tableSnapshotEndpoint.path);
    expect(order).toEqual(['/v1/table/drop', tableSnapshotEndpoint.path]);
    expect(events).toContainEqual({ type: 'snapshotSettled', seq: 1, stored: 3, ignored: 0 });
    expect(stored()?.seq).toBe(1);
  });

  it('keeps only the latest unsent capture', async () => {
    const { sync, state } = await openTable();
    server.setNetwork('down');
    time.advance(1_000);
    sync.snapshot(capture(state, time.tick(), 1));
    sync.snapshot(capture(state, time.tick(), 2));
    await sync.flush();
    expect(sync.pending).toBe(1);
    server.setNetwork('up');
    await sync.flush();
    expect(stored()).toMatchObject({ seq: 2 });
    expect(stored()?.poses).toHaveLength(2);
  });

  it('refuses a capture outside the contract and reports it', async () => {
    const { sync, errors, state } = await openTable();
    const forged = { ...capture(state, 60), pusher: { tickInCycle: -1 } };
    expect(sync.snapshot(forged)).toBe(false);
    expect(errors.some((error) => error instanceof ContractViolationError)).toBe(true);
    expect(sync.pending).toBe(0);
  });

  it('has no session to name before the first state', async () => {
    const outbox = await Outbox.open(alice.store, (error) => {
      throw error;
    });
    const sync = new TableSync({
      client: alice.client,
      outbox,
      connectivity: neverReconnects,
      scheduler: manualScheduler,
    });
    expect(sync.snapshot(capture({ table: { coins: [] } } as unknown as StateResponse, 0))).toBe(
      false,
    );
  });

  it('defers on rate_limited with the server retry hint and keeps the queue moving', async () => {
    const { sync, events, state } = await openTable();
    for (let i = 1; i <= SNAPSHOT_RATE.burst + 1; i++) {
      time.advance(10);
      sync.snapshot(capture(state, time.tick() + i));
      await sync.flush();
    }
    const deferred = events.find((event) => event.type === 'snapshotDeferred');
    expect(deferred).toMatchObject({ type: 'snapshotDeferred' });
    expect(deferred?.type === 'snapshotDeferred' ? deferred.retryAfterMs : 0).toBeGreaterThan(0);
    expect(sync.pending).toBe(0);
    expect(sync.status).toBe('synced');
    expect(stored()?.seq).toBe(SNAPSHOT_RATE.burst);
  });

  it('drops a stale capture quietly, since a newer table state is already on the server', async () => {
    const { sync, events, errors, state } = await openTable();
    time.advance(1_000);
    sync.drop(0, time.tick());
    sync.snapshot(capture(state, 0));
    await sync.flush();
    expect(sync.pending).toBe(0);
    expect(events.some((event) => event.type === 'snapshotRejected')).toBe(false);
    expect(errors).toEqual([]);
    expect(stored()?.seq).toBe(0);
  });

  it('sends the pre-signed capture with keepalive on pagehide, which the server stores', async () => {
    const { sync, state } = await openTable();
    time.advance(1_000);
    sync.snapshot(capture(state, time.tick()));
    await vi.waitFor(() => {
      sync.pagehide();
      expect(keepalives()).toHaveLength(1);
    });
    const [request] = keepalives();
    expect(request?.path).toBe(tableSnapshotEndpoint.path);
    await vi.waitFor(() => {
      expect(stored()?.seq).toBe(1);
    });
    sync.pagehide();
    expect(keepalives()).toHaveLength(1);
  });

  it('never lets the keepalive overtake a drop queued before it', async () => {
    const { sync, state } = await openTable();
    server.setNetwork('down');
    time.advance(1_000);
    sync.drop(0, time.tick());
    sync.snapshot(capture(state, time.tick()));
    await new Promise((resolve) => setTimeout(resolve, 20));
    sync.pagehide();
    expect(keepalives()).toEqual([]);
  });

  it('signs the keepalive again with the new access token after a refresh', async () => {
    const { sync, state } = await openTable();
    time.advance(1_000);
    sync.snapshot(capture(state, time.tick()));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const before = await alice.session.accessToken();
    time.advance(MOCK_RULES.accessTokenTtlMs);
    const after = await alice.session.accessToken();
    expect(after).not.toBe(before);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await vi.waitFor(() => {
      sync.pagehide();
      expect(keepalives()).toHaveLength(1);
    });
    expect(keepalives()[0]?.headers[HEADERS.authorization]).toBe(`Bearer ${after}`);
  });

  it('moves no value, whatever the captures say', async () => {
    const { sync, state } = await openTable();
    const id = requirePlayerId(alice);
    const wallet = structuredClone(serverWallet(server, id));
    const ledger = server.ledger().length;
    time.advance(1_000);
    sync.snapshot(capture(state, time.tick(), 30));
    await sync.flush();
    expect(serverWallet(server, id)).toEqual(wallet);
    expect(server.ledger()).toHaveLength(ledger);
    expect(ledgerWallet(server, id)).toEqual(serverWallet(server, id));
  });
});
