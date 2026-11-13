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
import {
  endpoints,
  tableSnapshotEndpoint,
  type CratePoseTuple,
  type DropResponse,
  type MintedCoin,
  type PoseTuple,
  type StateResponse,
} from '@coinposh/shared';
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
  tableSession,
  vaultCoins,
} from '../test/game.ts';
import { Entities, mintedValue } from './entities.ts';
import { commit, LedgerTx } from './ledger.ts';
import type { PlayerDO } from './PlayerDO.ts';
import { CHUTE_POSE, readTableSnapshot } from './snapshot.ts';

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

// Up to 120 real signed drops with reloads between them, which ran past 5 s on CI.
describe('crate spawns across a boot refund', { timeout: 20_000 }, () => {
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
    const body = {
      session: await tableSession(session),
      x: 0,
      tick: 0,
      coinId: drops.at(-1)?.buffer[0]?.id,
    };
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

const FLAT = [0, 0, 0, 32_767] as const;

function restingAt(id: string, x: number, z = -9_000): PoseTuple {
  return [id, x, 160, z, ...FLAT, 'asleep'] as PoseTuple;
}

/** Coin i of `ids` on a row across the floor, none touching another. */
function row(ids: readonly string[]): PoseTuple[] {
  return ids.map((id, i) => restingAt(id, -15_000 + i * 3_000));
}

async function upload(
  session: Session,
  table: StateResponse['table'],
  body: { seq: number; tick: number; coins?: PoseTuple[]; crates?: CratePoseTuple[] },
) {
  const response = await session.call(tableSnapshotEndpoint.path, {
    body: {
      session: table.session,
      pusher: { tickInCycle: 0 },
      coins: [],
      crates: [],
      ...body,
    },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return tableSnapshotEndpoint.response.parse(await response.json());
}

function tableRows(session: Session) {
  return runInDurableObject(playerStub(session.tokens.playerId), (_instance: PlayerDO, ctx) => {
    const sql = ctx.storage.sql;
    return {
      coins: sql
        .exec<{ id: string; dropped_tick: number | null }>(
          "SELECT id, dropped_tick FROM coins WHERE state = 'table' ORDER BY rowid",
        )
        .toArray(),
      crates: sql
        .exec<{ id: string; state: string; spawned_tick: number }>(
          'SELECT id, state, spawned_tick FROM crates ORDER BY rowid',
        )
        .toArray(),
      snapshot: readTableSnapshot(sql),
      origin: sql
        .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'table_session_origin'")
        .toArray()[0]?.value,
    };
  });
}

function placements(table: StateResponse['table']) {
  return new Map(table.coins.map((coin, i) => [coin.id, table.layout?.coins[i]]));
}

// Each test drops real signed coins, and the crate ones drop up to the scripted crate.
describe('a page reload restores the table from its poses', { timeout: 20_000 }, () => {
  it('lays every posed coin where it rested, refunds none of them and rebases its drop tick', async () => {
    const session = await newSession();
    await reload(session);
    const coins = await dropAsClient(session, 3, (i) => 400 + i);
    const ids = coins.map((response) => response.coin.id);
    const table = (await state(session)).table;
    const heap = table.coins.slice(0, openingHeap.coins);
    expect(await upload(session, table, { seq: 1, tick: 500, coins: row(ids) })).toEqual({
      seq: 1,
      stored: 3,
      ignored: 0,
    });
    const vault = await vaultCoins(session);
    const [first] = ids;
    if (first === undefined) throw new Error('The drop failed.');
    const early = await claims(session, [{ kind: 'fall', coinId: first, tick: 0, edge: 'front' }]);
    expect(early.results[0]).toEqual({ status: 'rejected', reason: 'not_on_table' });

    const after = (await reload(session)).table;
    expect(after.session).not.toBe(table.session);
    expect(after.coins.map((coin) => coin.id)).toEqual([...heap.map((coin) => coin.id), ...ids]);
    expect(after.layout?.coins).toEqual([
      ...heap.map((_coin, slot) => ({ kind: 'heapSlot', slot })),
      ...row(ids).map((pose) => ({ kind: 'pose', pose })),
    ]);
    expect(await refunds(session)).toEqual([]);
    expect(await vaultCoins(session)).toBe(vault);
    expect((await tableRows(session)).coins.every((coin) => coin.dropped_tick === 0)).toBe(true);

    const restored = await claims(session, [
      { kind: 'fall', coinId: first, tick: 0, edge: 'front' },
    ]);
    expect(restored.results[0]).toMatchObject({
      status: 'accepted',
      credited: coins[0]?.coin.value,
    });
    await expectConserved(session);
  });

  it('lays unposed heap coins at their slot and refunds only unposed drops, never above their cost', async () => {
    const session = await newSession();
    await reload(session);
    const [kept, lost] = (await dropAsClient(session, 2, () => 10)).map(
      (response) => response.coin,
    );
    if (kept === undefined || lost === undefined) throw new Error('The drops failed.');
    const table = (await state(session)).table;
    const heap = table.coins.slice(0, openingHeap.coins);
    const posedHeap = heap[1];
    if (posedHeap === undefined) throw new Error('No heap.');
    const poses = row([posedHeap.id, kept.id]);
    await upload(session, table, { seq: 1, tick: 60, coins: poses });
    const vault = await vaultCoins(session);

    const after = (await reload(session)).table;
    expect(after.coins.map((coin) => coin.id)).toEqual([...heap.map((coin) => coin.id), kept.id]);
    const placed = placements(after);
    expect(placed.get(posedHeap.id)).toEqual({ kind: 'pose', pose: poses[0] });
    expect(placed.get(kept.id)).toEqual({ kind: 'pose', pose: poses[1] });
    heap.forEach((coin, slot) => {
      if (coin !== posedHeap) expect(placed.get(coin.id)).toEqual({ kind: 'heapSlot', slot });
    });

    const rows = await refunds(session);
    expect(new Set(rows.map((leg) => leg.ref))).toEqual(new Set([lost.id]));
    expect(credited(rows, 'wallet')).toBe(COPPER.value);
    expect(await vaultCoins(session)).toBe(vault + COPPER.value);
    await expectConserved(session);
  });

  it('checks stored poses again on boot: one that no longer passes falls back to its slot or a refund', async () => {
    const session = await newSession();
    await reload(session);
    const [coin] = (await dropAsClient(session, 1, () => 10)).map((response) => response.coin);
    const table = (await state(session)).table;
    const heapCoin = table.coins[0];
    if (coin === undefined || heapCoin === undefined) throw new Error('No heap or drop.');
    await upload(session, table, { seq: 1, tick: 60, coins: row([heapCoin.id, coin.id]) });
    await runInDurableObject(playerStub(session.tokens.playerId), (_instance: PlayerDO, ctx) => {
      const offTable = row([heapCoin.id, coin.id]).map((pose) =>
        restingAt(pose[0], pose[1], 50_000),
      );
      ctx.storage.sql.exec('UPDATE table_snapshot SET poses = ?', JSON.stringify(offTable));
    });

    const after = (await reload(session)).table;
    expect(after.coins.map((entry) => entry.id)).not.toContain(coin.id);
    expect(placements(after).get(heapCoin.id)).toEqual({ kind: 'heapSlot', slot: 0 });
    expect(new Set((await refunds(session)).map((leg) => leg.ref))).toEqual(new Set([coin.id]));
    await expectConserved(session);
  });

  it('only lays a heap coin back at its own slot when its pose is broken on purpose (heap slot reset)', async () => {
    const session = await newSession();
    const table = (await reload(session)).table;
    const [a, b] = table.coins;
    if (a === undefined || b === undefined) throw new Error('No heap.');
    await upload(session, table, { seq: 1, tick: 60, coins: [restingAt(a.id, 0)] });
    expect(
      await upload(session, table, { seq: 2, tick: 120, coins: [restingAt(b.id, 500)] }),
    ).toEqual({ seq: 2, stored: 1, ignored: 0 });
    const vault = await vaultCoins(session);

    const after = (await reload(session)).table;
    expect(after.coins).toEqual(table.coins);
    expect(placements(after).get(a.id)).toEqual({ kind: 'pose', pose: restingAt(a.id, 0) });
    expect(placements(after).get(b.id)).toEqual({ kind: 'heapSlot', slot: 1 });
    expect(await refunds(session)).toEqual([]);
    expect(await vaultCoins(session)).toBe(vault);
    await expectConserved(session);
  });

  it('keeps the last pose of a coin later snapshots leave out (omitting coins)', async () => {
    const session = await newSession();
    await reload(session);
    const ids = (await dropAsClient(session, 2, () => 10)).map((response) => response.coin.id);
    const [moved, omitted] = ids;
    if (moved === undefined || omitted === undefined) throw new Error('The drops failed.');
    const table = (await state(session)).table;
    const first = row(ids);
    await upload(session, table, { seq: 1, tick: 60, coins: first });
    await upload(session, table, { seq: 2, tick: 120, coins: [restingAt(moved, -15_000, -8_900)] });

    const placed = placements((await reload(session)).table);
    expect(placed.get(moved)).toEqual({ kind: 'pose', pose: restingAt(moved, -15_000, -8_900) });
    expect(placed.get(omitted)).toEqual({ kind: 'pose', pose: first[1] });
    expect(await refunds(session)).toEqual([]);
    await expectConserved(session);
  });

  it('puts a posed crate back on its ride and lets the new session claim it from tick 0', async () => {
    const session = await newSession();
    await reload(session);
    const drops = await dropAsClient(session, crateSpawn.ftueScriptedDrop, (i) => 300 + i);
    const crate = drops.flatMap((response) => response.spawnedCrates)[0];
    if (crate === undefined) throw new Error('The scripted drop spawned no crate.');
    const table = (await state(session)).table;
    const ride: CratePoseTuple = [crate.id, 1_200, CHUTE_POSE.z, 0, 'riding'];
    await upload(session, table, { seq: 1, tick: 400, crates: [ride] });
    const early = await claims(session, [
      { kind: 'crate', crateId: crate.id, tick: 0, edge: 'front' },
    ]);
    expect(early.results[0]).toEqual({ status: 'rejected', reason: 'not_on_table' });

    const after = (await reload(session)).table;
    expect(after.crates).toEqual([crate]);
    expect(after.layout?.crates).toEqual([{ kind: 'pose', pose: ride }]);
    expect((await tableRows(session)).crates).toEqual([
      { id: crate.id, state: 'table', spawned_tick: 0 },
    ]);
    const claimed = await claims(session, [
      { kind: 'crate', crateId: crate.id, tick: 0, edge: 'front' },
    ]);
    expect(claimed.results[0]).toMatchObject({ status: 'accepted' });
    await expectConserved(session);
  });

  it('starts an unposed crate again from the chute and never refunds it', async () => {
    const session = await newSession();
    await reload(session);
    const drops = await dropAsClient(session, crateSpawn.ftueScriptedDrop, (i) => 300 + i);
    const crate = drops.flatMap((response) => response.spawnedCrates)[0];
    if (crate === undefined) throw new Error('The scripted drop spawned no crate.');

    const after = (await reload(session)).table;
    expect(after.crates).toEqual([crate]);
    expect(after.layout?.crates).toEqual([{ kind: 'chute' }]);
    expect((await refunds(session)).map((leg) => leg.ref)).not.toContain(crate.id);
    expect((await tableRows(session)).crates[0]).toMatchObject({ state: 'table', spawned_tick: 0 });
    const claimed = await claims(session, [
      { kind: 'crate', crateId: crate.id, tick: 0, edge: 'front' },
    ]);
    expect(claimed.results[0]).toMatchObject({ status: 'accepted' });
    await expectConserved(session);
  });

  it('opens the new session with exactly what it restored, as its first snapshot and audit start', async () => {
    const session = await newSession();
    await reload(session);
    const ids = (await dropAsClient(session, 2, () => 10)).map((response) => response.coin.id);
    const table = (await state(session)).table;
    const [posed] = ids;
    if (posed === undefined) throw new Error('The drops failed.');
    await upload(session, table, {
      seq: 1,
      tick: 60,
      coins: [restingAt(posed, 0), restingAt('coin_AAAAAAAAAAAAAAAAAAAA', 3_000)],
    });

    const after = (await reload(session)).table;
    const rows = await tableRows(session);
    expect(rows.snapshot).toMatchObject({
      session: after.session,
      seq: 0,
      tick: 0,
      pusherTick: 0,
      poses: [restingAt(posed, 0)],
      cratePoses: [],
    });
    expect(JSON.parse(rows.origin ?? 'null')).toEqual(rows.snapshot);

    await expectError(
      await session.call(tableSnapshotEndpoint.path, {
        body: {
          session: table.session,
          seq: 2,
          tick: 120,
          pusher: { tickInCycle: 0 },
          coins: [],
          crates: [],
        },
      }),
      409,
      'session_superseded',
    );
    expect(await upload(session, after, { seq: 1, tick: 0 })).toEqual({
      seq: 1,
      stored: 0,
      ignored: 0,
    });

    const again = (await reload(session)).table;
    expect(again.coins).toEqual(after.coins);
    expect(again.layout).toEqual(after.layout);
    await expectConserved(session);
  });
});

describe('a second tab boots the same table (#85)', { timeout: 20_000 }, () => {
  async function tab(session: Session) {
    const { table } = await reload(session);
    if (table.session === undefined) throw new Error('A boot should return a table session.');
    return { ...table, session: table.session };
  }

  /** Coin i of `ids` on a floor grid of rows of 11, none touching another. */
  function grid(ids: readonly string[]): PoseTuple[] {
    return ids.map((id, i) =>
      restingAt(id, -15_000 + (i % 11) * 3_000, -9_000 + Math.floor(i / 11) * 3_000),
    );
  }

  function dropUnder(session: Session, lease: string, tick: number) {
    return session.call(endpoints.tableDrop.path, { body: { session: lease, x: 0, tick } });
  }

  it("restores the other tab's coins and crate from its poses instead of refunding them", async () => {
    const session = await newSession();
    const first = await tab(session);
    const drops = await dropAsClient(session, crateSpawn.ftueScriptedDrop, (i) => 300 + i);
    const ids = drops.map((response) => response.coin.id);
    const crate = drops.flatMap((response) => response.spawnedCrates)[0];
    if (crate === undefined) throw new Error('The scripted drop spawned no crate.');
    const ride: CratePoseTuple = [crate.id, 1_200, CHUTE_POSE.z, 0, 'riding'];
    const table = (await state(session)).table;
    expect(
      await upload(session, table, { seq: 1, tick: 400, coins: grid(ids), crates: [ride] }),
    ).toMatchObject({ stored: ids.length + 1, ignored: 0 });
    const vault = await vaultCoins(session);

    const second = await tab(session);
    expect(second.session).not.toBe(first.session);
    const placed = placements(second);
    for (const pose of grid(ids)) expect(placed.get(pose[0])).toEqual({ kind: 'pose', pose });
    expect(second.layout?.crates).toEqual([{ kind: 'pose', pose: ride }]);
    expect(await refunds(session)).toEqual([]);
    expect(await vaultCoins(session)).toBe(vault);

    const [coin] = drops;
    if (coin === undefined) throw new Error('The drops failed.');
    const won = await claims(session, [
      { kind: 'fall', coinId: coin.coin.id, tick: 0, edge: 'front' },
      { kind: 'crate', crateId: crate.id, tick: 0, edge: 'front' },
    ]);
    expect(won.results).toEqual([
      expect.objectContaining({ status: 'accepted', credited: coin.coin.value }),
      expect.objectContaining({ status: 'accepted' }),
    ]);
    await expectConserved(session);
  });

  it('fences the first tab: its drops, claims and snapshots after the boot write nothing', async () => {
    const session = await newSession();
    const first = await tab(session);
    const ids = (await dropAsClient(session, 3, () => 50)).map((response) => response.coin.id);
    await upload(session, (await state(session)).table, { seq: 1, tick: 60, coins: row(ids) });
    const second = await tab(session);
    const rows = await tableRows(session);
    const report = await playerStub(session.tokens.playerId).conservation();

    await expectError(await dropUnder(session, first.session, 70), 409, 'session_superseded');
    const [target] = ids;
    if (target === undefined) throw new Error('The drops failed.');
    await expectError(
      await session.call(endpoints.tableClaims.path, {
        body: {
          session: first.session,
          claims: [{ kind: 'fall', coinId: target, tick: 70, edge: 'front' }],
        },
      }),
      409,
      'session_superseded',
    );
    await expectError(
      await session.call(tableSnapshotEndpoint.path, {
        body: {
          session: first.session,
          seq: 2,
          tick: 900_000,
          pusher: { tickInCycle: 0 },
          coins: [restingAt(target, 0, 4_900)],
          crates: [],
        },
      }),
      409,
      'session_superseded',
    );
    expect(await tableRows(session)).toEqual(rows);
    expect(await playerStub(session.tokens.playerId).conservation()).toEqual(report);
    expect(await upload(session, second, { seq: 1, tick: 0 })).toMatchObject({ seq: 1 });
  });

  it('refunds only what the first tab dropped after its last upload, and it cannot pose it back', async () => {
    const session = await newSession();
    const first = await tab(session);
    const [posed] = (await dropAsClient(session, 1, () => 10)).map((response) => response.coin);
    if (posed === undefined) throw new Error('The drop failed.');
    await upload(session, (await state(session)).table, {
      seq: 1,
      tick: 60,
      coins: [restingAt(posed.id, 0)],
    });
    const late = await dropUnder(session, first.session, 90);
    expect(late.status, await late.clone().text()).toBe(200);
    const unposed = endpoints.tableDrop.response.parse(await late.json()).coin;

    const second = await tab(session);
    expect(placements(second).get(posed.id)).toEqual({
      kind: 'pose',
      pose: restingAt(posed.id, 0),
    });
    expect(second.coins.map((coin) => coin.id)).not.toContain(unposed.id);
    const refunded = await refunds(session);
    expect(new Set(refunded.map((leg) => leg.ref))).toEqual(new Set([unposed.id]));
    expect(credited(refunded, 'wallet')).toBeLessThanOrEqual(COPPER.value);

    await expectError(
      await session.call(tableSnapshotEndpoint.path, {
        body: {
          session: first.session,
          seq: 2,
          tick: 120,
          pusher: { tickInCycle: 0 },
          coins: [restingAt(unposed.id, 3_000)],
          crates: [],
        },
      }),
      409,
      'session_superseded',
    );
    await tab(session);
    expect(await refunds(session)).toEqual(refunded);
    await expectConserved(session);
  });

  it('"Play here" takes the lease back: whichever tab booted last holds the table', async () => {
    const session = await newSession();
    const first = await tab(session);
    const second = await tab(session);
    const back = await tab(session);
    const leases = [first.session, second.session, back.session];
    expect(new Set(leases).size).toBe(3);

    for (const stale of [first.session, second.session]) {
      await expectError(await dropUnder(session, stale, 0), 409, 'session_superseded');
    }
    const played = await dropUnder(session, back.session, 0);
    expect(played.status, await played.clone().text()).toBe(200);
    expect((await state(session)).table.session).toBe(back.session);
    await expectConserved(session);
  });
});
