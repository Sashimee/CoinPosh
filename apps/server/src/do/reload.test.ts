import {
  coinTiers,
  crateSpawn,
  crateSpawnInterval,
  dropSpawnsCrate,
  fusion,
  fusionValue,
  openingHeap,
  upgradeLines,
  upgradeStat,
} from '@coinposh/economy';
import { endpoints, type DropResponse, type MintedCoin } from '@coinposh/shared';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { newIdempotencyKey, newSession, send, type Session } from '../test/client.ts';
import {
  claims,
  dropAsClient,
  expectError,
  expectConserved,
  playerStub,
  reload,
  state,
  vaultCoins,
} from '../test/game.ts';
import { Entities, mintedValue } from './entities.ts';
import { commit, LedgerTx } from './ledger.ts';
import type { PlayerDO } from './PlayerDO.ts';

const COPPER = coinTiers[0];

function startingCoins(): number {
  const line = upgradeLines.find((candidate) => candidate.effect.stat === 'startingCoins');
  if (line === undefined) throw new Error('No startingCoins line in economy config.');
  return upgradeStat(line, 0);
}

async function dropped(session: Session, count: number): Promise<MintedCoin[]> {
  return (await dropAsClient(session, count, (i) => i)).map((response) => response.coin);
}

function refunds(session: Session) {
  return runInDurableObject(playerStub(session.tokens.playerId), (_instance: PlayerDO, ctx) =>
    ctx.storage.sql
      .exec<{ account: string; delta: number; ref: string }>(
        "SELECT account, delta, ref FROM ledger WHERE kind = 'refund.table' ORDER BY seq",
      )
      .toArray(),
  );
}

function dropCounters(session: Session) {
  return runInDurableObject(playerStub(session.tokens.playerId), (_instance: PlayerDO, ctx) => {
    const read = (key: string) =>
      Number(
        ctx.storage.sql.exec<{ value: string }>('SELECT value FROM meta WHERE key = ?', key).one()
          .value,
      );
    return { net: read('drop_count'), highWater: read('drop_high_water') };
  });
}

function ledgerCrates(session: Session) {
  return runInDurableObject(playerStub(session.tokens.playerId), (_instance: PlayerDO, ctx) =>
    ctx.storage.sql
      .exec<{ ref: string }>(
        "SELECT ref FROM ledger WHERE kind = 'crate.spawn' AND account = 'table' ORDER BY seq",
      )
      .toArray()
      .map((row) => row.ref),
  );
}

function grantCoins(session: Session, amount: number) {
  return runInDurableObject(playerStub(session.tokens.playerId), (_instance: PlayerDO, ctx) => {
    commit(
      ctx.storage.sql,
      new LedgerTx('grant.starting').move('mint', 'wallet', 'coins', amount, null),
      { at: 0, idempotencyKey: null },
    );
  });
}

function spawnIndices(drops: readonly DropResponse[]): number[] {
  return drops.flatMap((response, i) => (response.spawnedCrates.length > 0 ? [i + 1] : []));
}

function credited(rows: readonly { account: string; delta: number }[], account: string): number {
  return rows.filter((row) => row.account === account).reduce((sum, row) => sum + row.delta, 0);
}

describe('a page reload with coins on the table', () => {
  it('refunds every dropped coin the reloaded sim cannot lay, and keeps the heap', async () => {
    const session = await newSession();
    const heap = (await state(session)).table.coins;
    const coins = await dropped(session, 20);
    expect(await vaultCoins(session)).toBe(startingCoins() - 20 * COPPER.value);

    const after = await reload(session);
    expect(after.table.coins).toEqual(heap);
    expect(await vaultCoins(session)).toBe(startingCoins());
    const rows = await refunds(session);
    expect(credited(rows, 'wallet')).toBe(20 * COPPER.value);
    expect(new Set(rows.map((row) => row.ref))).toEqual(new Set(coins.map((coin) => coin.id)));
    await expectConserved(session);
  });

  it('credits nothing more on a second reload', async () => {
    const session = await newSession();
    await dropped(session, 5);
    await reload(session);
    const vault = await vaultCoins(session);
    const rows = await refunds(session);

    await reload(session);
    await reload(session);
    expect(await vaultCoins(session)).toBe(vault);
    expect(await refunds(session)).toEqual(rows);
    await expectConserved(session);
  });

  it('leaves coins in play alone when a mid-session token refresh is followed by a snapshot', async () => {
    const session = await newSession();
    const coins = await dropped(session, 3);
    const response = await send(session.device, endpoints.authRefresh.path, {
      body: { refreshToken: session.tokens.refreshToken },
    });
    expect(response.status).toBe(200);
    const { accessToken } = endpoints.authRefresh.response.parse(await response.json());
    const resumed = await send(session.device, endpoints.state.path, { accessToken });
    expect(resumed.status).toBe(200);

    expect(await refunds(session)).toEqual([]);
    expect(await vaultCoins(session)).toBe(startingCoins() - 3 * COPPER.value);
    const [first] = coins;
    if (first === undefined) throw new Error('The drop failed.');
    const result = await claims(session, [
      { kind: 'fall', coinId: first.id, tick: 9, edge: 'front' },
    ]);
    expect(result.results[0]).toMatchObject({ status: 'accepted', credited: first.value });
    await expectConserved(session);
  });

  it('refunds on a boot snapshot alone, with no sign-in before it, and only once', async () => {
    const session = await newSession();
    await dropped(session, 4);
    await state(session, { hydrate: 'boot' });
    const rows = await refunds(session);
    expect(credited(rows, 'wallet')).toBe(4 * COPPER.value);
    expect(await vaultCoins(session)).toBe(startingCoins());

    await state(session, { hydrate: 'boot' });
    expect(await refunds(session)).toEqual(rows);
    expect(await vaultCoins(session)).toBe(startingCoins());
    await expectConserved(session);
  });

  it('refuses a hydrate value or a query field outside the contract', async () => {
    const session = await newSession();
    await dropped(session, 2);
    for (const search of ['hydrate=yes', 'hydrate=boot&refund=all', 'reload=1']) {
      await expectError(
        await session.call(`${endpoints.state.path}?${search}`),
        400,
        'validation_failed',
      );
    }
    expect(await refunds(session)).toEqual([]);
  });

  it('never refunds more than a coin is worth, and the house then takes nothing', async () => {
    const session = await newSession();
    const before = await vaultCoins(session);
    await runInDurableObject(playerStub(session.tokens.playerId), (_instance: PlayerDO, ctx) => {
      const sql = ctx.storage.sql;
      const coin = new Entities(sql).mintCoin(COPPER.id, 2, null, 'table', 0, 0);
      sql.exec(
        "UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key IN ('drop_count', 'drop_high_water')",
      );
      commit(
        sql,
        new LedgerTx('drop.mint')
          .post('wallet', 'coins', -3, coin.id)
          .post('table', 'coins', 2, coin.id)
          .post('mint', 'coins', 1, coin.id),
        { at: 0, idempotencyKey: null },
      );
    });
    expect(await vaultCoins(session)).toBe(before - 3);

    await state(session, { hydrate: 'boot' });
    const rows = await refunds(session);
    expect(credited(rows, 'wallet')).toBe(2);
    expect(credited(rows, 'house')).toBe(0);
    expect(await vaultCoins(session)).toBe(before - 1);
    await expectConserved(session);
  });

  it('refuses a claim of a refunded coin, so it never pays twice', async () => {
    const session = await newSession();
    const [coin] = await dropped(session, 1);
    if (coin === undefined) throw new Error('The drop failed.');
    await reload(session);
    const result = await claims(session, [
      { kind: 'fall', coinId: coin.id, tick: 5, edge: 'front' },
    ]);
    expect(result.results).toEqual([{ status: 'rejected', reason: 'already_claimed' }]);
    expect(await vaultCoins(session)).toBe(startingCoins());
  });

  it('refunds a fused coin what its dropped inputs cost, and no more', async () => {
    const session = await newSession();
    const [a, b, c] = await dropped(session, 3);
    const [h1, h2, h3] = (await state(session)).table.coins;
    if ([a, b, c, h1, h2, h3].some((coin) => coin === undefined)) throw new Error('No coins.');
    const fused = await claims(session, [
      { kind: 'fusion', coinIds: [a?.id, b?.id, c?.id], tick: 3 },
      { kind: 'fusion', coinIds: [h1?.id, h2?.id, h3?.id], tick: 3 },
    ]);
    const [fromDrops, fromHeap] = fused.results;
    expect(fromDrops).toMatchObject({ status: 'accepted' });
    expect(fromHeap).toMatchObject({ status: 'accepted' });
    const heapValue = mintedValue(openingHeap.tier, {});
    expect(fromHeap).toMatchObject({
      minted: { value: Math.floor(fusionValue([heapValue, heapValue, heapValue], fusion)) },
    });

    await reload(session);
    const rows = await refunds(session);
    expect(credited(rows, 'wallet')).toBe(3 * COPPER.value);
    expect(await vaultCoins(session)).toBe(startingCoins());
    expect((await state(session)).table.coins).toHaveLength(openingHeap.coins - 3);
    await expectConserved(session);
  });

  it('leaves coins in play alone on a mid-session snapshot', async () => {
    const session = await newSession();
    const coins = await dropped(session, 4);
    const snapshot = await state(session);
    expect(snapshot.table.coins.map((coin) => coin.id)).toEqual(
      expect.arrayContaining(coins.map((coin) => coin.id)),
    );
    expect(await refunds(session)).toEqual([]);
    const [first] = coins;
    if (first === undefined) throw new Error('The drop failed.');
    const result = await claims(session, [
      { kind: 'fall', coinId: first.id, tick: 9, edge: 'front' },
    ]);
    expect(result.results[0]).toMatchObject({ status: 'accepted', credited: first.value });
  });

  it('does not refund coins dropped after the reload hydrated', async () => {
    const session = await newSession();
    await reload(session);
    const coins = await dropped(session, 2);
    await state(session);
    expect(await refunds(session)).toEqual([]);
    expect((await state(session)).table.coins.map((coin) => coin.id)).toEqual(
      expect.arrayContaining(coins.map((coin) => coin.id)),
    );
  });
});

describe('crate spawns across a boot refund', () => {
  const SCRIPTED = crateSpawn.ftueScriptedDrop;

  it('spawns no second crate when the refunded spend is dropped to the threshold again', async () => {
    const session = await newSession();
    const interval = crateSpawnInterval({});
    await grantCoins(session, 2 * interval * COPPER.value);
    const vault = await vaultCoins(session);
    expect(spawnIndices(await dropAsClient(session, interval))).toEqual([SCRIPTED, interval]);
    const crates = await ledgerCrates(session);
    expect(crates).toHaveLength(2);

    await reload(session);
    expect(await vaultCoins(session)).toBe(vault);

    expect(spawnIndices(await dropAsClient(session, interval))).toEqual([]);
    expect(await ledgerCrates(session)).toEqual(crates);
    expect(await dropCounters(session)).toEqual({ net: interval, highWater: interval });
    await expectConserved(session);
  });

  it('cannot farm crates by looping drop and reload', async () => {
    const session = await newSession();
    const interval = crateSpawnInterval({});
    await grantCoins(session, 3 * interval * COPPER.value);
    const vault = await vaultCoins(session);
    for (let round = 0; round < 3; round++) {
      await dropAsClient(session, interval);
      await reload(session);
    }
    const expected = Array.from({ length: interval }, (_, i) => i + 1).filter((net) =>
      dropSpawnsCrate(net, {}),
    );
    expect(expected).toEqual([SCRIPTED, interval]);
    expect(await ledgerCrates(session)).toHaveLength(expected.length);
    expect(await vaultCoins(session)).toBe(vault);
    expect(await dropCounters(session)).toEqual({ net: 0, highWater: interval });
    await expectConserved(session);
  });

  it('spawns again on schedule once fresh drops lift the mark past the refunded ones', async () => {
    const session = await newSession();
    const interval = crateSpawnInterval({});
    await grantCoins(session, interval * COPPER.value);
    await dropAsClient(session, SCRIPTED);
    await reload(session);

    const drops = await dropAsClient(session, interval);
    const expected = Array.from({ length: interval }, (_, i) => i + 1).filter(
      (net) => net > SCRIPTED && dropSpawnsCrate(net, {}),
    );
    expect(expected.length).toBeGreaterThan(0);
    expect(spawnIndices(drops)).toEqual(expected);
    expect(await ledgerCrates(session)).toHaveLength(1 + expected.length);
    expect(await dropCounters(session)).toEqual({ net: interval, highWater: interval });
    await expectConserved(session);
  });

  it('takes every drop fused into a refunded coin off the count, and keeps the ones that fell', async () => {
    const session = await newSession();
    const [a, b, c, d] = await dropped(session, 4);
    if ([a, b, c, d].some((coin) => coin === undefined)) throw new Error('The drops failed.');
    const result = await claims(session, [
      { kind: 'fusion', coinIds: [a?.id, b?.id, c?.id], tick: 4 },
      { kind: 'fall', coinId: d?.id, tick: 5, edge: 'front' },
    ]);
    expect(result.results.map((entry) => entry.status)).toEqual(['accepted', 'accepted']);

    await reload(session);
    expect(await dropCounters(session)).toEqual({ net: 1, highWater: 4 });
    await expectConserved(session);
  });

  it('replays the original response to a retried spawning drop without minting a crate', async () => {
    const session = await newSession();
    const drops = await dropAsClient(session, SCRIPTED - 1);
    const body = { x: 0, tick: 0, coinId: drops.at(-1)?.buffer[0]?.id };
    const idempotencyKey = newIdempotencyKey();
    const retry = () => session.call(endpoints.tableDrop.path, { body, idempotencyKey });
    const sent = await retry();
    expect(sent.status, await sent.clone().text()).toBe(200);
    const first = endpoints.tableDrop.response.parse(await sent.json());
    expect(first.spawnedCrates).toHaveLength(1);

    await reload(session);
    const retried = await retry();
    expect(retried.status).toBe(200);
    expect(endpoints.tableDrop.response.parse(await retried.json())).toEqual(first);
    expect(await ledgerCrates(session)).toHaveLength(1);
    expect(await dropCounters(session)).toEqual({ net: 0, highWater: SCRIPTED });
    await expectConserved(session);
  });
});
