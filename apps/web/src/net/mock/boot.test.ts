import { crateSpawn } from '@coinposh/economy';
import type {
  Claim,
  DropResponse,
  PlayerId,
  PoseTuple,
  StateResponse,
  TableSessionId,
} from '@coinposh/shared';
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
import { MOCK_RULES } from './rules.ts';
import type { MockServer } from './server.ts';
import { MockWorld } from './world.ts';

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

/** Uploads a settled snapshot that poses none of the table coins, as one taken mid-fall would. */
async function settleUnposed(state: StateResponse): Promise<void> {
  time.advance(2_000);
  await alice.client.snapshot(
    {
      session: session(state),
      seq: 1,
      tick: simTick(),
      pusher: { tickInCycle: 0 },
      coins: [],
      crates: [],
    },
    { idempotencyKey: newIdempotencyKey() },
  );
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
    await settleUnposed(state);
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

  it('lays coins dropped since the last snapshot back in the drop chute, paid for and not refunded', async () => {
    const state = await boot();
    const drops = await dropBuffered(state, 4);
    const paid = wallet();
    const after = await boot();
    const dropped = drops.map((drop) => drop.coin.id);
    expect(after.table.coins.map((coin) => coin.id)).toEqual(expect.arrayContaining(dropped));
    const placements = dropped.map(
      (id) => after.table.layout?.coins[after.table.coins.findIndex((coin) => coin.id === id)],
    );
    const poses = placements.map((placement) =>
      placement?.kind === 'pose' ? placement.pose : null,
    );
    expect(poses.map((pose) => pose?.[0])).toEqual(dropped);
    expect(new Set(poses.map((pose) => pose?.slice(1, 4).join())).size).toBe(dropped.length);
    expect(entries('refund.table')).toEqual([]);
    expect(wallet()).toEqual(paid);

    const again = await boot();
    expect(again.table.coins.map((coin) => coin.id)).toEqual(expect.arrayContaining(dropped));
    expect(entries('refund.table')).toEqual([]);
    expectConserved();
  });

  it('relays a coin dropped on the first tick after the boot, its own snapshot tick', async () => {
    const state = await boot();
    const coin = state.table.buffer[0];
    if (coin === undefined) throw new Error('The buffer is empty.');
    time.advance(100);
    await alice.client.call('tableDrop', {
      body: { session: session(state), x: 0, tick: 0, coinId: coin.id },
    });
    const after = await boot();
    expect(after.table.coins.map((onTable) => onTable.id)).toContain(coin.id);
    expect(entries('refund.table')).toEqual([]);
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

  it('writes the ledger entry for an unposed coin it takes back even when nothing was paid', async () => {
    const state = await boot();
    const [a, b, c] = state.table.coins;
    if (a === undefined || b === undefined || c === undefined) throw new Error('No opening heap.');
    time.advance(MOCK_RULES.minFusionMsAfterSpawn);
    const { results } = await alice.client.call('tableClaims', {
      body: { claims: [{ kind: 'fusion', coinIds: [a.id, b.id, c.id], tick: simTick() }] },
    });
    const fused = results[0]?.status === 'accepted' ? results[0].minted : null;
    if (fused === null) throw new Error('The heap coins did not fuse.');
    const before = wallet().coins;
    const after = await boot();
    expect(after.table.coins.map((coin) => coin.id)).not.toContain(fused.id);
    const refunds = entries('refund.table');
    expect(refunds.map((entry) => entry.ref)).toEqual([fused.id]);
    expect(refunds[0]?.delta.coins ?? 0).toBe(0);
    expect(wallet().coins).toBe(before);
    expectConserved();
  });

  it('farms no crates or stars by dropping, rebooting for a refund and dropping again', async () => {
    let state = await boot();
    const first = await dropBuffered(state, crateSpawn.ftueScriptedDrop);
    expect(first.flatMap((drop) => drop.spawnedCrates)).toHaveLength(1);
    const stars = entries('season.drops').length;
    for (let round = 0; round < 3; round++) {
      await settleUnposed(state);
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

  it('re-boots with a quest claim and its grant intact, and carries both through serialize and restore', async () => {
    const state = await boot();
    const drops = await dropBuffered(state, 3);
    await settleUnposed(state);
    const player = server.world.player(requirePlayerId(alice));
    if (player === undefined) throw new Error('The mock world lost alice.');
    server.world.grant(player, time.now(), 'season.tier', { pearls: 2 }, 'tier-1');
    const book = { paidTiers: ['tier-1'], streak: { days: 1 } };
    server.world.setFeatureState('season', book);
    const paid = wallet();

    await boot();
    expect(entries('refund.table')).toHaveLength(drops.length);
    expect(entries('season.tier')).toEqual([
      expect.objectContaining({ delta: { pearls: 2 }, ref: 'tier-1' }),
    ]);
    expect(wallet().pearls).toBe(paid.pearls);
    expect(server.world.featureState('season')).toEqual(book);
    expectConserved();

    const restored = MockWorld.restore(server.world.serialize());
    expect(restored.featureState('season')).toEqual(book);
    expect(restored.ledger).toEqual(server.world.ledger);
    expect(restored.player(requirePlayerId(alice))?.wallet).toEqual(wallet());
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

describe('Demo Mode table lease (bootElsewhere)', () => {
  async function refusal(run: Promise<unknown>): Promise<string | null> {
    return run.then(
      () => null,
      (error: unknown) => (error instanceof ApiRequestError ? error.code : String(error)),
    );
  }

  it('refuses a drop from the session a second tab replaced, and moves no value', async () => {
    const state = await boot();
    await dropBuffered(state, 1);
    await server.bootElsewhere(requirePlayerId(alice));
    const before = wallet();
    const ledger = server.ledger().length;
    await expect(refusal(dropBuffered(state, 1))).resolves.toBe('session_superseded');
    time.advance(100);
    await expect(
      refusal(
        alice.client.call('tableDrop', {
          body: { session: session(state), x: 0, tick: simTick() },
        }),
      ),
    ).resolves.toBe('session_superseded');
    expect(wallet()).toEqual(before);
    expect(server.ledger()).toHaveLength(ledger);
    expectConserved();
  });

  it('refuses a claim from the replaced session and pays it to the new one', async () => {
    const state = await boot();
    const [a, b, c] = state.table.coins;
    if (a === undefined || b === undefined || c === undefined) throw new Error('No opening heap.');
    await server.bootElsewhere(requirePlayerId(alice));
    const current = server.world.player(requirePlayerId(alice))?.tableSession;
    if (current === null || current === undefined) throw new Error('The boot left no session.');
    expect(current).not.toBe(session(state));
    time.advance(MOCK_RULES.minFusionMsAfterSpawn);
    const claims: Claim[] = [{ kind: 'fusion', coinIds: [a.id, b.id, c.id], tick: simTick() }];
    const before = wallet();
    const ledger = server.ledger().length;
    await expect(
      refusal(alice.client.call('tableClaims', { body: { session: session(state), claims } })),
    ).resolves.toBe('session_superseded');
    expect(wallet()).toEqual(before);
    expect(server.ledger()).toHaveLength(ledger);
    const { results } = await alice.client.call('tableClaims', {
      body: { session: current, claims },
    });
    expect(results[0]?.status).toBe('accepted');
    expectConserved();
  });

  it('starts a new table session on every call', async () => {
    const state = await boot();
    await server.bootElsewhere(requirePlayerId(alice));
    const once = server.world.player(requirePlayerId(alice))?.tableSession;
    await server.bootElsewhere(requirePlayerId(alice));
    expect(once).not.toBe(session(state));
    expect(server.world.player(requirePlayerId(alice))?.tableSession).not.toBe(once);
  });

  it('rejects an unknown player and keeps serving requests after it', async () => {
    const state = await boot();
    await expect(server.bootElsewhere('p_nobody' as PlayerId)).rejects.toThrow(/no player/);
    await expect(dropBuffered(state, 1)).resolves.toHaveLength(1);
  });
});
