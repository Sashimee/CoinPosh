import type { CoinId, DropResponse, StateResponse, TableSessionId } from '@coinposh/shared';
import { POSITION_UNIT, SIM_SNAPSHOT_VERSION } from '@coinposh/sim/snapshot';
import { beforeEach, describe, expect, it } from 'vitest';
import { contractGrid } from '../../net/contract/tableSnapshot.contract.ts';
import { ApiRequestError } from '../../net/errors.ts';
import { createNet } from '../../net/index.ts';
import type { MockServer } from '../../net/mock/server.ts';
import { newIdempotencyKey } from '../../net/request.ts';
import { memoryStore } from '../../net/store.ts';
import {
  FakeTime,
  connectPlayer,
  createMockServer,
  ledgerWallet,
  requirePlayerId,
  serverWallet,
  type Player,
} from '../../net/test/harness.ts';
import type { SimBridgeSnapshot } from '../simWorker/index.ts';
import { createDemoHandle, type DemoHandle, type DemoHandleDeps } from './demoHandle.ts';

let time: FakeTime;
let server: MockServer;
let page: Player;
let simStartedAt: number;
let state: StateResponse;
let superseded: boolean;
let retakes: number;

function simTick(): number {
  return Math.floor(((time.now() - simStartedAt) / 1000) * 60);
}

function session(of: StateResponse): TableSessionId {
  const id = of.table.session;
  if (id === undefined) throw new Error('The mock state named no table session.');
  return id;
}

/** This page's own boot, as "Play here" runs it: the sim counts from tick 0 again. */
async function pageBoot(): Promise<void> {
  retakes += 1;
  state = await page.client.call('state', { query: { hydrate: 'boot' } });
  simStartedAt = time.now();
  superseded = false;
}

async function drop(count: number): Promise<DropResponse[]> {
  const drops: DropResponse[] = [];
  let buffer = state.table.buffer;
  for (let i = 0; i < count; i++) {
    const coin = buffer[0];
    if (coin === undefined) throw new Error('The buffer ran dry.');
    time.advance(100);
    const response = await page.client.call('tableDrop', {
      body: { session: session(state), x: 0, tick: simTick(), coinId: coin.id },
    });
    buffer = response.buffer;
    drops.push(response);
  }
  return drops;
}

async function upload(seq: number, ids: readonly CoinId[]): Promise<void> {
  time.advance(1_000);
  await page.client.snapshot(
    {
      session: session(state),
      seq,
      tick: simTick(),
      pusher: { tickInCycle: 0 },
      coins: contractGrid(ids),
      crates: [],
    },
    { idempotencyKey: newIdempotencyKey() },
  );
}

function handle(overrides: Partial<DemoHandleDeps> = {}): DemoHandle {
  return createDemoHandle({
    mock: server,
    player: () => page.session.playerId,
    retake: pageBoot,
    superseded: () => superseded,
    sample: () => Promise.reject(new Error('This test samples no sim.')),
    coinOf: () => null,
    ...overrides,
  });
}

beforeEach(async () => {
  time = new FakeTime();
  server = createMockServer({ now: time.now, storage: null });
  page = await connectPlayer(server, time);
  superseded = false;
  retakes = 0;
  await pageBoot();
  retakes = 0;
});

describe('demo handle: snapshots()', () => {
  it('reports the boot layout as seq 0 before any upload, with none accepted', () => {
    const { accepted, last } = handle().snapshots();
    expect(accepted).toBe(0);
    expect(last).toMatchObject({ seq: 0, tick: 0, crates: [] });
  });

  it('counts each accepted upload and returns the stored poses', async () => {
    const demo = handle();
    const [first, second] = await drop(2);
    if (first === undefined || second === undefined) throw new Error('No drops.');
    await upload(1, [first.coin.id]);
    await upload(2, [first.coin.id, second.coin.id]);
    const { accepted, last } = demo.snapshots();
    expect(accepted).toBe(2);
    expect(last?.seq).toBe(2);
    expect(last?.coins.map((pose) => pose[0]).sort()).toEqual(
      [first.coin.id, second.coin.id].sort(),
    );
    expect(last?.coins.find((pose) => pose[0] === first.coin.id)).toEqual(
      contractGrid([first.coin.id, second.coin.id])[0],
    );
  });

  it('does not count a refused upload', async () => {
    const [first] = await drop(1);
    if (first === undefined) throw new Error('No drop.');
    await upload(1, [first.coin.id]);
    await expect(upload(1, [first.coin.id])).rejects.toBeInstanceOf(ApiRequestError);
    expect(handle().snapshots().accepted).toBe(1);
  });

  it('hands out copies, so a caller cannot rewrite what the mock stores', async () => {
    const [first] = await drop(1);
    if (first === undefined) throw new Error('No drop.');
    await upload(1, [first.coin.id]);
    const demo = handle();
    const pose = demo.snapshots().last?.coins[0];
    if (pose === undefined) throw new Error('No stored pose.');
    pose[1] = 999_999;
    expect(demo.snapshots().last?.coins[0]?.[1]).not.toBe(999_999);
  });
});

describe('demo handle: refunds() and wallet()', () => {
  it('reads zero refunds and the mock wallet after a re-boot that laid every posed coin', async () => {
    const demo = handle();
    const drops = await drop(3);
    await upload(
      1,
      drops.map((entry) => entry.coin.id),
    );
    const before = demo.wallet();
    await demo.reboot();
    expect(demo.refunds()).toBe(0);
    expect(demo.wallet()).toEqual(before);
    expect(demo.wallet()).toEqual(serverWallet(server, requirePlayerId(page)));
  });

  it('counts one boot refund per dropped coin the boot could not lay', async () => {
    const demo = handle();
    await drop(2);
    await demo.reboot();
    expect(demo.refunds()).toBe(2);
    const id = requirePlayerId(page);
    expect(ledgerWallet(server, id)).toEqual(serverWallet(server, id));
  });
});

describe('demo handle: reboot()', () => {
  it('runs the "Play here" retake once per call and shares a reboot already under way', async () => {
    let finish: () => void = () => undefined;
    const demo = handle({
      retake: () => {
        retakes += 1;
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
    });
    const first = demo.reboot();
    const second = demo.reboot();
    expect(second).toBe(first);
    expect(retakes).toBe(1);
    finish();
    await first;
    const third = demo.reboot();
    expect(retakes).toBe(2);
    finish();
    await third;
  });

  it('starts a fresh table session the page plays on', async () => {
    const before = session(state);
    await handle().reboot();
    expect(session(state)).not.toBe(before);
    await expect(drop(1)).resolves.toHaveLength(1);
  });

  it('refuses while the table is open elsewhere, leaving "Play here" to take it back', async () => {
    superseded = true;
    await expect(handle().reboot()).rejects.toThrow(/Play here/);
    expect(retakes).toBe(0);
  });

  it('lets a failed retake be retried', async () => {
    let fail = true;
    const demo = handle({
      retake: async () => {
        if (fail) throw new Error('The sim would not start.');
        await pageBoot();
      },
    });
    await expect(demo.reboot()).rejects.toThrow('The sim would not start.');
    fail = false;
    await expect(demo.reboot()).resolves.toBeUndefined();
  });
});

describe('demo handle: bootElsewhere()', () => {
  it("supersedes this page's table session, so its next drop and upload are refused", async () => {
    const demo = handle();
    const [first] = await drop(1);
    if (first === undefined) throw new Error('No drop.');
    await demo.bootElsewhere();
    const wallet = demo.wallet();
    const ledger = server.ledger().length;
    const refusedDrop = await drop(1).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refusedDrop).toBeInstanceOf(ApiRequestError);
    expect((refusedDrop as ApiRequestError).code).toBe('session_superseded');
    const refusedUpload = await upload(1, [first.coin.id]).then(
      () => null,
      (error: unknown) => error,
    );
    expect((refusedUpload as ApiRequestError).code).toBe('session_superseded');
    expect(demo.wallet()).toEqual(wallet);
    expect(server.ledger()).toHaveLength(ledger);
    expect(retakes).toBe(0);
  });

  it('starts a fresh table session on every call', async () => {
    const demo = handle();
    await demo.bootElsewhere();
    const once = server.world.player(requirePlayerId(page))?.tableSession;
    await demo.bootElsewhere();
    const twice = server.world.player(requirePlayerId(page))?.tableSession;
    expect(once).not.toBe(session(state));
    expect(twice).not.toBe(once);
  });

  it('says to wait for play when the page has not signed in', async () => {
    await expect(handle({ player: () => null }).bootElsewhere()).rejects.toThrow(
      /has not signed in/,
    );
  });

  it('leaves the table to a reboot afterwards', async () => {
    const demo = handle();
    await demo.bootElsewhere();
    await demo.reboot();
    const [first] = await drop(1);
    if (first === undefined) throw new Error('No drop.');
    await expect(upload(1, [first.coin.id])).resolves.toBeUndefined();
    expect(demo.snapshots().accepted).toBe(1);
  });
});

describe('demo handle: poses()', () => {
  it('names each sim coin by the server coin it stands for and skips the ones it no longer holds', async () => {
    const sample: SimBridgeSnapshot = {
      tick: 120,
      table: {
        version: SIM_SNAPSHOT_VERSION,
        pusherTickInCycle: 0,
        coins: [
          { id: 1, p: [100, 200, -300], q: [0, 0, 0, 10_000], rest: 'asleep' },
          { id: 2, p: [5, 6, 7], q: [0, 0, 0, 10_000], rest: 'asleep' },
        ],
      },
    };
    const demo = handle({
      sample: () => Promise.resolve(sample),
      coinOf: (simId) => (simId === 1 ? ('coin_one' as CoinId) : null),
    });
    await expect(demo.poses()).resolves.toEqual([{ id: 'coin_one', x: 100, y: 200, z: -300 }]);
    expect(demo.positionUnit).toBe(POSITION_UNIT);
  });
});

describe('demo handle: before sign-in', () => {
  it('says to wait for play instead of reading another player', () => {
    const demo = handle({ player: () => null });
    expect(() => demo.snapshots()).toThrow(/has not signed in/);
    expect(() => demo.refunds()).toThrow(/has not signed in/);
  });
});

describe('demo handle against createNet', () => {
  it("boots the Demo player elsewhere and TableSync marks this page's table superseded", async () => {
    const net = await createNet({
      mode: { kind: 'demo' },
      locale: () => 'en',
      turnstileToken: () => Promise.reject(new Error('No Turnstile in Demo Mode.')),
      onError: () => undefined,
      store: memoryStore(),
    });
    const mock = net.mock;
    if (mock === null) throw new Error('Demo Mode built no mock.');
    const booted = await net.client.call('state', { query: { hydrate: 'boot' } });
    net.table.hydrate(booted);
    const events: string[] = [];
    net.table.subscribe((event) => events.push(event.type));
    const demo = createDemoHandle({
      mock,
      player: () => net.session.playerId,
      retake: () => Promise.resolve(),
      superseded: () => net.table.superseded,
      sample: () => Promise.reject(new Error('No sim here.')),
      coinOf: () => null,
    });
    await demo.bootElsewhere();
    expect(
      net.table.snapshot({
        tick: 0,
        pusher: { tickInCycle: 0 },
        coins: contractGrid(booted.table.coins.map((coin) => coin.id)),
        crates: [],
      }),
    ).toBe(true);
    await net.table.flush();
    expect(net.table.superseded).toBe(true);
    expect(events).toContain('sessionSuperseded');
    net.table.close();
  });
});
