import {
  album,
  coinTiers,
  mintedCoinMicros,
  pity,
  rateEnvelopeFor,
  venues,
  type AlbumSetDef,
} from '@coinposh/economy';
import {
  endpoints,
  type AlbumResponse,
  type CollectibleId,
  type CrateOpenResponse,
  type Reward,
} from '@coinposh/shared';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { Entities } from '../do/entities.ts';
import { commit, LedgerTx } from '../do/ledger.ts';
import type { PlayerDO } from '../do/PlayerDO.ts';
import { newSession, type Session } from '../test/client.ts';
import { dropAsClient, expectConserved, expectError, playerStub, state } from '../test/game.ts';
import { CRATE_OPEN_TX_KIND } from './crates.ts';

const DECK = setDef('deckEssentials');
const GALA = setDef('sunsetGala');
const DROP_TIER = coinTiers[0];
const FIRST_VENUE = venues[0];

function setDef(id: string): AlbumSetDef {
  const set = album.find((candidate) => candidate.id === id);
  if (set === undefined) throw new Error(`economy album has no "${id}" set`);
  return set;
}

function inPlayer<T>(session: Session, run: (sql: SqlStorage) => T): Promise<T> {
  return runInDurableObject(playerStub(session.tokens.playerId), (_: PlayerDO, ctx) =>
    ctx.storage.transactionSync(() => run(ctx.storage.sql)),
  );
}

/** A crate pushed off the front edge into the inventory, through the legs a real claim posts. */
function giveCrate(session: Session): Promise<string> {
  return inPlayer(session, (sql) => {
    const context = { at: Date.now(), idempotencyKey: null };
    const entities = new Entities(sql);
    const crate = entities.spawnCrate('vault', 0, context.at);
    commit(sql, new LedgerTx('crate.spawn').move('mint', 'table', 'crate', 1, crate.id), context);
    entities.settleCrate(crate.id, 'claimed', context.at);
    commit(
      sql,
      new LedgerTx('claim.crate').move('table', 'inventory', 'crate', 1, crate.id),
      context,
    );
    return crate.id;
  });
}

/**
 * Books an opened crate that drew `item`, the way openCrate records one: an album card is minted
 * into the inventory in the crate.open transaction, a charm is drawn and recorded only. The
 * cached set bonus is dropped as openCrate would refresh it, so the player derives it again.
 */
async function bookItem(session: Session, item: string): Promise<void> {
  const crateId = await giveCrate(session);
  const charm = item.endsWith('Charm');
  await inPlayer(session, (sql) => {
    const context = { at: Date.now(), idempotencyKey: null };
    const tx = new LedgerTx(CRATE_OPEN_TX_KIND).move('inventory', 'house', 'crate', 1, crateId);
    if (!charm) tx.move('mint', 'inventory', 'collectible', 1, item);
    commit(sql, tx, context);
    sql.exec(
      `INSERT INTO crate_opens (crate_id, opened_at, rarity, scripted, charm_type, collectible_id)
       VALUES (?, ?, 'common', 0, ?, ?)`,
      crateId,
      context.at,
      charm ? item : null,
      charm ? null : item,
    );
    sql.exec("DELETE FROM meta WHERE key = 'album_bonus'");
  });
}

async function bookSet(session: Session, set: AlbumSetDef, except: string | null = null) {
  for (const item of set.items) if (item.id !== except) await bookItem(session, item.id);
}

async function getAlbum(session: Session): Promise<AlbumResponse> {
  const response = await session.call(endpoints.album.path);
  expect(response.status, await response.clone().text()).toBe(200);
  return endpoints.album.response.parse(await response.json());
}

async function openCrate(session: Session, crateId: string): Promise<CrateOpenResponse> {
  const response = await session.call(endpoints.cratesOpen.path, { body: { crateId } });
  expect(response.status, await response.clone().text()).toBe(200);
  return endpoints.cratesOpen.response.parse(await response.json());
}

function counts(response: AlbumResponse): Map<string, number> {
  return new Map(response.sets.flatMap((set) => set.entries.map((e) => [e.id, e.count] as const)));
}

function cardOf(rewards: readonly Reward[]): CollectibleId | null {
  for (const reward of rewards) if (reward.kind === 'collectible') return reward.collectibleId;
  return null;
}

function setOf(response: AlbumResponse, id: string) {
  const set = response.sets.find((candidate) => candidate.id === id);
  if (set === undefined) throw new Error(`album response has no "${id}" set`);
  return set;
}

function ledgerRows(session: Session): Promise<number> {
  return inPlayer(
    session,
    (sql) => sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM ledger').one().n,
  );
}

function bufferMicros(session: Session): Promise<(number | null)[]> {
  return inPlayer(session, (sql) =>
    sql
      .exec<{
        micros: number | null;
      }>("SELECT mint_micros AS micros FROM coins WHERE state = 'buffer' ORDER BY rowid")
      .toArray()
      .map((row) => row.micros),
  );
}

function cachedBonus(session: Session): Promise<number | null> {
  return inPlayer(session, (sql) => {
    const row = sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'album_bonus'")
      .toArray()[0];
    return row === undefined ? null : Number(row.value);
  });
}

function completedBonus(response: AlbumResponse): number {
  return response.sets
    .filter((set) => set.completed)
    .reduce((bonus, set) => bonus + setDef(set.id).globalBonus, 0);
}

function microsWithBonus(bonus: number): number {
  return mintedCoinMicros(
    DROP_TIER,
    { ...FIRST_VENUE, coinValueMultiplier: FIRST_VENUE.coinValueMultiplier * (1 + bonus) },
    {},
  );
}

describe('GET /v1/album', () => {
  it('lists every economy set and item in config order, none owned, for a new player', async () => {
    const session = await newSession();
    const response = await getAlbum(session);
    expect(response).toEqual({
      sets: album.map((set) => ({
        id: set.id,
        completed: false,
        entries: set.items.map((item) => ({
          id: item.id,
          kind: item.id.endsWith('Charm')
            ? 'charm'
            : item.rarity === 'heirloom'
              ? 'heirloom'
              : 'coinSkin',
          owned: false,
          count: 0,
        })),
      })),
    });
    expect(setOf(response, GALA.id).entries.find((e) => e.id === 'duchessSovereign1891')).toEqual(
      expect.objectContaining({ kind: 'heirloom' }),
    );
    expect(await playerStub(session.tokens.playerId).envelopeTable()).toMatchObject({
      albumBonus: 0,
    });
  });

  it('counts the cards and charms real crate opens drew, and nothing else', async () => {
    const session = await newSession();
    const drawn = new Map<string, number>();
    const tally = (id: string | null) => {
      if (id !== null) drawn.set(id, (drawn.get(id) ?? 0) + 1);
    };
    for (let i = 0; i < 6; i++) {
      const crateId = await giveCrate(session);
      const opened = await openCrate(session, crateId);
      const card = cardOf(opened.roll.rewards);
      expect(card, 'every crate rarity carries an album card').not.toBeNull();
      tally(card);
      tally(
        await inPlayer(
          session,
          (sql) =>
            sql
              .exec<{
                charm: string | null;
              }>('SELECT charm_type AS charm FROM crate_opens WHERE crate_id = ?', crateId)
              .one().charm,
        ),
      );
    }

    const owned = counts(await getAlbum(session));
    for (const [id, count] of owned) expect(count, id).toBe(drawn.get(id) ?? 0);
    expect([...drawn.keys()].every((id) => owned.has(id))).toBe(true);
    await expectConserved(session);
  });

  it('raises the count on a duplicate card and keeps it owned', async () => {
    const session = await newSession();
    await bookItem(session, 'anchorCoin');
    await bookItem(session, 'anchorCoin');
    await bookItem(session, 'anchorCoin');
    await bookItem(session, 'captainsBellCharm');
    const entries = setOf(await getAlbum(session), DECK.id).entries;
    expect(entries.find((e) => e.id === 'anchorCoin')).toMatchObject({ owned: true, count: 3 });
    expect(entries.find((e) => e.id === 'captainsBellCharm')).toMatchObject({
      kind: 'charm',
      owned: true,
      count: 1,
    });
    expect(entries.find((e) => e.id === 'teakDeckCoin')).toMatchObject({ owned: false, count: 0 });
    await expectConserved(session);
  });

  it('completes a set only when every item is owned, and adds its globalBonus to the envelope', async () => {
    const session = await newSession();
    const stub = playerStub(session.tokens.playerId);
    const before = await stub.envelopeTable();

    await bookSet(session, DECK, 'compassRoseCoin');
    expect(setOf(await getAlbum(session), DECK.id).completed).toBe(false);
    expect((await stub.envelopeTable()).albumBonus).toBe(0);

    await bookItem(session, 'compassRoseCoin');
    await bookItem(session, 'teakDeckCoin');
    const response = await getAlbum(session);
    expect(response.sets.map((set) => [set.id, set.completed])).toEqual(
      album.map((set) => [set.id, set.id === DECK.id]),
    );

    const after = await stub.envelopeTable();
    expect(after).toEqual({ ...before, albumBonus: DECK.globalBonus });
    const limits = { before: rateEnvelopeFor(before), after: rateEnvelopeFor(after) };
    expect(limits.after.fallValue.max).toBeGreaterThan(limits.before.fallValue.max);
    expect({ ...limits.after, fallValue: null }).toEqual({ ...limits.before, fallValue: null });
    await expectConserved(session);
  });

  it('sums the bonus of every completed set', async () => {
    const session = await newSession();
    await bookSet(session, DECK);
    await bookSet(session, GALA);
    expect((await playerStub(session.tokens.playerId).envelopeTable()).albumBonus).toBeCloseTo(
      DECK.globalBonus + GALA.globalBonus,
      12,
    );
  });

  it('mints at the raised coin value once the open that completes a set lands', async () => {
    const session = await newSession();
    await bookSet(session, GALA, 'admiralsSovereign');
    expect(new Set(await bufferMicros(session))).toEqual(new Set([microsWithBonus(0)]));

    let completed: CrateOpenResponse | null = null;
    for (let i = 0; i < 20 && completed === null; i++) {
      const legendary = pity.rules.find((rule) => rule.rarity === 'legendary');
      if (legendary === undefined) throw new Error('economy pity has no legendary rule');
      await inPlayer(session, (sql) =>
        sql.exec(
          `INSERT INTO pity_counters (source, rarity, misses) VALUES ('vaultCrate', 'legendary', ?)
           ON CONFLICT (source, rarity) DO UPDATE SET misses = excluded.misses`,
          legendary.within - 1,
        ),
      );
      const opened = await openCrate(session, await giveCrate(session));
      if (cardOf(opened.roll.rewards) === 'admiralsSovereign') completed = opened;
    }
    if (completed === null) throw new Error('20 legendary-or-better opens never drew the card');

    const response = await getAlbum(session);
    expect(setOf(response, GALA.id).completed).toBe(true);
    expect(await cachedBonus(session)).toBe(completedBonus(response));
    expect(await cachedBonus(session)).toBe(GALA.globalBonus);
    const raised = microsWithBonus(GALA.globalBonus);
    expect(raised).toBeGreaterThan(microsWithBonus(0));
    expect(new Set(await bufferMicros(session))).toEqual(new Set([raised]));
    await dropAsClient(session, 3);
    expect(new Set(await bufferMicros(session))).toEqual(new Set([raised]));
    await expectConserved(session);
  });

  it('keeps the bonus every mint reads cached, equal to the album after real crate opens', async () => {
    const session = await newSession();
    await state(session);
    expect(await cachedBonus(session)).toBe(0);
    for (let i = 0; i < 6; i++) await openCrate(session, await giveCrate(session));
    expect(await cachedBonus(session)).toBe(completedBonus(await getAlbum(session)));

    await bookSet(session, DECK);
    expect(await cachedBonus(session)).toBeNull();
    expect((await playerStub(session.tokens.playerId).envelopeTable()).albumBonus).toBe(
      DECK.globalBonus,
    );
    expect(await cachedBonus(session)).toBe(completedBonus(await getAlbum(session)));
  });

  it('is read-only: fetching it writes nothing and replays no client value', async () => {
    const session = await newSession();
    await bookItem(session, 'anchorCoin');
    await state(session);
    const rows = await ledgerRows(session);
    const first = await getAlbum(session);
    const forged = await session.call(`${endpoints.album.path}?count=999&owned=true`);
    expect(forged.status).toBe(200);
    expect(endpoints.album.response.parse(await forged.json())).toEqual(first);
    expect(await ledgerRows(session)).toBe(rows);
    await expectError(
      await session.call(endpoints.album.path, { body: { sets: [] } }),
      404,
      'not_found',
    );
    expect(await getAlbum(session)).toEqual(first);
  });

  it('keeps each player to their own album', async () => {
    const mine = await newSession();
    const theirs = await newSession();
    await bookSet(theirs, DECK);
    expect(setOf(await getAlbum(theirs), DECK.id).completed).toBe(true);
    const own = await getAlbum(mine);
    expect(own.sets.every((set) => set.entries.every((entry) => entry.count === 0))).toBe(true);
    expect((await playerStub(mine.tokens.playerId).envelopeTable()).albumBonus).toBe(0);
  });

  it('needs a signed request with this device’s valid token', async () => {
    const session = await newSession();
    const other = await newSession();
    await expectError(
      await session.call(endpoints.album.path, { signature: null }),
      401,
      'invalid_signature',
    );
    await expectError(
      await session.call(endpoints.album.path, { accessToken: 'forged' }),
      401,
      'unauthorized',
    );
    const borrowed = await session.call(endpoints.album.path, {
      accessToken: other.tokens.accessToken,
    });
    expect(borrowed.status).toBe(401);
    await expectError(
      await session.call(endpoints.album.path, { signPath: '/v1/state' }),
      401,
      'invalid_signature',
    );
  });
});
