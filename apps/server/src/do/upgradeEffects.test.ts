import {
  coinTiers,
  crateSpawn,
  crateSpawnInterval,
  dropBufferTarget,
  upgradeCost,
  upgradeLines,
  type UpgradeLevelMap,
} from '@coinposh/economy';
import {
  endpoints,
  UpgradeLineIdSchema,
  type DropResponse,
  type IdempotencyKey,
  type MintedCoin,
  type StateResponse,
  type UpgradeBuyResponse,
} from '@coinposh/shared';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { recordUpgrade, type UpgradeLineIdV1 } from '../routes/upgrades.ts';
import { newIdempotencyKey, newSession, send, type Session } from '../test/client.ts';
import { claims, drop, expectConserved, playerStub, state } from '../test/game.ts';
import { HOME_VENUE, mintedValue } from './entities.ts';
import { commit, LedgerTx } from './ledger.ts';
import { PREMINT_BUFFER_TARGET, type PlayerDO } from './PlayerDO.ts';

const COPPER = coinTiers[0];

function levelOf(snapshot: StateResponse, id: UpgradeLineIdV1): number | undefined {
  return snapshot.venue.upgrades[UpgradeLineIdSchema.parse(id)];
}

function line(id: UpgradeLineIdV1) {
  const found = upgradeLines.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`Economy config has no ${id} line.`);
  return found;
}

/** Test setup only: puts a line at `level` without paying, to reach the top levels quickly. */
function setLevel(session: Session, lineId: UpgradeLineIdV1, level: number): Promise<void> {
  return runInDurableObject(playerStub(session.tokens.playerId), (_: PlayerDO, ctx) => {
    recordUpgrade(ctx.storage.sql, {
      venueId: HOME_VENUE.id,
      lineId,
      level,
      currency: 'coins',
      cost: 0,
    });
  });
}

/** Test setup only: a balanced mint → wallet grant, so conservation still holds. */
function fund(session: Session, coins: number): Promise<void> {
  return runInDurableObject(playerStub(session.tokens.playerId), (_: PlayerDO, ctx) => {
    commit(
      ctx.storage.sql,
      new LedgerTx('grant.starting').move('mint', 'wallet', 'coins', coins, null),
      {
        at: Date.now(),
        idempotencyKey: null,
      },
    );
  });
}

async function buy(
  session: Session,
  lineId: UpgradeLineIdV1,
  level: number,
  key: IdempotencyKey = newIdempotencyKey(),
): Promise<Response> {
  return send(session.device, endpoints.upgradesBuy.path, {
    accessToken: session.tokens.accessToken,
    idempotencyKey: key,
    body: { venueId: HOME_VENUE.id, lineId, level },
  });
}

/** Funds and buys the next level for real, the way the client does. */
async function buyNext(
  session: Session,
  lineId: UpgradeLineIdV1,
  current: number,
): Promise<UpgradeBuyResponse> {
  await fund(session, upgradeCost(line(lineId), current));
  const response = await buy(session, lineId, current + 1);
  expect(response.status, await response.clone().text()).toBe(200);
  return endpoints.upgradesBuy.response.parse(await response.json());
}

/** Drops `count` coins from the buffer the client last saw, as the client does. */
async function dropFrom(
  session: Session,
  buffer: readonly MintedCoin[],
  count: number,
  firstTick = 0,
): Promise<DropResponse[]> {
  let held = buffer;
  const responses: DropResponse[] = [];
  for (let i = 0; i < count; i++) {
    const reserved = held[0];
    const tick = firstTick + i;
    const response = await drop(
      session,
      reserved === undefined ? { tick } : { tick, coinId: reserved.id },
    );
    responses.push(response);
    held = response.buffer;
  }
  return responses;
}

function crateDrops(responses: readonly DropResponse[], offset = 0): number[] {
  return responses.flatMap((response, i) =>
    response.spawnedCrates.length > 0 ? [offset + i + 1] : [],
  );
}

describe('coinValue upgrade on the server', () => {
  it('mints drops at the base value at level 0', async () => {
    const session = await newSession();
    const snapshot = await state(session);
    const base = mintedValue(COPPER.id, {});
    expect(levelOf(snapshot, 'coinValue')).toBe(0);
    expect(snapshot.table.buffer.every((coin) => coin.value === base)).toBe(true);
    const [dropped] = await dropFrom(session, snapshot.table.buffer, 1);
    expect(dropped?.coin.value).toBe(base);
    await expectConserved(session);
  });

  it('values the very next drop at the bought level, even from the buffer the client already holds', async () => {
    const session = await newSession();
    const stale = (await state(session)).table.buffer;
    const coinValue = line('coinValue');
    const doubling = (2 - coinValue.effect.base) / coinValue.effect.perLevel;
    await setLevel(session, 'coinValue', doubling - 1);
    const bought = await buyNext(session, 'coinValue', doubling - 1);
    expect(bought.level).toBe(doubling);

    const upgraded = mintedValue(COPPER.id, { coinValue: doubling });
    expect(upgraded).toBe(2 * mintedValue(COPPER.id, {}));
    const [next] = await dropFrom(session, stale, 1);
    if (next === undefined) throw new Error('expected a drop response');
    expect(next.coin.id).toBe(stale[0]?.id);
    expect(next.coin.value).toBe(upgraded);
    expect(next.buffer.every((coin) => coin.value === upgraded)).toBe(true);

    const walletBefore = next.wallet.coins;
    const fell = await claims(session, [
      { kind: 'fall', coinId: next.coin.id, tick: 1, edge: 'front' },
    ]);
    expect(fell.results[0]).toMatchObject({ status: 'accepted', credited: upgraded });
    expect(fell.wallet.coins).toBe(walletBefore + upgraded);
    await expectConserved(session);
  });

  it('keeps coins minted before the purchase, like the opening heap, at the value they were minted with', async () => {
    const session = await newSession();
    const heap = (await state(session)).table.coins;
    await setLevel(session, 'coinValue', 9);
    await buyNext(session, 'coinValue', 9);
    const after = await state(session);
    expect(after.table.coins.map((coin) => coin.value)).toEqual(heap.map((coin) => coin.value));
    await expectConserved(session);
  });

  it('reaches its top value at the max level and refuses to go past it', async () => {
    const session = await newSession();
    const coinValue = line('coinValue');
    await setLevel(session, 'coinValue', coinValue.maxLevel - 1);
    await buyNext(session, 'coinValue', coinValue.maxLevel - 1);
    const top = mintedValue(COPPER.id, { coinValue: coinValue.maxLevel });
    expect(top).toBe(
      Math.floor(COPPER.value * (1 + coinValue.effect.perLevel * coinValue.maxLevel)),
    );
    const [next] = await dropFrom(session, (await state(session)).table.buffer, 1);
    expect(next?.coin.value).toBe(top);

    await fund(session, 1_000_000);
    const past = await buy(session, 'coinValue', coinValue.maxLevel + 1);
    expect(past.status).toBe(409);
    expect(levelOf(await state(session), 'coinValue')).toBe(coinValue.maxLevel);
    await expectConserved(session);
  });
});

/** Test inspection only: the fraction of a coin the player's next mint starts from. */
function mintCarry(session: Session): Promise<number> {
  return runInDurableObject(playerStub(session.tokens.playerId), (_: PlayerDO, ctx) =>
    Number(
      ctx.storage.sql
        .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'mint_carry'")
        .one().value,
    ),
  );
}

/** Puts coinValue at `level` the way a player gets there: the last level bought for real. */
async function reachCoinValue(session: Session, level: number): Promise<void> {
  if (level === 0) return;
  await setLevel(session, 'coinValue', level - 1);
  await buyNext(session, 'coinValue', level - 1);
}

// Six fresh sessions, each buying up to its level and dropping through the worker: over 3.5 s on CI.
describe('coinValue pays its fraction through the mint carry', { timeout: 20_000 }, () => {
  it('credits 5, 6, 7, 8, 9, 10 over five copper drops and falls at levels 0..5', async () => {
    const totals: number[] = [];
    for (let level = 0; level <= 5; level++) {
      const session = await newSession();
      await reachCoinValue(session, level);
      const dropped = await dropFrom(session, (await state(session)).table.buffer, 5);
      const fell = await claims(
        session,
        dropped.map((response, i) => ({
          kind: 'fall',
          coinId: response.coin.id,
          tick: 10 + i,
          edge: 'front',
        })),
      );
      const credited = fell.results.map((result) =>
        result.status === 'accepted' ? result.credited : Number.NaN,
      );
      expect(credited).toEqual(dropped.map((response) => response.coin.value));
      totals.push(credited.reduce((total, value) => total + value, 0));
      await expectConserved(session);
    }
    expect(totals).toEqual([5, 6, 7, 8, 9, 10]);
  });

  it('pays ×1.2 from L1 on: the buffer repriced at purchase reads 1, 1, 1, 1, 2', async () => {
    const session = await newSession();
    await reachCoinValue(session, 1);
    const buffer = (await state(session)).table.buffer;
    expect(buffer.slice(0, 5).map((coin) => coin.value)).toEqual([1, 1, 1, 1, 2]);
    const dropped = await dropFrom(session, buffer, 5);
    expect(dropped.map((response) => response.coin.value)).toEqual([1, 1, 1, 1, 2]);
    await expectConserved(session);
  });

  it('carries the fraction across the buffer refill: 20 drops at L2 credit floor(20 × 1.4)', async () => {
    const session = await newSession();
    await reachCoinValue(session, 2);
    await fund(session, 100);
    const dropped = await dropFrom(session, (await state(session)).table.buffer, 20);
    expect(dropped.reduce((total, response) => total + response.coin.value, 0)).toBe(28);
    await expectConserved(session);
  });

  it('reprices a reserved coin stored before the carry existed only by the raise', async () => {
    const session = await newSession();
    await runInDurableObject(playerStub(session.tokens.playerId), (_: PlayerDO, ctx) => {
      ctx.storage.sql.exec("UPDATE coins SET mint_micros = NULL WHERE state = 'buffer'");
    });
    await reachCoinValue(session, 2);
    const buffer = (await state(session)).table.buffer;
    expect(buffer.slice(0, 5).map((coin) => coin.value)).toEqual([1, 1, 2, 1, 2]);
    const dropped = await dropFrom(session, buffer, 5);
    expect(dropped.reduce((total, response) => total + response.coin.value, 0)).toBe(7);
    await expectConserved(session);
  });

  it('reprices the buffer once: a replayed purchase does not move the carry', async () => {
    const session = await newSession();
    await setLevel(session, 'coinValue', 0);
    await fund(session, upgradeCost(line('coinValue'), 0));
    const key = newIdempotencyKey();
    expect((await buy(session, 'coinValue', 1, key)).status).toBe(200);
    const carry = await mintCarry(session);
    const once = (await state(session)).table.buffer;
    expect((await buy(session, 'coinValue', 1, key)).status).toBe(200);
    expect(await mintCarry(session)).toBe(carry);
    expect((await state(session)).table.buffer).toEqual(once);
    await expectConserved(session);
  });

  it('does not advance the carry for a replayed drop', async () => {
    const session = await newSession();
    await reachCoinValue(session, 1);
    const buffer = (await state(session)).table.buffer;
    const body = { x: 0, tick: 0, coinId: buffer[0]?.id };
    const key = newIdempotencyKey();
    const first = await send(session.device, endpoints.tableDrop.path, {
      accessToken: session.tokens.accessToken,
      idempotencyKey: key,
      body,
    });
    expect(first.status, await first.clone().text()).toBe(200);
    const carry = await mintCarry(session);
    const after = await state(session);
    const replay = await send(session.device, endpoints.tableDrop.path, {
      accessToken: session.tokens.accessToken,
      idempotencyKey: key,
      body,
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(await first.json());
    expect(await mintCarry(session)).toBe(carry);
    expect((await state(session)).table.buffer).toEqual(after.table.buffer);
    await expectConserved(session);
  });
});

// Seeing crate spacing takes up to 80 real signed drops through the worker: about 4 s on CI.
describe('crateChance upgrade on the server', { timeout: 20_000 }, () => {
  it('spawns the FTUE crate and then one every dropsPerCrate drops at level 0', async () => {
    const session = await newSession();
    await fund(session, 200);
    const responses = await dropFrom(
      session,
      (await state(session)).table.buffer,
      2 * crateSpawn.dropsPerCrate,
    );
    expect(crateDrops(responses)).toEqual([
      crateSpawn.ftueScriptedDrop,
      crateSpawn.dropsPerCrate,
      2 * crateSpawn.dropsPerCrate,
    ]);
    await expectConserved(session);
  });

  it('spaces crates closer from the next drop once the max level is bought', async () => {
    const session = await newSession();
    const crateChance = line('crateChance');
    const top: UpgradeLevelMap = { crateChance: crateChance.maxLevel };
    const every = crateSpawnInterval(top);
    expect(every).toBeLessThan(crateSpawn.dropsPerCrate);
    expect(every).toBeGreaterThan(crateSpawn.ftueScriptedDrop);

    await fund(session, 200);
    const before = await dropFrom(session, (await state(session)).table.buffer, every - 1);
    expect(crateDrops(before)).toEqual([crateSpawn.ftueScriptedDrop]);
    await setLevel(session, 'crateChance', crateChance.maxLevel - 1);
    await buyNext(session, 'crateChance', crateChance.maxLevel - 1);
    const after = await dropFrom(session, before.at(-1)?.buffer ?? [], every + 1, every - 1);
    expect(crateDrops(after, every - 1)).toEqual([every, 2 * every]);
    expect((await state(session)).table.crates).toHaveLength(3);
    await expectConserved(session);
  });
});

describe('dropRate upgrade on the server', () => {
  it('keeps the base buffer at level 0', async () => {
    const session = await newSession();
    expect((await state(session)).table.buffer).toHaveLength(PREMINT_BUFFER_TARGET);
  });

  it('tops the prepaid buffer up to the bought size within the purchase, up to the max-level size', async () => {
    const session = await newSession();
    const dropRate = line('dropRate');
    await fund(session, 100);
    const first = await state(session);
    const stale = first.table.buffer;
    const midSize = dropBufferTarget(PREMINT_BUFFER_TARGET, { dropRate: 10 });
    expect(midSize).toBeGreaterThan(PREMINT_BUFFER_TARGET);

    await setLevel(session, 'dropRate', 9);
    const mid = await buyNext(session, 'dropRate', 9);
    expect(mid.wallet.coins).toBe(
      first.wallet.coins - (midSize - PREMINT_BUFFER_TARGET) * COPPER.value,
    );
    const afterMid = await state(session);
    expect(afterMid.table.buffer).toHaveLength(midSize);
    expect(afterMid.wallet).toEqual(mid.wallet);
    const [next] = await dropFrom(session, stale, 1);
    expect(next?.buffer).toHaveLength(midSize);
    expect(next?.wallet.coins).toBe(mid.wallet.coins - COPPER.value);

    await setLevel(session, 'dropRate', dropRate.maxLevel - 1);
    const top = await buyNext(session, 'dropRate', dropRate.maxLevel - 1);
    const size = dropBufferTarget(PREMINT_BUFFER_TARGET, { dropRate: dropRate.maxLevel });
    expect(size).toBeGreaterThan(midSize);
    const afterTop = await state(session);
    expect(afterTop.table.buffer).toHaveLength(size);
    expect(afterTop.wallet).toEqual(top.wallet);
    await expectConserved(session);
  });
});

describe('pusherSpeed upgrade on the server', () => {
  it('is a client sim stat: it charges and records the level but changes no minted value, buffer or crate spacing', async () => {
    const session = await newSession();
    const pusherSpeed = line('pusherSpeed');
    await setLevel(session, 'pusherSpeed', pusherSpeed.maxLevel - 1);
    await buyNext(session, 'pusherSpeed', pusherSpeed.maxLevel - 1);
    const snapshot = await state(session);
    expect(levelOf(snapshot, 'pusherSpeed')).toBe(pusherSpeed.maxLevel);
    expect(snapshot.table.buffer).toHaveLength(PREMINT_BUFFER_TARGET);
    const [dropped] = await dropFrom(session, snapshot.table.buffer, 1);
    expect(dropped?.coin.value).toBe(mintedValue(COPPER.id, {}));
    const fell = await claims(session, [
      { kind: 'fall', coinId: dropped?.coin.id, tick: 0, edge: 'front' },
    ]);
    expect(fell.results[0]).toMatchObject({ status: 'accepted' });
    await expectConserved(session);
  });
});

describe('upgrade effects and conservation', () => {
  it('balances the ledger across purchases, upgraded drops, falls and crates', async () => {
    const session = await newSession();
    await fund(session, 5_000);
    let buffer = (await state(session)).table.buffer;
    const bought: Record<string, number> = {};
    for (const lineId of ['coinValue', 'crateChance', 'dropRate', 'pusherSpeed'] as const) {
      for (let level = 0; level < 3; level++) {
        const response = await buy(session, lineId, level + 1);
        expect(response.status, await response.clone().text()).toBe(200);
        bought[lineId] = level + 1;
      }
      const responses = await dropFrom(session, buffer, 5, Object.keys(bought).length * 10);
      buffer = responses.at(-1)?.buffer ?? [];
      await claims(
        session,
        responses.map((response, i) => ({
          kind: 'fall',
          coinId: response.coin.id,
          tick: 100 + i,
          edge: i % 2 === 0 ? 'front' : 'left',
        })),
      );
      await expectConserved(session);
    }
    const report = await playerStub(session.tokens.playerId).conservation();
    const paid = await runInDurableObject(
      playerStub(session.tokens.playerId),
      (_: PlayerDO, ctx) =>
        ctx.storage.sql
          .exec<{ total: number }>(
            "SELECT SUM(delta) AS total FROM ledger WHERE kind = 'upgrade.buy' AND account = 'house'",
          )
          .one().total,
    );
    const expected = Object.entries(bought).reduce((total, [id, level]) => {
      let cost = 0;
      for (let l = 0; l < level; l++) cost += upgradeCost(line(id as UpgradeLineIdV1), l);
      return total + cost;
    }, 0);
    expect(paid).toBe(expected);
    expect(report.conserved).toBe(true);
    expect((await state(session)).venue.upgrades).toMatchObject(bought);
  });

  it('revalues the buffer once: a replayed purchase charges nothing and changes nothing', async () => {
    const session = await newSession();
    await setLevel(session, 'coinValue', 4);
    await fund(session, upgradeCost(line('coinValue'), 4));
    const key = newIdempotencyKey();
    expect((await buy(session, 'coinValue', 5, key)).status).toBe(200);
    const once = await state(session);
    const replay = await buy(session, 'coinValue', 5, key);
    expect(replay.status).toBe(200);
    const twice = await state(session);
    expect(twice.wallet).toEqual(once.wallet);
    expect(twice.table.buffer).toEqual(once.table.buffer);
    await expectConserved(session);
  });
});
