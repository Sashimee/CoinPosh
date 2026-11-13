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

  it('defers a flush asked for mid-request until the request has finished', async () => {
    const lifecycle = new EventTarget();
    let hideMidRequest = false;
    let writesDuring: number | null = null;
    const now = () => {
      if (hideMidRequest) {
        hideMidRequest = false;
        lifecycle.dispatchEvent(new Event('pagehide'));
        writesDuring = storage.writes;
      }
      return time.now();
    };
    const tab = await Tab.open(page({ now, lifecycle, persistDelayMs: 60_000 }));
    await tab.player.client.call('state');
    const writesBefore = storage.writes;
    hideMidRequest = true;
    const booted = await tab.player.client.call('state', { query: { hydrate: 'boot' } });
    expect(writesDuring).toBe(writesBefore);
    expect(storage.writes).toBe(writesBefore + 1);
    expect(storedWorld().players[0]?.tableSession).toBe(session(booted));
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
    expect(warnings).toEqual([expect.stringMatching(/save format 2, this build reads 1/)]);
    expect(storage.items.has(DEMO_STORAGE_KEY)).toBe(false);
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
