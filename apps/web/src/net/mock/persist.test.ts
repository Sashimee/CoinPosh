import { crateSpawn } from '@coinposh/economy';
import type { CoinId, CrateId, StateResponse, TableCrate, TableSessionId } from '@coinposh/shared';
import { SIM_SNAPSHOT_VERSION } from '@coinposh/sim/snapshot';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contractGrid } from '../contract/tableSnapshot.contract.ts';
import { newIdempotencyKey } from '../request.ts';
import {
  FakeTime,
  connectPlayer,
  ledgerWallet,
  requirePlayerId,
  serverWallet,
  type Player,
} from '../test/harness.ts';
import {
  DEMO_BLOB_SCHEMA_VERSION,
  DEMO_STORAGE_KEY,
  decodeDemoBlob,
  encodeDemoBlob,
  type MockStorage,
} from './persist.ts';
import { MOCK_RULES } from './rules.ts';
import { createMockServer, type MockServer, type MockServerOptions } from './server.ts';
import { MockWorld } from './world.ts';

class FakeStorage implements MockStorage {
  readonly items = new Map<string, string>();
  failGet = false;
  failSet = false;
  failRemove = false;
  writes = 0;

  getItem(key: string): string | null {
    if (this.failGet) throw new DOMException('Storage is blocked.', 'SecurityError');
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failSet) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    this.writes += 1;
    this.items.set(key, value);
  }

  removeItem(key: string): void {
    if (this.failRemove) throw new DOMException('Storage is blocked.', 'SecurityError');
    this.items.delete(key);
  }
}

let time: FakeTime;
let storage: FakeStorage;
let warnings: string[];

beforeEach(() => {
  time = new FakeTime();
  storage = new FakeStorage();
  warnings = [];
});

/** A page life of the Demo server: no warning is expected unless a test collects them. */
function page(options: Partial<MockServerOptions> = {}): MockServer {
  return createMockServer({
    now: time.now,
    storage,
    lifecycle: null,
    onPersistWarning: (message) => {
      throw new Error(`Unexpected persistence warning: ${message}`);
    },
    ...options,
  });
}

function collectingPage(options: Partial<MockServerOptions> = {}): MockServer {
  return page({ onPersistWarning: (message) => warnings.push(message), ...options });
}

/** One page's client: its device key and sim clock are new on every reload. */
class Tab {
  #simStartedAt = time.now();

  private constructor(
    readonly server: MockServer,
    readonly player: Player,
  ) {}

  static async open(server: MockServer): Promise<Tab> {
    return new Tab(server, await connectPlayer(server, time));
  }

  get id() {
    return requirePlayerId(this.player);
  }

  simTick(): number {
    return Math.floor(((time.now() - this.#simStartedAt) / 1000) * 60);
  }

  async boot(): Promise<StateResponse> {
    const state = await this.player.client.call('state', { query: { hydrate: 'boot' } });
    this.#simStartedAt = time.now();
    return state;
  }

  wallet() {
    return serverWallet(this.server, this.id);
  }

  expectConserved(): void {
    expect(ledgerWallet(this.server, this.id)).toEqual(this.wallet());
  }

  async drop(state: StateResponse) {
    const buffered = (await this.player.client.call('state')).table.buffer[0];
    if (buffered === undefined) throw new Error('The buffer ran dry.');
    time.advance(100);
    return this.player.client.call('tableDrop', {
      body: { session: session(state), x: 0, tick: this.simTick(), coinId: buffered.id },
    });
  }

  async claimCrate(state: StateResponse, crateId: CrateId) {
    time.advance(100);
    const { results } = await this.player.client.call('tableClaims', {
      body: {
        session: session(state),
        claims: [{ kind: 'crate', crateId, tick: this.simTick(), edge: 'front' }],
      },
    });
    return results;
  }

  async claimFall(state: StateResponse, coinId: CoinId) {
    time.advance(MOCK_RULES.minFallMsAfterDrop);
    const { results } = await this.player.client.call('tableClaims', {
      body: {
        session: session(state),
        claims: [{ kind: 'fall', coinId, tick: this.simTick(), edge: 'front' }],
      },
    });
    return results;
  }
}

function session(state: StateResponse): TableSessionId {
  const id = state.table.session;
  if (id === undefined) throw new Error('The mock state named no table session.');
  return id;
}

function storedBlob(): string {
  const raw = storage.items.get(DEMO_STORAGE_KEY);
  if (raw === undefined) throw new Error('Nothing was written to the tab storage.');
  return raw;
}

function storedWorld() {
  const decoded = decodeDemoBlob(storedBlob());
  if (!decoded.ok) throw new Error(`The stored blob does not decode: ${decoded.reason}`);
  return decoded.world;
}

/** Plays up to the scripted FTUE crate and wins it over the lip, leaving it claimed but unopened. */
async function winFtueCrate(tab: Tab): Promise<{ state: StateResponse; crate: TableCrate }> {
  const state = await tab.boot();
  let crate: TableCrate | null = null;
  for (let i = 0; i < crateSpawn.ftueScriptedDrop && crate === null; i++) {
    const response = await tab.drop(state);
    crate = response.spawnedCrates[0] ?? null;
    await tab.claimFall(state, response.coin.id);
  }
  if (crate === null) throw new Error('Expected the scripted FTUE crate.');
  expect(await tab.claimCrate(state, crate.id)).toEqual([
    { status: 'accepted', credited: 0, cascade: null, minted: null },
  ]);
  return { state, crate };
}

describe('Demo persistence: the world survives a reload of the tab', () => {
  it('round-trips the wallet, ledger, table coins and their poses into a new page', async () => {
    const first = await Tab.open(page());
    const state = await first.boot();
    const dropped = [];
    for (let i = 0; i < 4; i++) dropped.push((await first.drop(state)).coin);
    const [fallen, ...resting] = dropped;
    if (fallen === undefined) throw new Error('No drop.');
    await first.claimFall(state, fallen.id);
    time.advance(1_000);
    const poses = contractGrid(resting.map((coin) => coin.id));
    await first.player.client.snapshot(
      {
        session: session(state),
        seq: 1,
        tick: first.simTick(),
        pusher: { tickInCycle: 0 },
        coins: poses,
        crates: [],
      },
      { idempotencyKey: newIdempotencyKey() },
    );
    const before = await first.player.client.call('state');
    first.server.flush();

    time.advance(5_000);
    const reloaded = page();
    expect(reloaded.restored).toBe(true);
    const second = await Tab.open(reloaded);
    const booted = await second.boot();

    expect(second.id).toBe(first.id);
    expect(second.player.device).not.toBe(first.player.device);
    expect(booted.wallet).toEqual(before.wallet);
    expect(reloaded.ledger()).toEqual(first.server.ledger());
    expect(booted.table.coins.map((coin) => coin.id)).toEqual(
      before.table.coins.map((coin) => coin.id),
    );
    for (const pose of poses) {
      const index = booted.table.coins.findIndex((coin) => coin.id === pose[0]);
      expect(booted.table.layout?.coins[index]).toEqual({ kind: 'pose', pose });
    }
    expect(reloaded.ledger().filter((entry) => entry.reason === 'refund.table')).toEqual([]);
    second.expectConserved();

    expect(session(booted).endsWith('001')).toBe(true);
    await second.drop(booted);
    second.expectConserved();
  });

  it('encodes a played world losslessly', async () => {
    const tab = await Tab.open(page());
    const state = await tab.boot();
    for (let i = 0; i < 3; i++) await tab.claimFall(state, (await tab.drop(state)).coin.id);
    const world = tab.server.world.serialize();
    expect(decodeDemoBlob(encodeDemoBlob(world))).toEqual({ ok: true, world });
  });

  it('keeps the player the old device signed in as away from a stranger with the same blob', async () => {
    const first = await Tab.open(page());
    await first.boot();
    first.server.flush();
    const reloaded = page();
    const owner = await Tab.open(reloaded);
    await owner.boot();
    const stranger = await Tab.open(reloaded);
    await stranger.boot();
    expect(owner.id).toBe(first.id);
    expect(stranger.id).not.toBe(first.id);
  });

  it('starts fresh, with nothing stored, when the server is given no storage', async () => {
    const tab = await Tab.open(page({ storage: null }));
    await tab.boot();
    tab.server.flush();
    expect(storage.writes).toBe(0);
    const reloaded = page();
    expect(reloaded.restored).toBe(false);
    const fresh = await Tab.open(reloaded);
    await fresh.boot();
    expect(fresh.id).not.toBe(tab.id);
  });

  it('debounces writes during a burst and flushes at once on pagehide', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const lifecycle = new EventTarget();
      const tab = await Tab.open(page({ lifecycle, persistDelayMs: 60_000 }));
      await tab.boot();
      expect(storage.writes).toBe(0);
      lifecycle.dispatchEvent(new Event('pagehide'));
      expect(storage.writes).toBe(1);
      expect(storedWorld().players.map((player) => player.id)).toEqual([tab.id]);

      await tab.player.client.call('state');
      await tab.player.client.call('state');
      expect(storage.writes).toBe(1);
      vi.advanceTimersByTime(59_999);
      expect(storage.writes).toBe(1);
      vi.advanceTimersByTime(1);
      expect(storage.writes).toBe(2);

      await tab.player.client.call('state');
      lifecycle.dispatchEvent(new Event('visibilitychange'));
      expect(storage.writes).toBe(3);
      vi.advanceTimersByTime(60_000);
      expect(storage.writes).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the last stored state on a mid-request pagehide, then stores the new one after', async () => {
    const lifecycle = new EventTarget();
    let hideMidRequest = false;
    let duringHide: { writes: number; tableSession: string | null | undefined } | null = null;
    const now = () => {
      if (hideMidRequest) {
        hideMidRequest = false;
        lifecycle.dispatchEvent(new Event('pagehide'));
        duringHide = {
          writes: storage.writes,
          tableSession: storedWorld().players[0]?.tableSession,
        };
      }
      return time.now();
    };
    const tab = await Tab.open(page({ now, lifecycle, persistDelayMs: 60_000 }));
    const first = await tab.player.client.call('state', { query: { hydrate: 'boot' } });
    tab.server.flush();
    const writesBefore = storage.writes;
    hideMidRequest = true;
    const booted = await tab.player.client.call('state', { query: { hydrate: 'boot' } });
    expect(session(booted)).not.toBe(session(first));
    expect(duringHide, 'the hidden page never encodes a world mid-request').toEqual({
      writes: writesBefore,
      tableSession: session(first),
    });
    expect(storage.writes).toBe(writesBefore + 1);
    expect(storedWorld().players[0]?.tableSession).toBe(session(booted));
  });

  it('retries a failed write on a mid-request pagehide without encoding again', async () => {
    const lifecycle = new EventTarget();
    let hideMidRequest = false;
    let duringHide: { writes: number; encodes: number } | null = null;
    const serialize = vi.spyOn(MockWorld.prototype, 'serialize');
    try {
      const now = () => {
        if (hideMidRequest) {
          hideMidRequest = false;
          lifecycle.dispatchEvent(new Event('pagehide'));
          duringHide = { writes: storage.writes, encodes: serialize.mock.calls.length };
        }
        return time.now();
      };
      const tab = await Tab.open(collectingPage({ now, lifecycle, persistDelayMs: 60_000 }));
      const first = await tab.boot();
      storage.failSet = true;
      tab.server.flush();
      expect(storage.writes).toBe(0);
      expect(warnings).toHaveLength(1);
      storage.failSet = false;
      const encodes = serialize.mock.calls.length;
      hideMidRequest = true;
      await tab.player.client.call('state');
      expect(duringHide).toEqual({ writes: 1, encodes });
      expect(storedWorld().players[0]?.tableSession).toBe(session(first));
      expect(storage.writes).toBe(2);
    } finally {
      serialize.mockRestore();
    }
  });

  it('does not rewrite an unchanged stored state on a second mid-request pagehide', async () => {
    const lifecycle = new EventTarget();
    let hides = 0;
    let writesDuring: number[] = [];
    const now = () => {
      for (; hides > 0; hides--) {
        lifecycle.dispatchEvent(new Event('pagehide'));
        writesDuring.push(storage.writes);
      }
      return time.now();
    };
    const tab = await Tab.open(page({ now, lifecycle, persistDelayMs: 60_000 }));
    await tab.player.client.call('state');
    tab.server.flush();
    const writesBefore = storage.writes;
    hides = 2;
    writesDuring = [];
    await tab.player.client.call('state');
    expect(writesDuring).toEqual([writesBefore, writesBefore]);
    expect(storage.writes).toBe(writesBefore + 1);
  });

  it('encodes the world once per burst of requests, not once per request', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const serialize = vi.spyOn(MockWorld.prototype, 'serialize');
    try {
      const lifecycle = new EventTarget();
      const tab = await Tab.open(page({ lifecycle, persistDelayMs: 250 }));
      await tab.boot();
      vi.advanceTimersByTime(250);
      serialize.mockClear();
      const writesBefore = storage.writes;
      for (let i = 0; i < 5; i++) await tab.player.client.call('state');
      expect(serialize).not.toHaveBeenCalled();
      vi.advanceTimersByTime(250);
      expect(serialize).toHaveBeenCalledTimes(1);
      expect(storage.writes).toBe(writesBefore + 1);

      lifecycle.dispatchEvent(new Event('pagehide'));
      expect(serialize, 'nothing changed since the last write').toHaveBeenCalledTimes(1);
      expect(storage.writes).toBe(writesBefore + 1);
    } finally {
      serialize.mockRestore();
      vi.useRealTimers();
    }
  });

  it('still writes every persistMaxWaitMs while requests keep restarting the debounce', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const tab = await Tab.open(page({ persistDelayMs: 100, persistMaxWaitMs: 400 }));
      await tab.boot();
      vi.advanceTimersByTime(400);
      const writesBefore = storage.writes;
      for (let i = 0; i < 4; i++) {
        await tab.player.client.call('state');
        vi.advanceTimersByTime(90);
      }
      expect(storage.writes).toBe(writesBefore);
      await tab.player.client.call('state');
      vi.advanceTimersByTime(90);
      expect(storage.writes).toBe(writesBefore + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores a world whose wallet and drop buffer are both empty, and refills it from new credit', async () => {
    const first = await Tab.open(page());
    const state = await first.boot();
    const dropped: CoinId[] = [];
    for (let i = 0; i < 100; i++) {
      const buffer = (await first.player.client.call('state')).table.buffer;
      if (buffer.length === 0) break;
      dropped.push((await first.drop(state)).coin.id);
    }
    time.advance(1_000);
    await first.player.client.snapshot(
      {
        session: session(state),
        seq: 1,
        tick: first.simTick(),
        pusher: { tickInCycle: 0 },
        coins: contractGrid(dropped),
        crates: [],
      },
      { idempotencyKey: newIdempotencyKey() },
    );
    const drained = await first.player.client.call('state');
    expect(drained.wallet.coins).toBe(0);
    expect(drained.table.buffer).toEqual([]);
    first.server.flush();
    const left = storedWorld().players[0];
    expect(left?.wallet.coins).toBe(0);
    expect(left?.coins.filter((record) => record.place === 'buffer')).toEqual([]);

    time.advance(5_000);
    const reloaded = page();
    expect(reloaded.restored).toBe(true);
    const second = await Tab.open(reloaded);
    const booted = await second.boot();
    expect(second.id).toBe(first.id);
    expect(booted.wallet.coins).toBe(0);
    expect(booted.table.buffer).toEqual([]);
    expect(booted.table.coins.map((coin) => coin.id).sort()).toEqual(
      drained.table.coins.map((coin) => coin.id).sort(),
    );
    second.expectConserved();

    const fromSeq = reloaded.ledger().at(-1)?.seq ?? -1;
    const heapCoin = booted.table.layout?.coins.findIndex((slot) => slot.kind === 'heapSlot') ?? -1;
    const falling = booted.table.coins[heapCoin];
    if (falling === undefined) throw new Error('The restored table laid no opening heap coin.');
    const [claimed] = await second.claimFall(booted, falling.id);
    expect(claimed).toMatchObject({ status: 'accepted' });
    const resumed = await second.player.client.call('state');
    const moves = reloaded
      .ledger()
      .filter((entry) => entry.seq > fromSeq && entry.reason !== 'drop.prepay');
    const earned = moves.reduce((sum, entry) => sum + (entry.delta.coins ?? 0), 0);
    expect(earned).toBeGreaterThan(0);
    expect(resumed.table.buffer.length).toBeGreaterThan(0);
    const plaque = resumed.table.buffer.reduce(
      (sum, coin) => sum + coin.value,
      resumed.wallet.coins,
    );
    expect(plaque, 'wallet plus buffer is exactly what the player earned since the reload').toBe(
      earned,
    );
    second.expectConserved();
  });
});

describe('Demo persistence: claimed-but-unopened crates', () => {
  it('relays a crate won before the reload at the lip, to claim once and open once', async () => {
    const first = await Tab.open(page());
    const { crate } = await winFtueCrate(first);
    const stars = first.wallet().stars;
    first.server.flush();

    const reloaded = page();
    const second = await Tab.open(reloaded);
    const booted = await second.boot();
    const index = booted.table.crates.findIndex((candidate) => candidate.id === crate.id);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(booted.table.layout?.crates[index]).toMatchObject({
      kind: 'pose',
      pose: [crate.id, 0, expect.any(Number), expect.any(Number), 'teeter'],
    });

    expect(await second.claimCrate(booted, crate.id)).toEqual([
      { status: 'accepted', credited: 0, cascade: null, minted: null },
    ]);
    expect(await second.claimCrate(booted, crate.id)).toEqual([
      { status: 'rejected', reason: 'already_claimed' },
    ]);
    expect(second.wallet().stars).toBe(stars);

    const opened = await second.player.client.call('cratesOpen', { body: { crateId: crate.id } });
    expect(opened.roll.rarity).toBe(crateSpawn.ftueScriptedRarity);
    await expect(
      second.player.client.call('cratesOpen', { body: { crateId: crate.id } }),
    ).rejects.toMatchObject({ code: 'conflict' });
    second.expectConserved();
    reloaded.flush();

    const third = await Tab.open(page());
    const rebooted = await third.boot();
    expect(rebooted.table.crates.map((candidate) => candidate.id)).not.toContain(crate.id);
    await expect(
      third.player.client.call('cratesOpen', { body: { crateId: crate.id } }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await third.claimCrate(rebooted, crate.id)).toEqual([
      { status: 'rejected', reason: 'already_claimed' },
    ]);
    third.expectConserved();
  });

  it('keeps a crate won in this page off the lip on an in-page re-boot, its open still in flight', async () => {
    const tab = await Tab.open(page());
    const { crate } = await winFtueCrate(tab);
    const rebooted = await tab.boot();
    expect(rebooted.table.crates.map((candidate) => candidate.id)).not.toContain(crate.id);
    expect(await tab.claimCrate(rebooted, crate.id)).toEqual([
      { status: 'rejected', reason: 'already_claimed' },
    ]);
    const opened = await tab.player.client.call('cratesOpen', { body: { crateId: crate.id } });
    expect(opened.roll.rarity).toBe(crateSpawn.ftueScriptedRarity);
    tab.expectConserved();
  });

  it('lays a restored crate at the lip once more after an in-page re-boot, until it is claimed', async () => {
    const first = await Tab.open(page());
    const { crate } = await winFtueCrate(first);
    first.server.flush();

    const second = await Tab.open(page());
    await second.boot();
    const retaken = await second.boot();
    expect(retaken.table.crates.map((candidate) => candidate.id)).toContain(crate.id);
    expect(await second.claimCrate(retaken, crate.id)).toEqual([
      { status: 'accepted', credited: 0, cascade: null, minted: null },
    ]);

    const again = await second.boot();
    expect(again.table.crates.map((candidate) => candidate.id)).not.toContain(crate.id);
    expect(await second.claimCrate(again, crate.id)).toEqual([
      { status: 'rejected', reason: 'already_claimed' },
    ]);
    await second.player.client.call('cratesOpen', { body: { crateId: crate.id } });
    second.expectConserved();
  });

  it('refuses a re-claim of a won crate in the session it was won in', async () => {
    const tab = await Tab.open(page());
    const { state, crate } = await winFtueCrate(tab);
    expect(await tab.claimCrate(state, crate.id)).toEqual([
      { status: 'rejected', reason: 'already_claimed' },
    ]);
  });

  it('does not open a crate twice when the open landed just before the reload', async () => {
    const first = await Tab.open(page());
    const { crate } = await winFtueCrate(first);
    await first.player.client.call('cratesOpen', { body: { crateId: crate.id } });
    first.server.flush();
    const second = await Tab.open(page());
    const booted = await second.boot();
    expect(booted.table.crates.map((candidate) => candidate.id)).not.toContain(crate.id);
    await expect(
      second.player.client.call('cratesOpen', { body: { crateId: crate.id } }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('Demo persistence: a seeded page replays its crypto stream after a reload', () => {
  let stream = 0;
  const seeded = (array: Uint8Array) => {
    for (let i = 0; i < array.length; i++) {
      stream = (Math.imul(stream, 1_103_515_245) + 12_345) >>> 0;
      array[i] = stream >>> 24;
    }
    return array;
  };

  beforeEach(() => {
    stream = 7;
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(
      seeded as unknown as typeof crypto.getRandomValues,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('never repeats an entity id or a server seed from before the reload', async () => {
    const first = await Tab.open(page());
    await first.player.client.call('state');
    stream = 42;
    const firstBoot = await first.boot();
    stream = 99;
    await first.player.client.call('fairRotate', { body: {} });
    first.server.flush();

    stream = 7;
    const reloaded = page();
    const second = await Tab.open(reloaded);
    await second.player.client.call('state');
    stream = 42;
    const secondBoot = await second.boot();
    stream = 99;
    await second.player.client.call('fairRotate', { body: {} });
    stream = 99;
    await second.player.client.call('fairRotate', { body: {} });

    expect(session(secondBoot)).toBe(`${session(firstBoot)}001`);
    const ids = reloaded.world
      .serialize()
      .players.flatMap((player) => player.coins.map((record) => record.coin.id));
    expect(ids.length).toBeGreaterThan(MOCK_RULES.bufferSize);
    expect(new Set(ids).size).toBe(ids.length);
    const player = reloaded.world.player(second.id);
    if (player === undefined) throw new Error('No restored player.');
    const hashes = [
      player.fair.serverSeedHash,
      ...player.revealed.map((seed) => seed.serverSeedHash),
    ];
    expect(player.revealed).toHaveLength(3);
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});

describe('Demo persistence: feature state is saved in the same write as the ledger', () => {
  const book = {
    daily: ['daily-1', 'daily-2'],
    baselines: { 'daily-1': 12, 'daily-2': 0 },
    claimed: ['daily-1'],
    streak: { days: 3, lastAt: null },
  };

  function mockPlayer(tab: Tab) {
    const player = tab.server.world.player(tab.id);
    if (player === undefined) throw new Error('The mock world lost the player.');
    return player;
  }

  async function claimDaily(tab: Tab): Promise<void> {
    await tab.boot();
    tab.server.world.grant(
      mockPlayer(tab),
      time.now(),
      'quest.claim',
      { coins: 40, keys: 1 },
      'daily-1',
    );
    tab.server.world.setFeatureState('quests', book);
    await tab.player.client.call('state');
  }

  it('restores a claimed quest and the grant it paid together after a reload', async () => {
    const first = await Tab.open(page());
    await claimDaily(first);
    const paid = first.wallet();
    first.server.flush();
    expect(storedWorld().features).toEqual({ quests: book });

    const server = page();
    expect(server.restored).toBe(true);
    expect(server.world.featureState('quests')).toEqual(book);
    expect(server.world.featureState('season')).toBeUndefined();
    const grant = server.ledger().find((entry) => entry.reason === 'quest.claim');
    expect(grant).toMatchObject({
      playerId: first.id,
      delta: { coins: 40, keys: 1 },
      ref: 'daily-1',
    });
    const second = await Tab.open(server);
    const booted = await second.boot();
    expect(second.id).toBe(first.id);
    expect(booted.wallet).toEqual(paid);
    expect(server.world.featureState('quests')).toEqual(book);
    second.expectConserved();
  });

  it('loses both the quest claim and its grant when the save fails, never one without the other', async () => {
    const first = await Tab.open(page());
    await first.boot();
    first.server.flush();
    const before = storedWorld();
    expect(before.features).toEqual({});

    const failing = collectingPage();
    const tab = await Tab.open(failing);
    storage.failSet = true;
    await claimDaily(tab);
    failing.flush();
    expect(warnings).toEqual([expect.stringMatching(/could not be saved/)]);
    storage.failSet = false;

    const server = page();
    expect(server.world.featureState('quests')).toBeUndefined();
    expect(server.ledger().some((entry) => entry.reason === 'quest.claim')).toBe(false);
  });

  it('keeps a feature slot across reloads it is not touched in, and clears it when set to undefined', async () => {
    const first = await Tab.open(page());
    await claimDaily(first);
    first.server.flush();
    const again = await Tab.open(page());
    await again.boot();
    again.server.flush();
    expect(storedWorld().features).toEqual({ quests: book });

    again.server.world.setFeatureState('quests', undefined);
    await again.player.client.call('state');
    again.server.flush();
    expect(storedWorld().features).toEqual({});
    expect(page().world.featureState('quests')).toBeUndefined();
  });

  it('refuses a restore whose feature slot was edited into data JSON cannot hold', () => {
    const world = new MockWorld();
    world.setFeatureState('quests', book);
    const data = world.serialize();
    expect(() =>
      MockWorld.restore({ ...data, features: { quests: { score: Number.NaN } } }),
    ).toThrow(/feature quests state cannot be stored because quests\.score is NaN/);
  });
});

describe('MockWorld feature state', () => {
  it('reads back undefined for a feature that stored nothing', () => {
    expect(new MockWorld().featureState('quests')).toBeUndefined();
  });

  it('hands out copies, so a caller mutating what it read or wrote changes nothing stored', () => {
    const world = new MockWorld();
    const written = { claimed: ['daily-1'] };
    world.setFeatureState('quests', written);
    written.claimed.push('daily-2');
    const read = world.featureState('quests') as { claimed: string[] };
    read.claimed.push('daily-3');
    expect(world.featureState('quests')).toEqual({ claimed: ['daily-1'] });
    expect(world.serialize().features).toEqual({ quests: { claimed: ['daily-1'] } });
  });

  it('stores every kind of JSON value at the top level', () => {
    const world = new MockWorld();
    for (const value of [
      null,
      true,
      0,
      -1.5,
      '',
      'tier-3',
      [],
      [1, [2]],
      {},
      Object.create(null),
    ]) {
      world.setFeatureState('season', value);
      expect(world.featureState('season')).toEqual(value);
    }
  });

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const shared = { at: 1 };
  it.each([
    ['a function', () => 1, /quests is a function/],
    ['a bigint', 10n, /quests is bigint/],
    ['a symbol', Symbol('q'), /quests is symbol/],
    ['NaN', Number.NaN, /quests is NaN/],
    ['Infinity', { score: Number.POSITIVE_INFINITY }, /quests\.score is Infinity/],
    ['negative zero', [-0], /quests\[0\] is 0/],
    ['a nested undefined', { streak: undefined }, /quests\.streak is undefined/],
    ['an array hole', new Array<number>(2), /quests\[0\] is a hole/],
    ['a Date', { lastAt: new Date(0) }, /quests\.lastAt is a Date, not plain data/],
    ['a Map', new Map(), /quests is a Map, not plain data/],
    ['a cycle', cyclic, /quests\.self refers back to itself/],
    ['symbol keys', { [Symbol('k')]: 1 }, /quests has symbol keys/],
  ])('refuses %s, naming the feature and where', (_label, value, message) => {
    const world = new MockWorld();
    world.setFeatureState('quests', { kept: true });
    expect(() => {
      world.setFeatureState('quests', value);
    }).toThrow(message);
    expect(world.featureState('quests')).toEqual({ kept: true });
  });

  it('accepts the same object reached twice, which is not a cycle', () => {
    const world = new MockWorld();
    world.setFeatureState('quests', { a: shared, b: [shared] });
    expect(world.featureState('quests')).toEqual({ a: { at: 1 }, b: [{ at: 1 }] });
  });

  it.each(['', 'Quests', '__proto__', '1st', 'a'.repeat(65), 'has space'])(
    'refuses the feature id %j',
    (id) => {
      expect(() => {
        new MockWorld().setFeatureState(id, 1);
      }).toThrow(/is not a feature id/);
      expect(() => {
        new MockWorld().setFeatureState(id, undefined);
      }).toThrow(/is not a feature id/);
    },
  );
});

describe('Demo persistence: a bad blob or a broken storage falls back to a fresh session', () => {
  async function expectFresh(server: MockServer) {
    expect(server.restored).toBe(false);
    const tab = await Tab.open(server);
    await tab.boot();
    expect(server.ledger().every((entry) => entry.playerId === tab.id)).toBe(true);
    tab.expectConserved();
    return tab;
  }

  async function savedWorld(): Promise<string> {
    const tab = await Tab.open(page());
    await tab.boot();
    tab.server.flush();
    return storedBlob();
  }

  it('drops a blob that is not JSON, warns once and clears it', async () => {
    storage.items.set(DEMO_STORAGE_KEY, '{"schema":1,');
    await expectFresh(collectingPage());
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/not JSON/);
    expect(storage.items.has(DEMO_STORAGE_KEY)).toBe(false);
  });

  it('drops a blob of another save format', async () => {
    const blob = JSON.parse(await savedWorld()) as Record<string, unknown>;
    storage.items.set(
      DEMO_STORAGE_KEY,
      JSON.stringify({ ...blob, schema: DEMO_BLOB_SCHEMA_VERSION + 1 }),
    );
    await expectFresh(collectingPage());
    expect(warnings).toEqual([
      expect.stringContaining(
        `save format ${DEMO_BLOB_SCHEMA_VERSION + 1}, this build reads ${DEMO_BLOB_SCHEMA_VERSION}`,
      ),
    ]);
    expect(storage.items.has(DEMO_STORAGE_KEY)).toBe(false);
  });

  it('drops a save from before feature state was stored, rather than restoring a quest book that is gone', async () => {
    const blob = JSON.parse(await savedWorld()) as { world: Record<string, unknown> };
    const { features: _dropped, ...world } = blob.world;
    storage.items.set(DEMO_STORAGE_KEY, JSON.stringify({ ...blob, schema: 1, world }));
    await expectFresh(collectingPage());
    expect(warnings).toEqual([
      expect.stringContaining(`save format 1, this build reads ${DEMO_BLOB_SCHEMA_VERSION}`),
    ]);
    expect(storage.items.has(DEMO_STORAGE_KEY)).toBe(false);
  });

  it.each([
    ['missing', undefined, /world\.features/],
    ['an array', [{ claimed: ['daily-1'] }], /world\.features/],
    ['a string', 'quests', /world\.features/],
    ['null', null, /world\.features/],
    ['keyed by a non-feature id', { __proto__x: 1, 'Not An Id': {} }, /world\.features/],
  ])(
    'drops a blob whose features slot is %s, naming it as the reason',
    async (_label, features, where) => {
      const blob = JSON.parse(await savedWorld()) as { world: Record<string, unknown> };
      blob.world.features = features;
      storage.items.set(DEMO_STORAGE_KEY, JSON.stringify(blob));
      await expectFresh(collectingPage());
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/shape is invalid/);
      expect(warnings[0]).toMatch(where);
      expect(storage.items.has(DEMO_STORAGE_KEY)).toBe(false);
    },
  );

  it('drops a blob whose feature slot carries a __proto__ key, never polluting a prototype', async () => {
    const raw = await savedWorld();
    storage.items.set(
      DEMO_STORAGE_KEY,
      raw.replace('"features":{}', '"features":{"quests":{"__proto__":{"polluted":true}}}'),
    );
    await expectFresh(collectingPage());
    expect(warnings).toEqual([expect.stringMatching(/feature quests state .*__proto__ key/)]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('drops a blob written by another sim snapshot version', async () => {
    const blob = JSON.parse(await savedWorld()) as Record<string, unknown>;
    storage.items.set(DEMO_STORAGE_KEY, JSON.stringify({ ...blob, sim: SIM_SNAPSHOT_VERSION + 1 }));
    await expectFresh(collectingPage());
    expect(warnings).toEqual([expect.stringMatching(/sim snapshot version/)]);
  });

  it('drops a blob of the right version but the wrong shape, naming where', async () => {
    const blob = JSON.parse(await savedWorld()) as { world: { players: { wallet: object }[] } };
    const [player] = blob.world.players;
    if (player === undefined) throw new Error('No stored player.');
    player.wallet = { ...player.wallet, coins: 'lots' };
    storage.items.set(DEMO_STORAGE_KEY, JSON.stringify(blob));
    await expectFresh(collectingPage());
    expect(warnings).toEqual([
      expect.stringMatching(/shape is invalid at world\.players\.0\.wallet/),
    ]);
  });

  it('refuses a blob whose edited wallet the ledger does not add up to', async () => {
    const blob = JSON.parse(await savedWorld()) as {
      world: { players: { wallet: { coins: number } }[] };
    };
    const [player] = blob.world.players;
    if (player === undefined) throw new Error('No stored player.');
    player.wallet.coins += 1_000_000;
    storage.items.set(DEMO_STORAGE_KEY, JSON.stringify(blob));
    await expectFresh(collectingPage());
    expect(warnings).toEqual([expect.stringMatching(/ledger adds up to/)]);
    expect(storage.items.has(DEMO_STORAGE_KEY)).toBe(false);
  });

  it('refuses a blob whose ledger was reordered', async () => {
    const blob = JSON.parse(await savedWorld()) as { world: { ledger: unknown[] } };
    blob.world.ledger.reverse();
    storage.items.set(DEMO_STORAGE_KEY, JSON.stringify(blob));
    await expectFresh(collectingPage());
    expect(warnings).toEqual([expect.stringMatching(/out of sequence/)]);
  });

  it('plays from memory when reading storage throws', async () => {
    storage.items.set(DEMO_STORAGE_KEY, await savedWorld());
    storage.failGet = true;
    await expectFresh(collectingPage());
    expect(warnings).toEqual([expect.stringMatching(/could not be read/)]);
  });

  it('warns once per run of failed writes and recovers when storage frees up', async () => {
    storage.failSet = true;
    const server = collectingPage();
    const tab = await expectFresh(server);
    server.flush();
    await tab.player.client.call('state');
    server.flush();
    expect(warnings).toHaveLength(1);
    storage.failSet = false;
    server.flush();
    expect(storedWorld().players.map((player) => player.id)).toEqual([tab.id]);
    storage.failSet = true;
    await tab.player.client.call('state');
    server.flush();
    expect(warnings).toHaveLength(2);
  });

  it('still boots when the dropped blob cannot be cleared', async () => {
    storage.items.set(DEMO_STORAGE_KEY, 'garbage');
    storage.failRemove = true;
    await expectFresh(collectingPage());
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toMatch(/could not be cleared/);
  });
});
