import { crateSpawn } from '@coinposh/economy';
import type { DropResponse, PoseTuple, StateResponse, TableSessionId } from '@coinposh/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiRequestError } from '../errors.ts';
import { newIdempotencyKey } from '../request.ts';
import { contractGrid } from '../contract/tableSnapshot.contract.ts';
import {
  FakeTime,
  connectPlayer,
  createMockServer,
  ledgerWallet,
  requirePlayerId,
  serverWallet,
  type Player,
} from '../test/harness.ts';
import type { MockServer } from './server.ts';

let time: FakeTime;
let server: MockServer;
let alice: Player;
/** Server time when the page's sim last started counting from tick 0. */
let simStartedAt: number;

beforeEach(async () => {
  time = new FakeTime();
  server = createMockServer({ now: time.now });
  alice = await connectPlayer(server, time);
});

function simTick(): number {
  return Math.floor(((time.now() - simStartedAt) / 1000) * 60);
}

async function boot(): Promise<StateResponse> {
  const state = await alice.client.call('state', { query: { hydrate: 'boot' } });
  simStartedAt = time.now();
  return state;
}

function session(state: StateResponse): TableSessionId {
  const id = state.table.session;
  if (id === undefined) throw new Error('The mock state named no table session.');
  return id;
}

async function dropBuffered(state: StateResponse, count: number): Promise<DropResponse[]> {
  let buffer = state.table.buffer;
  const drops: DropResponse[] = [];
  for (let i = 0; i < count; i++) {
    const coin = buffer[0];
    if (coin === undefined) throw new Error('The buffer ran dry.');
    time.advance(100);
    const response = await alice.client.call('tableDrop', {
      body: { session: session(state), x: 0, tick: simTick(), coinId: coin.id },
    });
    buffer = response.buffer;
    drops.push(response);
  }
  return drops;
}

function entries(reason: string) {
  const id = requirePlayerId(alice);
  return server.ledger().filter((entry) => entry.playerId === id && entry.reason === reason);
}

function wallet() {
  return serverWallet(server, requirePlayerId(alice));
}

function expectConserved(): void {
  const id = requirePlayerId(alice);
  expect(ledgerWallet(server, id)).toEqual(serverWallet(server, id));
}

describe('Demo Mode boot (hydrate=boot)', () => {
  it('starts a new table session on every boot and lays the opening heap at its slots', async () => {
    const first = await boot();
    const second = await boot();
    expect(session(second)).not.toBe(session(first));
    expect(second.table.layout?.coins.every((placement) => placement.kind === 'heapSlot')).toBe(
      true,
    );
  });

  it('refunds each unposed dropped coin at most what was paid, once, and stays conserved', async () => {
    const state = await boot();
    const before = wallet().coins;
    const drops = await dropBuffered(state, 5);
    const after = await boot();
    const refunds = entries('refund.table');
    expect(refunds.map((entry) => entry.ref).sort()).toEqual(
      drops.map((drop) => drop.coin.id).sort(),
    );
    for (const entry of refunds) {
      const drop = drops.find((candidate) => candidate.coin.id === entry.ref);
      expect(entry.delta.coins).toBeLessThanOrEqual(drop?.coin.value ?? 0);
    }
    expect(after.table.coins.map((coin) => coin.id)).toEqual(
      state.table.coins.map((coin) => coin.id),
    );
    expect(wallet().coins).toBe(before);
    await boot();
    expect(entries('refund.table')).toHaveLength(refunds.length);
    expectConserved();
  });

  it('lays a posed dropped coin where it rested and refunds nothing for it', async () => {
    const state = await boot();
    const [drop] = await dropBuffered(state, 1);
    if (drop === undefined) throw new Error('No drop.');
    time.advance(1_000);
    await alice.client.snapshot(
      {
        session: session(state),
        seq: 1,
        tick: simTick(),
        pusher: { tickInCycle: 0 },
        coins: contractGrid([drop.coin.id]),
        crates: [],
      },
      { idempotencyKey: newIdempotencyKey() },
    );
    const after = await boot();
    const index = after.table.coins.findIndex((coin) => coin.id === drop.coin.id);
    expect(after.table.layout?.coins[index]).toEqual({
      kind: 'pose',
      pose: contractGrid([drop.coin.id])[0],
    });
    expect(entries('refund.table')).toEqual([]);
    expectConserved();
  });

  it('stores only poses a boot lays together, so it refunds no coin the snapshot posed', async () => {
    const state = await boot();
    const [first, second] = await dropBuffered(state, 2);
    if (first === undefined || second === undefined) throw new Error('No drops.');
    const [atFirst, atSecond] = contractGrid([first.coin.id, second.coin.id]);
    if (atFirst === undefined || atSecond === undefined) throw new Error('No grid poses.');
    const upload = async (seq: number, coins: PoseTuple[]) => {
      time.advance(1_000);
      await alice.client.snapshot(
        {
          session: session(state),
          seq,
          tick: simTick(),
          pusher: { tickInCycle: 0 },
          coins,
          crates: [],
        },
        { idempotencyKey: newIdempotencyKey() },
      );
    };
    await upload(1, [atFirst, atSecond]);
    // The second coin left out of the next sample keeps its last pose, where the first now rests.
    await upload(2, [[first.coin.id, ...atSecond.slice(1)] as PoseTuple]);
    const posed = new Set<string>(
      server.world.player(requirePlayerId(alice))?.tableSnapshot?.poses.map((pose) => pose[0]),
    );
    await boot();
    const refunded = entries('refund.table').map((entry) => entry.ref);
    expect(refunded.filter((ref) => ref !== null && posed.has(ref))).toEqual([]);
    expect(posed.has(first.coin.id)).toBe(true);
    expectConserved();
  });

  it('farms no crates or stars by dropping, rebooting for a refund and dropping again', async () => {
    let state = await boot();
    const first = await dropBuffered(state, crateSpawn.ftueScriptedDrop);
    expect(first.flatMap((drop) => drop.spawnedCrates)).toHaveLength(1);
    const stars = entries('season.drops').length;
    for (let round = 0; round < 3; round++) {
      state = await boot();
      const again = await dropBuffered(state, crateSpawn.ftueScriptedDrop);
      expect(again.flatMap((drop) => drop.spawnedCrates)).toEqual([]);
    }
    expect(entries('season.drops')).toHaveLength(stars);
    expectConserved();
  });

  it('keeps the drop spacing across a boot, so a reload cannot reset the rate envelope', async () => {
    const state = await boot();
    await dropBuffered(state, 1);
    const rebooted = await boot();
    const coin = rebooted.table.buffer[0];
    if (coin === undefined) throw new Error('The buffer is empty.');
    const tooSoon = alice.client.call('tableDrop', {
      body: { session: session(rebooted), x: 0, tick: simTick(), coinId: coin.id },
    });
    await expect(tooSoon).rejects.toBeInstanceOf(ApiRequestError);
    await expect(tooSoon).rejects.toMatchObject({ code: 'bad_request' });
    time.advance(100);
    const later = await alice.client.call('tableDrop', {
      body: { session: session(rebooted), x: 0, tick: simTick(), coinId: coin.id },
    });
    expect(later.coin.id).toBe(coin.id);
  });

  it('starts Demo Mode afresh on reload: a new mock server knows nothing of the old player', async () => {
    const state = await boot();
    await dropBuffered(state, 2);
    const reloaded = createMockServer({ now: time.now });
    const fresh = await connectPlayer(reloaded, time);
    await fresh.client.call('state');
    expect(requirePlayerId(fresh)).not.toBe(requirePlayerId(alice));
    expect(reloaded.ledger().every((entry) => entry.playerId === requirePlayerId(fresh))).toBe(
      true,
    );
  });
});
