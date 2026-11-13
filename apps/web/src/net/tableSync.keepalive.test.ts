import {
  HEADERS,
  tableSnapshotEndpoint,
  type StateResponse,
  type TableSnapshotRequest,
} from '@coinposh/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { realScheduler, type Connectivity, type Scheduler } from './connectivity.ts';
import { contractGrid } from './contract/tableSnapshot.contract.ts';
import type { MockServer } from './mock/server.ts';
import { Outbox } from './outbox.ts';
import { SnapshotCadence } from './snapshotCadence.ts';
import { memoryStore, type KeyValueStore } from './store.ts';
import { TableSync, type SnapshotCapture, type TableEvent } from './tableSync.ts';
import {
  FakeTime,
  connectPlayer,
  createMockServer,
  requirePlayerId,
  type Player,
} from './test/harness.ts';
import type { WireRequest, WireResponse } from './wire.ts';

const neverReconnects: Connectivity = { onOnline: () => () => undefined };

/** A scheduler whose timers really fire, each time the test says the event loop moved on. */
class FiringScheduler implements Scheduler {
  readonly #timers = new Set<() => void>();

  setTimeout(callback: () => void): unknown {
    this.#timers.add(callback);
    return callback;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as () => void);
  }

  get pending(): number {
    return this.#timers.size;
  }

  fire(): void {
    const due = [...this.#timers];
    this.#timers.clear();
    for (const callback of due) callback();
  }
}

/** Holds writes while `hold` is on, as a slow IndexedDB does. */
function gatedStore(inner: KeyValueStore = memoryStore()) {
  let gate: Promise<void> | null = null;
  let open: () => void = () => undefined;
  const store: KeyValueStore = {
    get: (key) => inner.get(key),
    keys: () => inner.keys(),
    delete: async (key) => {
      await gate;
      await inner.delete(key);
    },
    set: async (key, value) => {
      await gate;
      await inner.set(key, value);
    },
  };
  return {
    store,
    hold() {
      gate = new Promise((resolve) => {
        open = resolve;
      });
    },
    release() {
      gate = null;
      open();
    },
  };
}

/** Holds the server's answers to snapshot uploads while `hold` is on, as a slow link does. */
function gatedServer(server: MockServer) {
  const held: (() => void)[] = [];
  let holding = false;
  const gated: MockServer = {
    ...server,
    transport: async (request: WireRequest): Promise<WireResponse> => {
      if (holding && request.path === tableSnapshotEndpoint.path) {
        await new Promise<void>((resolve) => held.push(resolve));
      }
      return await server.transport(request);
    },
  };
  return {
    server: gated,
    hold() {
      holding = true;
    },
    release() {
      holding = false;
      for (const resolve of held.splice(0)) resolve();
    },
  };
}

let time: FakeTime;
let server: MockServer;
let link: ReturnType<typeof gatedServer>;
let alice: Player;
const cleanups: (() => void)[] = [];

beforeEach(async () => {
  time = new FakeTime();
  server = createMockServer({ now: time.now });
  link = gatedServer(server);
  alice = await connectPlayer(link.server, time);
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function openTable(scheduler: Scheduler, store: KeyValueStore = alice.store) {
  const errors: unknown[] = [];
  const outbox = await Outbox.open(store, (error) => errors.push(error));
  const sync = new TableSync({
    client: alice.client,
    outbox,
    connectivity: neverReconnects,
    scheduler,
    jitter: () => 0,
    onError: (error) => errors.push(error),
  });
  alice.client.setBootGate(() => sync.drainBeforeBoot());
  cleanups.push(() => {
    sync.close();
    alice.client.setBootGate(null);
  });
  const events: TableEvent[] = [];
  sync.subscribe((event) => events.push(event));
  const state = await alice.client.call('state', { query: { hydrate: 'boot' } });
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

function snapshotRequests(): WireRequest[] {
  return alice.requests.filter((request) => request.path === tableSnapshotEndpoint.path);
}

function keepalives(): WireRequest[] {
  return snapshotRequests().filter((request) => request.keepalive === true);
}

function stored() {
  return server.world.player(requirePlayerId(alice))?.tableSnapshot ?? null;
}

/** Resolves once the snapshot most recently queued has its keepalive request signed and armed. */
function armed(): () => Promise<void> {
  const presign = vi.spyOn(alice.client, 'presignSnapshot');
  return async () => {
    await presign.mock.results.at(-1)?.value;
  };
}

describe('TableSync keepalive, with a scheduler that fires', () => {
  it('capture, drain, pagehide: a pagehide just after the drain sealed the snapshot still delivers it', async () => {
    const disk = gatedStore();
    const timers = new FiringScheduler();
    const { sync, outbox, events, errors, state } = await openTable(timers, disk.store);
    const presigned = armed();
    time.advance(1_000);
    expect(sync.snapshot(capture(state, time.tick()))).toBe(true);
    await presigned();
    const op = outbox.head();
    if (op?.kind !== 'snapshot') throw new Error('Expected the snapshot at the head of the queue.');

    disk.hold();
    expect(timers.pending).toBe(1);
    timers.fire();
    expect(op.sent).toBe(true);
    expect(snapshotRequests()).toEqual([]);

    sync.pagehide();
    expect(keepalives()).toHaveLength(1);
    expect(keepalives()[0]?.headers[HEADERS.idempotencyKey]).toBe(op.key);
    await vi.waitFor(() => {
      expect(stored()?.seq).toBe(1);
    });

    disk.release();
    await sync.flush();
    expect(sync.pending).toBe(0);
    expect(events).toContainEqual({ type: 'snapshotSettled', seq: 1, stored: 3, ignored: 0 });
    expect(errors).toEqual([]);
    expect(snapshotRequests().every((request) => request.keepalive === true)).toBe(true);
    expect(new Set(snapshotRequests().map((r) => r.headers[HEADERS.idempotencyKey]))).toEqual(
      new Set([op.key]),
    );
    sync.pagehide();
    expect(snapshotRequests()).toHaveLength(2);
  });

  it('sends the drained upload itself as a keepalive request, so a pagehide mid-flight adds no copy', async () => {
    const timers = new FiringScheduler();
    const { sync, events, errors, state } = await openTable(timers);
    const presigned = armed();
    time.advance(1_000);
    sync.snapshot(capture(state, time.tick()));
    await presigned();

    link.hold();
    timers.fire();
    await vi.waitFor(() => {
      expect(snapshotRequests()).toHaveLength(1);
    });
    sync.pagehide();
    expect(snapshotRequests()).toHaveLength(1);
    expect(snapshotRequests()[0]?.keepalive).toBe(true);

    link.release();
    await sync.flush();
    expect(stored()?.seq).toBe(1);
    expect(events).toContainEqual({ type: 'snapshotSettled', seq: 1, stored: 3, ignored: 0 });
    expect(errors).toEqual([]);
  });

  it('keeps the signed request armed while a failed upload waits out its retry', async () => {
    const timers = new FiringScheduler();
    const { sync, state } = await openTable(timers);
    const presigned = armed();
    server.setNetwork('down');
    time.advance(1_000);
    sync.snapshot(capture(state, time.tick()));
    await presigned();
    timers.fire();
    await sync.flush();
    expect(sync.status).toBe('offline');
    expect(sync.pending).toBe(1);
    expect(timers.pending).toBe(1);

    server.setNetwork('up');
    sync.pagehide();
    await vi.waitFor(() => {
      expect(stored()?.seq).toBe(1);
    });
    expect(keepalives().length).toBeGreaterThanOrEqual(2);
  });

  it('never fires a request signed for a snapshot a newer capture replaced', async () => {
    const timers = new FiringScheduler();
    const { sync, state } = await openTable(timers);
    const presigned = armed();
    time.advance(1_000);
    sync.snapshot(capture(state, time.tick(), 1));
    sync.snapshot(capture(state, time.tick(), 2));
    await presigned();
    sync.pagehide();
    expect(keepalives()).toHaveLength(1);
    await vi.waitFor(() => {
      expect(stored()?.poses).toHaveLength(2);
    });
    const body = JSON.parse(keepalives()[0]?.body ?? 'null') as TableSnapshotRequest;
    expect(body.seq).toBe(2);
  });

  it('queues what the capture said when it was taken, not what the caller later wrote into it', async () => {
    const timers = new FiringScheduler();
    const { sync, outbox, state } = await openTable(timers);
    const taken = capture(state, 60);
    const coin = taken.coins[0];
    if (coin === undefined) throw new Error('Expected a posed coin.');
    const x = coin[1];
    sync.snapshot(taken);
    coin[1] = x + 7;
    const op = outbox.head();
    expect(op?.kind === 'snapshot' ? op.body.coins[0]?.[1] : null).toBe(x);
  });
});

describe('SnapshotCadence and TableSync on the real event loop', () => {
  async function liveTable() {
    const table = await openTable(realScheduler);
    let current: SnapshotCapture | null = null;
    const cadence = new SnapshotCadence({
      table: table.sync,
      capture: () => current,
      scheduler: realScheduler,
      monotonic: time.now,
    });
    cleanups.push(() => {
      cadence.close();
    });
    return {
      ...table,
      cadence,
      show: (next: SnapshotCapture) => {
        current = next;
      },
    };
  }

  it('hidden and pagehide in the same task: the hidden upload still goes out once, as keepalive', async () => {
    const { cadence, sync, events, errors, state, show } = await liveTable();
    time.advance(1_000);
    show(capture(state, time.tick()));
    cadence.hidden();
    cadence.pagehide();
    await vi.waitFor(() => {
      expect(stored()?.seq).toBe(1);
    });
    await sync.flush();
    expect(snapshotRequests()).toHaveLength(1);
    expect(snapshotRequests()[0]?.keepalive).toBe(true);
    expect(events).toContainEqual({ type: 'snapshotSettled', seq: 1, stored: 3, ignored: 0 });
    expect(errors).toEqual([]);
  });

  it('capture, drain, pagehide: a settled upload under way is delivered without a second copy', async () => {
    const { cadence, sync, state, show } = await liveTable();
    time.advance(1_000);
    show(capture(state, time.tick()));
    link.hold();
    cadence.hidden();
    await vi.waitFor(() => {
      expect(snapshotRequests()).toHaveLength(1);
    });
    cadence.pagehide();
    link.release();
    await vi.waitFor(() => {
      expect(stored()?.seq).toBe(1);
    });
    await sync.flush();
    expect(snapshotRequests()).toHaveLength(1);
    expect(snapshotRequests()[0]?.keepalive).toBe(true);
  });

  it('a snapshot the closing page could not deliver drains from the persisted outbox before the next boot', async () => {
    const { cadence, sync, state, show } = await liveTable();
    server.setNetwork('down');
    time.advance(1_000);
    show(capture(state, time.tick()));
    cadence.hidden();
    await sync.flush();
    cadence.pagehide();
    expect(sync.pending).toBe(1);
    cadence.close();
    sync.close();

    server.setNetwork('up');
    const next = await openTable(new FiringScheduler());
    expect(next.sync.session).not.toBe(state.table.session);
    const order = alice.requests
      .map((request) => request.path.split('?')[0])
      .filter((path) => path === tableSnapshotEndpoint.path || path === '/v1/state');
    expect(order.slice(-2)).toEqual([tableSnapshotEndpoint.path, '/v1/state']);
    expect(next.events).toContainEqual({
      type: 'snapshotSettled',
      seq: 1,
      stored: 3,
      ignored: 0,
    });
    expect(next.sync.pending).toBe(0);
    expect(next.errors).toEqual([]);
  });
});
