import { cascadeWindowTicks, coinTiers } from '@coinposh/economy';
import { endpoints, type ClaimsResponse, type DropResponse } from '@coinposh/shared';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { newIdempotencyKey, newSession, send, type Session } from '../test/client.ts';
import { claims, dropAsClient, expectConserved, playerStub, reload, state } from '../test/game.ts';
import type { PlayerDO } from './PlayerDO.ts';

const COPPER = coinTiers[0];
const WINDOW = cascadeWindowTicks(60);

function frontFalls(dropped: readonly DropResponse[], tickOf: (index: number) => number) {
  return dropped.map((response, i) => ({
    kind: 'fall',
    coinId: response.coin.id,
    tick: tickOf(i),
    edge: 'front',
  }));
}

function credited(response: ClaimsResponse): number[] {
  return response.results.map((result) =>
    result.status === 'accepted' ? result.credited : Number.NaN,
  );
}

function tiers(response: ClaimsResponse): (string | null)[] {
  return response.results.map((result) => (result.status === 'accepted' ? result.cascade : 'x'));
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** Test inspection only: the chain and cascade carry the server will build the next fall on. */
function cascadeMeta(session: Session): Promise<Record<string, string>> {
  return runInDurableObject(playerStub(session.tokens.playerId), (_: PlayerDO, ctx) =>
    Object.fromEntries(
      ctx.storage.sql
        .exec<{ key: string; value: string }>(
          "SELECT key, value FROM meta WHERE key IN ('cascade_last_tick', 'cascade_count', 'cascade_carry')",
        )
        .toArray()
        .map((row) => [row.key, row.value]),
    ),
  );
}

describe('cascade multiplier on the server', () => {
  it('pays 10 chained copper falls 11 through Chic, Lavish and Opulent, minted from the mint', async () => {
    const session = await newSession();
    const dropped = await dropAsClient(session, 10);
    expect(dropped.every((response) => response.coin.tier === COPPER.id)).toBe(true);
    const before = (await state(session)).wallet.coins;
    const fell = await claims(
      session,
      frontFalls(dropped, (i) => 10 + i),
    );
    expect(tiers(fell)).toEqual([
      null,
      null,
      'chic',
      'chic',
      'chic',
      'lavish',
      'lavish',
      'lavish',
      'lavish',
      'opulent',
    ]);
    expect(sum(credited(fell))).toBeGreaterThan(10);
    expect(sum(credited(fell))).toBe(11);
    expect(fell.wallet.coins).toBe(before + 11);
    await expectConserved(session);
  });

  it('restarts the chain once a fall comes after the window', async () => {
    const session = await newSession();
    const dropped = await dropAsClient(session, 6);
    const fell = await claims(
      session,
      frontFalls(dropped, (i) => (i < 3 ? 10 + i : 12 + WINDOW + i)),
    );
    expect(tiers(fell)).toEqual([null, null, 'chic', null, null, 'chic']);
    expect(await cascadeMeta(session)).toMatchObject({ cascade_count: '3' });
    await expectConserved(session);
  });

  it('keeps the chain at its last tick inside the window and counts only front falls', async () => {
    const session = await newSession();
    const dropped = await dropAsClient(session, 4);
    const ticks = [10, 10 + WINDOW, 10 + WINDOW, 10 + 2 * WINDOW];
    const list = frontFalls(dropped, (i) => ticks[i] ?? Number.NaN);
    const side = list[1];
    if (side === undefined) throw new Error('expected four falls');
    list[1] = { ...side, edge: 'left' };
    const fell = await claims(session, list);
    expect(credited(fell)).toEqual([1, 0, 1, 1]);
    expect(tiers(fell)).toEqual([null, null, null, 'chic']);
    await expectConserved(session);
  });

  it('starts a new chain for a fall at an earlier tick instead of extending the old one', async () => {
    const session = await newSession();
    const dropped = await dropAsClient(session, 6);
    const ticks = [100, 101, 102, 99, 98, 97];
    const fell = await claims(
      session,
      frontFalls(dropped, (i) => ticks[i] ?? Number.NaN),
    );
    expect(tiers(fell)).toEqual([null, null, 'chic', null, null, null]);
    expect(credited(fell)).toEqual([1, 1, 1, 1, 1, 1]);
    await expectConserved(session);
  });

  it('drops the chain on a boot snapshot, so a reloaded sim never joins the old one', async () => {
    const session = await newSession();
    const before = await dropAsClient(session, 5);
    await claims(
      session,
      frontFalls(before, (i) => 500 + i),
    );
    expect(await cascadeMeta(session)).toMatchObject({ cascade_count: '5' });
    await reload(session);
    expect(await cascadeMeta(session)).not.toHaveProperty('cascade_count');
    const after = await dropAsClient(session, 3, () => 505);
    const fell = await claims(
      session,
      frontFalls(after, (i) => 505 + i),
    );
    expect(tiers(fell)).toEqual([null, null, 'chic']);
    await expectConserved(session);
  });

  it('does not advance the chain or the carry for a replayed claim', async () => {
    const session = await newSession();
    const dropped = await dropAsClient(session, 4);
    const first = frontFalls(dropped.slice(0, 3), (i) => 10 + i);
    const key = newIdempotencyKey();
    const request = () =>
      send(session.device, endpoints.tableClaims.path, {
        accessToken: session.tokens.accessToken,
        idempotencyKey: key,
        body: { claims: first },
      });
    const once = await request();
    expect(once.status, await once.clone().text()).toBe(200);
    const meta = await cascadeMeta(session);
    const wallet = (await state(session)).wallet;
    const again = await request();
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(await once.json());
    expect(await cascadeMeta(session)).toEqual(meta);
    expect((await state(session)).wallet).toEqual(wallet);

    const next = await claims(
      session,
      frontFalls(dropped.slice(3), () => 13),
    );
    expect(tiers(next)).toEqual(['chic']);
    await expectConserved(session);
  });

  it('rejects a replayed fall of a claimed coin without touching the chain', async () => {
    const session = await newSession();
    const dropped = await dropAsClient(session, 3);
    await claims(
      session,
      frontFalls(dropped, (i) => 10 + i),
    );
    const meta = await cascadeMeta(session);
    const replayed = await claims(
      session,
      frontFalls(dropped, (i) => 13 + i),
    );
    expect(replayed.results.every((result) => result.status === 'rejected')).toBe(true);
    expect(await cascadeMeta(session)).toEqual(meta);
    await expectConserved(session);
  });
});
