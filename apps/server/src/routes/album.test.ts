import {
  album,
  coinTiers,
  mintedCoinMicros,
  pity,
  rateEnvelopeFor,
  venues,
  type AlbumItemDef,
  type AlbumSetDef,
} from '@coinposh/economy';
import {
  endpoints,
  type AlbumResponse,
  type CollectibleId,
  type CrateOpenResponse,
  type IdempotencyKey,
  type Reward,
} from '@coinposh/shared';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { Entities } from '../do/entities.ts';
import { commit, LedgerTx } from '../do/ledger.ts';
import type { PlayerDO } from '../do/PlayerDO.ts';
import { newIdempotencyKey, newSession, type Session } from '../test/client.ts';
import { dropAsClient, expectConserved, expectError, playerStub, state } from '../test/game.ts';
import { CRATE_OPEN_TX_KIND } from './crates.ts';

const DECK = setDef('deckEssentials');
const CAPTAINS = setDef('captainsTable');
const GALA = setDef('sunsetGala');
const DROP_TIER = coinTiers[0];
const FIRST_VENUE = venues[0];

function setDef(id: string): AlbumSetDef {
  const set = album.find((candidate) => candidate.id === id);
  if (set === undefined) throw new Error(`economy album has no "${id}" set`);
  return set;
}

function isCharm(item: AlbumItemDef): boolean {
  return item.id.endsWith('Charm');
}

function cardsOf(set: AlbumSetDef): readonly AlbumItemDef[] {
  return set.items.filter((item) => !isCharm(item));
}

type SetPatch = Partial<Pick<AlbumSetDef, 'globalBonus' | 'items'>>;

/**
 * Runs `run` against a retuned economy album, as a deploy with a new config would serve it, and
 * puts the shipped numbers back afterwards. The server reads the same module the test does.
 */
async function retuned<T>(patches: Record<string, SetPatch>, run: () => Promise<T>): Promise<T> {
  const shipped = album.map((set) => ({ set, globalBonus: set.globalBonus, items: set.items }));
  try {
    for (const [id, patch] of Object.entries(patches)) Object.assign(setDef(id), patch);
    return await run();
  } finally {
    for (const { set, globalBonus, items } of shipped) Object.assign(set, { globalBonus, items });
  }
}

/** Sets that hold no charm until the server keeps a charm inventory (P-665). */
function charmFree(...sets: AlbumSetDef[]): Record<string, SetPatch> {
  return Object.fromEntries(sets.map((set) => [set.id, { items: cardsOf(set) }]));
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
 * Books an opened crate that drew `drawn`, with the legs and record openCrate writes: an album
 * card is minted into the inventory in the crate.open transaction, a charm is recorded only.
 * Nothing else runs, so the completed sets the server keeps move only on the next real open.
 */
async function bookOpen(session: Session, drawn: AlbumItemDef): Promise<void> {
  const crateId = await giveCrate(session);
  const charm = isCharm(drawn);
  await inPlayer(session, (sql) => {
    const context = { at: Date.now(), idempotencyKey: null };
    const tx = new LedgerTx(CRATE_OPEN_TX_KIND).move('inventory', 'house', 'crate', 1, crateId);
    if (!charm) tx.move('mint', 'inventory', 'collectible', 1, drawn.id);
    commit(sql, tx, context);
    sql.exec(
      `INSERT INTO crate_opens (crate_id, opened_at, rarity, scripted, charm_type, collectible_id)
       VALUES (?, ?, ?, 0, ?, ?)`,
      crateId,
      context.at,
      drawn.rarity,
      charm ? drawn.id : null,
      charm ? null : drawn.id,
    );
  });
}

async function bookCards(session: Session, set: AlbumSetDef, except: string | null = null) {
  for (const item of cardsOf(set)) if (item.id !== except) await bookOpen(session, item);
}

function itemDef(set: AlbumSetDef, id: string): AlbumItemDef {
  const item = set.items.find((candidate) => candidate.id === id);
  if (item === undefined) throw new Error(`album set "${set.id}" has no "${id}" item`);
  return item;
}

async function getAlbum(session: Session): Promise<AlbumResponse> {
  const response = await session.call(endpoints.album.path);
  expect(response.status, await response.clone().text()).toBe(200);
  return endpoints.album.response.parse(await response.json());
}

async function openCrate(
  session: Session,
  crateId: string,
  idempotencyKey: IdempotencyKey = newIdempotencyKey(),
): Promise<CrateOpenResponse> {
  const response = await session.call(endpoints.cratesOpen.path, {
    body: { crateId },
    idempotencyKey,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return endpoints.cratesOpen.response.parse(await response.json());
}

/** A real crate open, which is where the server re-derives the completed sets. */
async function landOpen(session: Session): Promise<CrateOpenResponse> {
  return openCrate(session, await giveCrate(session));
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

function completedIds(response: AlbumResponse): string[] {
  return response.sets.filter((set) => set.completed).map((set) => set.id);
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

function storedSets(session: Session): Promise<string | null> {
  return inPlayer(
    session,
    (sql) =>
      sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'album_sets'").toArray()[0]
        ?.value ?? null,
  );
}

async function albumBonus(session: Session): Promise<number> {
  return (await playerStub(session.tokens.playerId).envelopeTable()).albumBonus;
}

function microsWithBonus(bonus: number): number {
  return mintedCoinMicros(
    DROP_TIER,
    { ...FIRST_VENUE, coinValueMultiplier: FIRST_VENUE.coinValueMultiplier * (1 + bonus) },
    {},
  );
}

/** Drops a whole buffer's worth, so every coin left in it was minted after this point. */
async function cycleBuffer(session: Session): Promise<void> {
  await dropAsClient(session, (await state(session)).table.buffer.length);
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
          kind: isCharm(item) ? 'charm' : item.rarity === 'heirloom' ? 'heirloom' : 'coinSkin',
          owned: false,
          count: 0,
        })),
      })),
    });
    expect(setOf(response, GALA.id).entries.find((e) => e.id === 'duchessSovereign1891')).toEqual(
      expect.objectContaining({ kind: 'heirloom' }),
    );
    expect(await albumBonus(session)).toBe(0);
  });

  it('counts the cards real crate opens minted, and matches each to its ledger leg', async () => {
    const session = await newSession();
    const drawn = new Map<string, number>();
    for (let i = 0; i < 6; i++) {
      const card = cardOf((await landOpen(session)).roll.rewards);
      expect(card, 'every crate rarity carries an album card').not.toBeNull();
      if (card !== null) drawn.set(card, (drawn.get(card) ?? 0) + 1);
    }

    const owned = counts(await getAlbum(session));
    for (const [id, count] of owned) expect(count, id).toBe(drawn.get(id) ?? 0);
    expect([...drawn.keys()].every((id) => owned.has(id))).toBe(true);
    const minted = await inPlayer(session, (sql) =>
      sql
        .exec<{ ref: string; n: number }>(
          `SELECT ref, SUM(delta) AS n FROM ledger
           WHERE unit = 'collectible' AND account = 'inventory' GROUP BY ref`,
        )
        .toArray(),
    );
    expect(new Map(minted.map((row) => [row.ref, row.n]))).toEqual(drawn);
    await expectConserved(session);
  });

  it('raises the count on a duplicate card and keeps it owned', async () => {
    const session = await newSession();
    const anchor = itemDef(DECK, 'anchorCoin');
    for (let i = 0; i < 3; i++) await bookOpen(session, anchor);
    const entries = setOf(await getAlbum(session), DECK.id).entries;
    expect(entries.find((e) => e.id === 'anchorCoin')).toMatchObject({ owned: true, count: 3 });
    expect(entries.find((e) => e.id === 'teakDeckCoin')).toMatchObject({ owned: false, count: 0 });
    await expectConserved(session);
  });

  it('owns no charm from a crate draw, since the server keeps no charm inventory yet', async () => {
    const session = await newSession();
    for (const set of album) for (const item of set.items) await bookOpen(session, item);
    await landOpen(session);

    const response = await getAlbum(session);
    for (const set of response.sets) {
      for (const entry of set.entries) {
        expect(entry.owned, entry.id).toBe(entry.kind !== 'charm');
        if (entry.kind === 'charm') expect(entry.count, entry.id).toBe(0);
      }
      expect(set.completed, `${set.id} holds a charm`).toBe(false);
    }
    expect(await albumBonus(session)).toBe(0);
    expect(await storedSets(session)).toBe('[]');
    await expectConserved(session);
  });

  it('completes a set only when every item is owned, and adds its globalBonus to the envelope', async () => {
    await retuned(charmFree(DECK), async () => {
      const session = await newSession();
      const before = await playerStub(session.tokens.playerId).envelopeTable();

      await bookCards(session, DECK, 'compassRoseCoin');
      await landOpen(session);
      expect(setOf(await getAlbum(session), DECK.id).completed).toBe(false);
      expect(await albumBonus(session)).toBe(0);

      await bookOpen(session, itemDef(DECK, 'compassRoseCoin'));
      await landOpen(session);
      expect(completedIds(await getAlbum(session))).toEqual([DECK.id]);

      const after = await playerStub(session.tokens.playerId).envelopeTable();
      expect(after).toEqual({ ...before, albumBonus: DECK.globalBonus });
      const limits = { before: rateEnvelopeFor(before), after: rateEnvelopeFor(after) };
      expect(limits.after.fallValue.max).toBeGreaterThan(limits.before.fallValue.max);
      expect({ ...limits.after, fallValue: null }).toEqual({ ...limits.before, fallValue: null });
      await expectConserved(session);
    });
  });

  it('sums the bonus of every completed set', async () => {
    await retuned(charmFree(DECK, CAPTAINS, GALA), async () => {
      const session = await newSession();
      await bookCards(session, DECK);
      await bookCards(session, GALA);
      await landOpen(session);
      expect(await albumBonus(session)).toBeCloseTo(DECK.globalBonus + GALA.globalBonus, 12);
      expect(await storedSets(session)).toBe(JSON.stringify([DECK.id, GALA.id]));
    });
  });

  it('mints at the raised coin value once the open that completes a set lands', async () => {
    await retuned(charmFree(GALA), async () => {
      const session = await newSession();
      await bookCards(session, GALA, 'admiralsSovereign');
      expect(new Set(await bufferMicros(session))).toEqual(new Set([microsWithBonus(0)]));

      const legendary = pity.rules.find((rule) => rule.rarity === 'legendary');
      if (legendary === undefined) throw new Error('economy pity has no legendary rule');
      let completed: CrateOpenResponse | null = null;
      for (let i = 0; i < 20 && completed === null; i++) {
        await inPlayer(session, (sql) =>
          sql.exec(
            `INSERT INTO pity_counters (source, rarity, misses) VALUES ('vaultCrate', 'legendary', ?)
             ON CONFLICT (source, rarity) DO UPDATE SET misses = excluded.misses`,
            legendary.within - 1,
          ),
        );
        const opened = await landOpen(session);
        if (cardOf(opened.roll.rewards) === 'admiralsSovereign') completed = opened;
      }
      if (completed === null) throw new Error('20 legendary-or-better opens never drew the card');

      expect(completedIds(await getAlbum(session))).toEqual([GALA.id]);
      expect(await storedSets(session)).toBe(JSON.stringify([GALA.id]));
      const raised = microsWithBonus(GALA.globalBonus);
      expect(raised).toBeGreaterThan(microsWithBonus(0));
      expect(new Set(await bufferMicros(session))).toEqual(new Set([raised]));
      await dropAsClient(session, 3);
      expect(new Set(await bufferMicros(session))).toEqual(new Set([raised]));
      await expectConserved(session);
    });
  });

  it('prices completed sets from the economy on every read, so a retune reaches the player', async () => {
    const session = await newSession();
    await retuned(charmFree(DECK), async () => {
      await bookCards(session, DECK);
      await landOpen(session);
      expect(await storedSets(session)).toBe(JSON.stringify([DECK.id]));
      expect(await albumBonus(session)).toBe(DECK.globalBonus);
      await cycleBuffer(session);
      expect(new Set(await bufferMicros(session))).toEqual(
        new Set([microsWithBonus(DECK.globalBonus)]),
      );
    });

    const retunedBonus = 0.2;
    const shippedTable = await playerStub(session.tokens.playerId).envelopeTable();
    await retuned({ [DECK.id]: { items: cardsOf(DECK), globalBonus: retunedBonus } }, async () => {
      const table = await playerStub(session.tokens.playerId).envelopeTable();
      expect(table).toEqual({ ...shippedTable, albumBonus: retunedBonus });
      expect(rateEnvelopeFor(table).fallValue.max).toBeGreaterThan(
        rateEnvelopeFor(shippedTable).fallValue.max,
      );
      await cycleBuffer(session);
      expect(new Set(await bufferMicros(session))).toEqual(
        new Set([microsWithBonus(retunedBonus)]),
      );
      expect(await storedSets(session)).toBe(JSON.stringify([DECK.id]));
    });

    expect(await albumBonus(session)).toBe(DECK.globalBonus);
    await expectConserved(session);
  });

  it('re-derives the completed sets only on a real crate open, never from a read', async () => {
    await retuned(charmFree(DECK), async () => {
      const session = await newSession();
      await state(session);
      expect(await storedSets(session)).toBe('[]');

      await bookCards(session, DECK);
      await getAlbum(session);
      await state(session);
      expect(completedIds(await getAlbum(session))).toEqual([DECK.id]);
      expect(await storedSets(session)).toBe('[]');
      expect(await albumBonus(session)).toBe(0);

      await landOpen(session);
      expect(await storedSets(session)).toBe(JSON.stringify([DECK.id]));
      expect(await albumBonus(session)).toBe(DECK.globalBonus);
      await expectConserved(session);
    });
  });

  it('derives the completed sets once for a player saved before the server kept them', async () => {
    await retuned(charmFree(DECK), async () => {
      const session = await newSession();
      await bookCards(session, DECK);
      await inPlayer(session, (sql) => sql.exec("DELETE FROM meta WHERE key = 'album_sets'"));
      expect(await albumBonus(session)).toBe(DECK.globalBonus);
      expect(await storedSets(session)).toBe(JSON.stringify([DECK.id]));
    });
  });

  it('counts a replayed open once', async () => {
    const session = await newSession();
    const crateId = await giveCrate(session);
    const key = newIdempotencyKey();
    const first = await openCrate(session, crateId, key);
    expect(await openCrate(session, crateId, key)).toEqual(first);
    const card = cardOf(first.roll.rewards);
    if (card === null) throw new Error('the crate carried no album card');
    expect(counts(await getAlbum(session)).get(card)).toBe(1);

    const again = await session.call(endpoints.cratesOpen.path, { body: { crateId } });
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(counts(await getAlbum(session)).get(card)).toBe(1);
    await expectConserved(session);
  });

  it('trusts no album value a client sends', async () => {
    await retuned(charmFree(DECK), async () => {
      const session = await newSession();
      await bookOpen(session, itemDef(DECK, 'anchorCoin'));
      await state(session);
      const crateId = await giveCrate(session);
      const rows = await ledgerRows(session);
      const first = await getAlbum(session);

      const forgedQuery = await session.call(
        `${endpoints.album.path}?count=999&owned=true&completed=${DECK.id}&albumBonus=5`,
      );
      expect(forgedQuery.status).toBe(200);
      expect(endpoints.album.response.parse(await forgedQuery.json())).toEqual(first);
      await expectError(
        await session.call(endpoints.album.path, { body: { sets: [] } }),
        404,
        'not_found',
      );

      for (const forged of [
        { crateId, collectibleId: 'teakDeckCoin' },
        { crateId, albumBonus: 5 },
        { crateId, completed: [DECK.id] },
      ]) {
        await expectError(
          await session.call(endpoints.cratesOpen.path, { body: forged }),
          400,
          'validation_failed',
        );
      }
      await expectError(
        await session.call(endpoints.cratesOpen.path, { body: { crateId: 'crate_forged' } }),
        400,
        'validation_failed',
      );

      expect(await getAlbum(session)).toEqual(first);
      expect(await albumBonus(session)).toBe(0);
      expect(await ledgerRows(session)).toBe(rows);
      await expectConserved(session);
    });
  });

  it('keeps each player to their own album', async () => {
    await retuned(charmFree(DECK), async () => {
      const mine = await newSession();
      const theirs = await newSession();
      await bookCards(theirs, DECK);
      await landOpen(theirs);
      expect(setOf(await getAlbum(theirs), DECK.id).completed).toBe(true);
      expect(await albumBonus(theirs)).toBe(DECK.globalBonus);
      const own = await getAlbum(mine);
      expect(own.sets.every((set) => set.entries.every((entry) => entry.count === 0))).toBe(true);
      expect(await albumBonus(mine)).toBe(0);
    });
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
