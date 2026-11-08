import {
  coinTiers,
  fusion,
  fusionValue,
  openingHeap,
  upgradeLines,
  upgradeStat,
} from '@coinposh/economy';
import { endpoints, type MintedCoin } from '@coinposh/shared';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { newSession, send, type Session } from '../test/client.ts';
import {
  claims,
  dropAsClient,
  expectConserved,
  playerStub,
  reload,
  state,
  vaultCoins,
} from '../test/game.ts';
import { mintedValue } from './entities.ts';
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

  it('works through the refresh token a reload really uses', async () => {
    const session = await newSession();
    await dropped(session, 3);
    const response = await send(session.device, endpoints.authRefresh.path, {
      body: { refreshToken: session.tokens.refreshToken },
    });
    expect(response.status).toBe(200);
    await state(session);
    expect(await vaultCoins(session)).toBe(startingCoins());
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
    const heapValue = mintedValue(openingHeap.tier);
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
