import { coinTiers, openingHeap, upgradeLines, upgradeStat } from '@coinposh/economy';
import { endpoints, PlayerIdSchema, type MintedCoin } from '@coinposh/shared';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { guestSignIn, newIdempotencyKey, newSession, type Session } from '../test/client.ts';
import {
  claims,
  dropAsClient,
  expectConserved,
  playerStub,
  reload,
  state,
  vaultCoins,
} from '../test/game.ts';
import { Entities, mintedValue } from './entities.ts';
import { commit, LedgerTx, openWallet } from './ledger.ts';
import { PREMINT_BUFFER_TARGET, type PlayerDO } from './PlayerDO.ts';

const HEAP_VALUE = mintedValue(openingHeap.tier, {});
const COPPER = coinTiers[0];

function startingCoins(): number {
  const line = upgradeLines.find((candidate) => candidate.effect.stat === 'startingCoins');
  if (line === undefined) throw new Error('No startingCoins line in economy config.');
  return upgradeStat(line, 0);
}

function fall(coin: { readonly id: string }, edge: 'front' | 'left' | 'right' = 'front', tick = 0) {
  return { kind: 'fall', coinId: coin.id, tick, edge };
}

async function heapOf(session: Session): Promise<MintedCoin[]> {
  const heap = (await state(session)).table.coins;
  expect(heap).toHaveLength(openingHeap.coins);
  return heap;
}

function heapGrants(stub: DurableObjectStub<PlayerDO>) {
  return runInDurableObject(stub, (_instance: PlayerDO, ctx) =>
    ctx.storage.sql
      .exec<{ tx_id: string; account: string; delta: number }>(
        "SELECT tx_id, account, delta FROM ledger WHERE kind = 'grant.heap'",
      )
      .toArray(),
  );
}

/**
 * A player stored the way sign-up worked before the server seeded the heap: the starting
 * grant, an unpaid buffer of `unpaidBuffer` reservations, and `stranded` copper drops the
 * wallet paid for still on the table.
 */
async function legacyPlayer(options: {
  unpaidBuffer: number;
  walletCoins: number;
  drops: number;
  stranded?: number;
}) {
  const playerId = PlayerIdSchema.parse(crypto.randomUUID());
  const stub = env.PLAYER.get(env.PLAYER.idFromName(playerId));
  await runInDurableObject(stub, (_instance: PlayerDO, ctx) => {
    const sql = ctx.storage.sql;
    const meta = {
      player_id: playerId,
      display_name: 'LEGC',
      locale: 'en',
      created_at: '0',
      drop_count: String(options.drops),
      flushed_seq: '0',
      fair_server_seed: '00'.repeat(32),
      fair_server_seed_hash: 'ab'.repeat(32),
      fair_client_seed: 'legacyclientseed',
      fair_nonce: '0',
      mint_carry: '0',
    };
    for (const [key, value] of Object.entries(meta)) {
      sql.exec('INSERT INTO meta (key, value) VALUES (?, ?)', key, value);
    }
    openWallet(sql);
    commit(
      sql,
      new LedgerTx('grant.starting').move('mint', 'wallet', 'coins', options.walletCoins, null),
      { at: 0, idempotencyKey: null },
    );
    const entities = new Entities(sql);
    for (let i = 0; i < options.unpaidBuffer; i++) {
      entities.mintCoin(COPPER.id, mintedValue(COPPER.id, {}), null, 'buffer', null, 0);
    }
    for (let i = 0; i < (options.stranded ?? 0); i++) {
      const coin = entities.mintCoin(COPPER.id, mintedValue(COPPER.id, {}), null, 'table', i, 0);
      commit(
        sql,
        new LedgerTx('drop.mint')
          .move('wallet', 'table', 'coins', COPPER.value, coin.id)
          .move('mint', 'table', 'coins', coin.value - COPPER.value, coin.id),
        { at: 0, idempotencyKey: null },
      );
    }
  });
  return stub;
}

describe('opening heap', () => {
  it('is minted once at sign-up, staked by the house and not by the wallet', async () => {
    const session = await newSession();
    const heap = await heapOf(session);
    expect(new Set(heap.map((coin) => coin.id)).size).toBe(openingHeap.coins);
    for (const coin of heap) {
      expect(coin).toEqual({ id: coin.id, tier: openingHeap.tier, value: HEAP_VALUE });
    }

    const stub = playerStub(session.tokens.playerId);
    const legs = await heapGrants(stub);
    expect(new Set(legs.map((leg) => leg.tx_id)).size).toBe(1);
    const house = legs.filter((leg) => leg.account === 'house');
    const table = legs.filter((leg) => leg.account === 'table');
    expect(house).toHaveLength(openingHeap.coins);
    expect(table).toHaveLength(openingHeap.coins);
    expect(house.every((leg) => leg.delta === -HEAP_VALUE)).toBe(true);

    const report = await stub.conservation();
    expect(report.ledger.house).toBe(-openingHeap.coins * HEAP_VALUE);
    expect(report.tableValue).toBe(openingHeap.coins * HEAP_VALUE);
    expect(await vaultCoins(session)).toBe(startingCoins());
    await expectConserved(session);
  });

  it('is not minted again by later hydrations or a second sign-in on the same device', async () => {
    const session = await newSession();
    const first = await heapOf(session);
    const again = await heapOf(session);
    expect(again).toEqual(first);

    expect((await guestSignIn(session.device)).status).toBe(200);
    expect(await heapOf(session)).toEqual(first);
    expect(
      new Set((await heapGrants(playerStub(session.tokens.playerId))).map((l) => l.tx_id)).size,
    ).toBe(1);
    await expectConserved(session);
  });

  it('is not re-minted once every heap coin has left the table', async () => {
    const session = await newSession();
    const heap = await heapOf(session);
    const result = await claims(
      session,
      heap.map((coin) => fall(coin, 'left')),
    );
    expect(result.results.every((r) => r.status === 'accepted')).toBe(true);

    const after = await state(session);
    expect(after.table.coins).toEqual([]);
    expect(await heapGrants(playerStub(session.tokens.playerId))).toHaveLength(
      2 * openingHeap.coins,
    );
    await expectConserved(session);
  });

  it('pays the stored heap value for a front fall and nothing for a side fall', async () => {
    const session = await newSession();
    const [front, left, right] = await heapOf(session);
    if (front === undefined || left === undefined || right === undefined) {
      throw new Error('The heap should hold at least three coins.');
    }
    const before = await state(session);
    const result = await claims(session, [fall(front), fall(left, 'left'), fall(right, 'right')]);
    expect(result.results).toEqual([
      { status: 'accepted', credited: HEAP_VALUE, cascade: null, minted: null },
      { status: 'accepted', credited: 0, cascade: null, minted: null },
      { status: 'accepted', credited: 0, cascade: null, minted: null },
    ]);
    expect(result.wallet.coins).toBe(before.wallet.coins + HEAP_VALUE);
    const remaining = (await state(session)).table.coins.map((coin) => coin.id);
    expect(remaining).not.toContain(front.id);
    expect(remaining).not.toContain(left.id);
    expect(remaining).toHaveLength(openingHeap.coins - 3);
    await expectConserved(session);
  });

  it('refuses a double claim of a heap coin, across batches, within one batch and by replay', async () => {
    const session = await newSession();
    const [a, b] = await heapOf(session);
    if (a === undefined || b === undefined) throw new Error('The heap should hold two coins.');

    const first = await claims(session, [fall(a)]);
    expect(first.results[0]).toMatchObject({ status: 'accepted', credited: HEAP_VALUE });
    const second = await claims(session, [fall(a), fall(a, 'left')]);
    expect(second.results).toEqual([
      { status: 'rejected', reason: 'already_claimed' },
      { status: 'rejected', reason: 'already_claimed' },
    ]);
    expect(second.wallet).toEqual(first.wallet);

    const within = await claims(session, [fall(b), fall(b)]);
    expect(within.results).toEqual([
      { status: 'accepted', credited: HEAP_VALUE, cascade: null, minted: null },
      { status: 'rejected', reason: 'already_claimed' },
    ]);

    const idempotencyKey = newIdempotencyKey();
    const body = { claims: [fall(a)] };
    const replayed = await session.call(endpoints.tableClaims.path, { body, idempotencyKey });
    const retried = await session.call(endpoints.tableClaims.path, { body, idempotencyKey });
    expect(await retried.json()).toEqual(await replayed.json());
    expect((await state(session)).wallet.coins).toBe(first.wallet.coins + HEAP_VALUE);
    await expectConserved(session);
  });

  it("refuses another player's heap coins and forged heap-looking IDs", async () => {
    const session = await newSession();
    const other = await newSession();
    const [theirs] = await heapOf(other);
    if (theirs === undefined) throw new Error('The heap should not be empty.');
    const before = await state(session);

    const result = await claims(session, [
      fall(theirs),
      fall({ id: theirs.id.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')) }),
    ]);
    expect(result.results).toEqual([
      { status: 'rejected', reason: 'unknown_entity' },
      { status: 'rejected', reason: 'unknown_entity' },
    ]);
    expect(result.wallet).toEqual(before.wallet);
    expect((await claims(other, [fall(theirs)])).results[0]?.status).toBe('accepted');
  });

  it('refuses a heap claim that names its own value', async () => {
    const session = await newSession();
    const [coin] = await heapOf(session);
    if (coin === undefined) throw new Error('The heap should not be empty.');
    const response = await session.call(endpoints.tableClaims.path, {
      body: { claims: [{ ...fall(coin), value: 1_000_000 }] },
    });
    expect(response.status).toBe(400);
    expect((await heapOf(session)).map((c) => c.id)).toContain(coin.id);
  });
});

describe('opening heap for players who signed up before it was seeded', () => {
  it('lays the heap and prepays the old buffer on their next hydration, once', async () => {
    const stub = await legacyPlayer({
      unpaidBuffer: PREMINT_BUFFER_TARGET,
      walletCoins: startingCoins(),
      drops: 0,
    });
    const first = await stub.state({});
    if (!first.ok) throw new Error(first.error.message);
    expect(first.body.table.coins).toHaveLength(openingHeap.coins);
    expect(first.body.table.coins.every((coin) => coin.tier === openingHeap.tier)).toBe(true);
    expect(first.body.table.buffer).toHaveLength(PREMINT_BUFFER_TARGET);
    expect(first.body.wallet.coins).toBe(startingCoins() - PREMINT_BUFFER_TARGET * COPPER.value);

    const second = await stub.state({});
    if (!second.ok) throw new Error(second.error.message);
    expect(second.body.table.coins).toEqual(first.body.table.coins);
    expect(second.body.table.buffer).toEqual(first.body.table.buffer);
    expect(second.body.wallet).toEqual(first.body.wallet);
    expect(new Set((await heapGrants(stub)).map((leg) => leg.tx_id)).size).toBe(1);
    expect(await stub.conservation()).toMatchObject({ conserved: true });
  });

  it('lets go of old reservations the wallet cannot pay for', async () => {
    const stub = await legacyPlayer({ unpaidBuffer: 5, walletCoins: 2, drops: 0 });
    const result = await stub.state({});
    if (!result.ok) throw new Error(result.error.message);
    expect(result.body.table.buffer).toHaveLength(2);
    expect(result.body.wallet.coins).toBe(0);
    expect(await stub.conservation()).toMatchObject({ conserved: true, bufferPaid: 2 });
  });

  it('refunds the drops stranded on the table, then lays the heap, once', async () => {
    const stub = await legacyPlayer({ unpaidBuffer: 3, walletCoins: 36, drops: 36, stranded: 36 });
    const first = await stub.state({ hydrate: 'boot' });
    if (!first.ok) throw new Error(first.error.message);
    expect(first.body.table.coins).toHaveLength(openingHeap.coins);
    expect(first.body.table.coins.every((coin) => coin.tier === openingHeap.tier)).toBe(true);
    const report = await stub.conservation();
    expect(report).toMatchObject({ conserved: true });
    expect(report.walletCoins + report.bufferPaid).toBe(36);
    expect(report.ledger.house).toBe(-openingHeap.coins * HEAP_VALUE);

    const second = await stub.state({ hydrate: 'boot' });
    if (!second.ok) throw new Error(second.error.message);
    expect(second.body.table.coins).toEqual(first.body.table.coins);
    expect(second.body.wallet).toEqual(first.body.wallet);
    expect(new Set((await heapGrants(stub)).map((leg) => leg.tx_id)).size).toBe(1);
  });

  it('gives a player whose table still holds a heap no second one', async () => {
    const session = await newSession();
    await dropAsClient(session, 2);
    await reload(session);
    expect((await heapOf(session)).every((coin) => coin.tier === openingHeap.tier)).toBe(true);
    expect(
      new Set((await heapGrants(playerStub(session.tokens.playerId))).map((l) => l.tx_id)).size,
    ).toBe(1);
  });
});
