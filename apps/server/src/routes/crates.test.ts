import {
  album,
  crateIncomeCoins,
  crateRewards,
  crateSpawn,
  createRng,
  dropTables,
  initialPityState,
  offlineRate,
  pity,
  rarityRank,
  rollDrop,
  safes,
  safeTypeDef,
  safeUnlocksAt,
  type CrateRewardDef,
  type PityState,
  type RarityId,
  type Rng,
} from '@coinposh/economy';
import {
  endpoints,
  ENTITY_ID_PREFIXES,
  errorStatus,
  HEADERS,
  type CrateId,
  type CrateOpenResponse,
  type IdempotencyKey,
  type Reward,
  type Wallet,
} from '@coinposh/shared';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { describe, expect, it } from 'vitest';
import { Entities } from '../do/entities.ts';
import { commit, LedgerTx } from '../do/ledger.ts';
import type { Command, DoResult, PlayerDO } from '../do/PlayerDO.ts';
import type { AppEnv } from '../http/context.ts';
import { IDEMPOTENT_REPLAYED_HEADER } from '../http/cors.ts';
import { ApiFailure } from '../http/errors.ts';
import { requestIdMiddleware } from '../http/signed.ts';
import { fairDigest, fairRngFromDigest } from '../rng/fair.ts';
import {
  API_ORIGIN,
  newIdempotencyKey,
  newSession,
  signParts,
  type Session,
} from '../test/client.ts';
import {
  claims,
  dropAsClient,
  expectConserved,
  expectError,
  playerStub,
  state,
} from '../test/game.ts';
import {
  ALBUM_CARDS,
  CRATE_CHARM_TYPES,
  CRATE_OPEN_TX_KIND,
  createCrateRoutes,
  drawCrate,
  type CrateHost,
} from './crates.ts';
import { measuredActiveRate } from './offline.ts';
import { readPity, SAFE_GRANT_TX_KIND } from './safes.ts';

const SOURCE = 'vaultCrate';
const VAULT_TABLE = (() => {
  const table = dropTables.find((candidate) => candidate.source === SOURCE);
  if (table === undefined) throw new Error(`economy has no ${SOURCE} table`);
  return table;
})();
const GOLD_SAFE_TABLE = (() => {
  const table = dropTables.find((candidate) => candidate.source === 'goldSafe');
  if (table === undefined) throw new Error('economy has no goldSafe table');
  return table;
})();
const CRATE_SAFE = safeTypeDef(safes.crateDrop.type);

function inPlayer<T>(session: Session, run: (sql: SqlStorage) => T): Promise<T> {
  return runInDurableObject(playerStub(session.tokens.playerId), (_: PlayerDO, ctx) =>
    ctx.storage.transactionSync(() => run(ctx.storage.sql)),
  );
}

/**
 * A crate the server spawned and the player pushed off `edge`, booked through the same
 * crate.spawn and claim.crate legs a real drop and claim post. `edge: null` leaves it on the table.
 */
function giveCrate(session: Session, edge: 'front' | 'side' | null = 'front'): Promise<CrateId> {
  return inPlayer(session, (sql) => {
    const context = { at: Date.now(), idempotencyKey: null };
    const crate = new Entities(sql).spawnCrate('vault', 0, context.at);
    commit(sql, new LedgerTx('crate.spawn').move('mint', 'table', 'crate', 1, crate.id), context);
    if (edge !== null) {
      new Entities(sql).settleCrate(crate.id, edge === 'front' ? 'claimed' : 'lost', context.at);
      commit(
        sql,
        new LedgerTx('claim.crate').move(
          'table',
          edge === 'front' ? 'inventory' : 'house',
          'crate',
          1,
          crate.id,
        ),
        context,
      );
    }
    return crate.id;
  });
}

function setPity(session: Session, misses: PityState): Promise<void> {
  return inPlayer(session, (sql) => {
    for (const [rarity, count] of Object.entries(misses)) {
      sql.exec(
        `INSERT INTO pity_counters (source, rarity, misses) VALUES (?, ?, ?)
         ON CONFLICT (source, rarity) DO UPDATE SET misses = excluded.misses`,
        SOURCE,
        rarity,
        count,
      );
    }
  });
}

function postOpen(
  session: Session,
  body: unknown,
  idempotencyKey: IdempotencyKey = newIdempotencyKey(),
): Promise<Response> {
  return session.call(endpoints.cratesOpen.path, { body, idempotencyKey });
}

async function openOk(response: Response): Promise<CrateOpenResponse> {
  expect(response.status, await response.clone().text()).toBe(200);
  return endpoints.cratesOpen.response.parse(await response.json());
}

interface OpenRecord extends Record<string, SqlStorageValue> {
  readonly opened_at: number;
  readonly rarity: string;
  readonly scripted: number;
  readonly charm_type: string | null;
  readonly collectible_id: string | null;
  readonly safe_id: string | null;
}

function openRecord(session: Session, crateId: string): Promise<OpenRecord | undefined> {
  return inPlayer(
    session,
    (sql) =>
      sql
        .exec<OpenRecord>(
          `SELECT opened_at, rarity, scripted, charm_type, collectible_id, safe_id
           FROM crate_opens WHERE crate_id = ?`,
          crateId,
        )
        .toArray()[0],
  );
}

interface LedgerLeg extends Record<string, SqlStorageValue> {
  readonly tx_id: string;
  readonly account: string;
  readonly unit: string;
  readonly delta: number;
  readonly ref: string | null;
  readonly at: number;
  readonly idempotency_key: string | null;
}

function ledgerOf(session: Session, kind: string): Promise<LedgerLeg[]> {
  return inPlayer(session, (sql) =>
    sql
      .exec<LedgerLeg>(
        'SELECT tx_id, account, unit, delta, ref, at, idempotency_key FROM ledger WHERE kind = ? ORDER BY seq',
        kind,
      )
      .toArray(),
  );
}

function ledgerRows(session: Session): Promise<number> {
  return inPlayer(
    session,
    (sql) => sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM ledger').one().n,
  );
}

function txCount(legs: readonly LedgerLeg[]): number {
  return new Set(legs.map((leg) => leg.tx_id)).size;
}

function fairSecret(session: Session): Promise<string> {
  return inPlayer(session, (sql) => {
    const chained = sql
      .exec<{ server_seed: string }>('SELECT server_seed FROM fair_seeds WHERE revealed_at IS NULL')
      .toArray()[0];
    if (chained !== undefined) return chained.server_seed;
    return sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'fair_server_seed'")
      .one().value;
  });
}

function currencyRewards(rewards: readonly Reward[]): Partial<Wallet> {
  const paid: Partial<Record<keyof Wallet, number>> = {};
  for (const reward of rewards) {
    if (reward.kind !== 'currency') continue;
    paid[reward.currency] = (paid[reward.currency] ?? 0) + reward.amount;
  }
  return paid;
}

function expectedPayout(rarity: RarityId, activeRate: number): Partial<Wallet> {
  const reward = crateRewards[rarity];
  const paid: Partial<Record<keyof Wallet, number>> = {};
  const amounts: [keyof Wallet, number][] = [
    ['coins', crateIncomeCoins(reward.incomeSeconds, activeRate, offlineRate)],
    ['pearls', reward.pearls],
    ['keys', reward.keys],
    ['tickets', reward.tickets],
  ];
  for (const [currency, amount] of amounts) if (amount > 0) paid[currency] = amount;
  return paid;
}

interface DemoDraw {
  readonly rarity: RarityId;
  readonly pity: PityState;
  readonly charmType: string | null;
  readonly collectibleId: string | null;
  readonly safe: boolean;
}

/**
 * Demo's crate open, written out as apps/web/src/net/mock/world.ts #rollWithRng and #grant draw
 * it: rarity (scripted for the FTUE crate), then the charm chance and kind, then the album card,
 * with the agreed safe draw (P-533) appended last. Built from economy config on its own, so a
 * change to the server's draw order fails here instead of agreeing with itself.
 */
function demoDraw(rng: Rng, pityState: PityState, ftue: boolean): DemoDraw {
  const items = album.flatMap(
    (set): readonly { readonly id: string; readonly rarity: RarityId }[] => set.items,
  );
  const charmTypes = items.filter((item) => item.id.endsWith('Charm'));
  const albumCards = items.filter((item) => !item.id.endsWith('Charm'));
  const drawn = ftue
    ? { rarity: crateSpawn.ftueScriptedRarity as RarityId, state: pityState }
    : rollDrop(VAULT_TABLE, pity, pityState, rng);
  const def: CrateRewardDef = crateRewards[drawn.rarity];
  let charmType: string | null = null;
  const forceCharm = ftue && crateSpawn.ftueScriptedCharm;
  if (charmTypes.length > 0 && (forceCharm || rng.nextInt(10_000) < def.charmChance)) {
    charmType = charmTypes[rng.nextInt(charmTypes.length)]?.id ?? null;
  }
  let collectibleId: string | null = null;
  if (def.albumCard) {
    const cards = albumCards.filter((item) => item.rarity === drawn.rarity);
    collectibleId = cards[cards.length > 0 ? rng.nextInt(cards.length) : 0]?.id ?? null;
  }
  const safe = rng.nextInt(10_000) < def.safeChance;
  return { rarity: drawn.rarity, pity: drawn.state, charmType, collectibleId, safe };
}

function collectibleOf(rewards: readonly Reward[]): string | null {
  const cards = rewards.flatMap((reward) =>
    reward.kind === 'collectible' ? [reward.collectibleId] : [],
  );
  expect(cards.length).toBeLessThanOrEqual(1);
  return cards[0] ?? null;
}

function safesOf(rewards: readonly Reward[]) {
  return rewards.flatMap((reward) => (reward.kind === 'safe' ? [reward.safe] : []));
}

describe('POST /v1/crates/open', () => {
  it('opens the crate a real drop spawned and a front-edge claim put in the inventory', async () => {
    const session = await newSession();
    await dropAsClient(session, crateSpawn.ftueScriptedDrop);
    const crate = (await state(session)).table.crates[0];
    if (crate === undefined) throw new Error('the scripted drop spawned no crate');
    await expectError(await postOpen(session, { crateId: crate.id }), 409, 'not_ready');

    const claimed = await claims(session, [
      { kind: 'crate', crateId: crate.id, tick: 0, edge: 'front' },
    ]);
    expect(claimed.results).toEqual([
      { status: 'accepted', credited: 0, cascade: null, minted: null },
    ]);
    const before = await state(session);
    const activeRate = await inPlayer(session, measuredActiveRate);

    const opened = await openOk(await postOpen(session, { crateId: crate.id }));
    expect(opened.crateId).toBe(crate.id);
    expect(opened.roll.rarity).toBe(crateSpawn.ftueScriptedRarity);
    expect(currencyRewards(opened.roll.rewards)).toEqual(
      expectedPayout(opened.roll.rarity, activeRate),
    );
    const after = await state(session);
    expect(after.wallet).toEqual(opened.wallet);
    expect(after.wallet.pearls - before.wallet.pearls).toBe(
      crateRewards[opened.roll.rarity].pearls,
    );
    expect(await openRecord(session, crate.id)).toMatchObject({
      rarity: crateSpawn.ftueScriptedRarity,
      scripted: 1,
    });
    expect((await openRecord(session, crate.id))?.charm_type).not.toBeNull();
    await expectConserved(session);
  });

  it('books one crate.open: crate inventory → house, every currency and the album card from the mint', async () => {
    const session = await newSession();
    const crateId = await giveCrate(session);
    const key = newIdempotencyKey();
    const opened = await openOk(await postOpen(session, { crateId }, key));
    const legs = await ledgerOf(session, CRATE_OPEN_TX_KIND);
    expect(txCount(legs)).toBe(1);

    const card = collectibleOf(opened.roll.rewards);
    expect(card).not.toBeNull();
    const expected = [
      { account: 'inventory', unit: 'crate', delta: -1, ref: crateId },
      { account: 'house', unit: 'crate', delta: 1, ref: crateId },
      ...Object.entries(currencyRewards(opened.roll.rewards)).flatMap(([unit, amount]) => [
        { account: 'mint', unit, delta: -amount, ref: crateId },
        { account: 'wallet', unit, delta: amount, ref: crateId },
      ]),
      { account: 'mint', unit: 'collectible', delta: -1, ref: card },
      { account: 'inventory', unit: 'collectible', delta: 1, ref: card },
    ];
    expect(legs.map(({ account, unit, delta, ref }) => ({ account, unit, delta, ref }))).toEqual(
      expected,
    );
    expect(legs.every((leg) => leg.idempotency_key === key)).toBe(true);

    const report = await playerStub(session.tokens.playerId).conservation();
    expect(report).toMatchObject({
      conserved: true,
      cratesHeld: 0,
      ledgerCratesHeld: 0,
      collectiblesHeld: 1,
      ledgerCollectiblesHeld: 1,
    });
  });

  it('stamps the open with the server clock, whatever clock headers the client sends', async () => {
    const session = await newSession();
    const crateId = await giveCrate(session);
    const before = Date.now();
    const response = await session.call(endpoints.cratesOpen.path, {
      body: { crateId },
      idempotencyKey: newIdempotencyKey(),
    });
    await openOk(response);
    const after = Date.now();
    const record = await openRecord(session, crateId);
    expect(record?.opened_at).toBeGreaterThanOrEqual(before);
    expect(record?.opened_at).toBeLessThanOrEqual(after);
    for (const leg of await ledgerOf(session, CRATE_OPEN_TX_KIND)) {
      expect(leg.at).toBe(record?.opened_at);
    }
  });

  it('counts held crates in conservation until they open', async () => {
    const session = await newSession();
    const a = await giveCrate(session);
    await giveCrate(session);
    expect(await playerStub(session.tokens.playerId).conservation()).toMatchObject({
      conserved: true,
      cratesHeld: 2,
      ledgerCratesHeld: 2,
    });
    await openOk(await postOpen(session, { crateId: a }));
    expect(await playerStub(session.tokens.playerId).conservation()).toMatchObject({
      conserved: true,
      cratesHeld: 1,
      ledgerCratesHeld: 1,
    });
  });
});

describe('a crate opens exactly once', () => {
  it('replays the same Idempotency-Key with the same contents, rolling and paying once', async () => {
    const session = await newSession();
    const crateId = await giveCrate(session);
    const key = newIdempotencyKey();
    const first = await postOpen(session, { crateId }, key);
    const firstBody = await openOk(first);
    expect(first.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull();
    const after = await state(session);

    const replay = await postOpen(session, { crateId }, key);
    expect(await openOk(replay)).toEqual(firstBody);
    expect(replay.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('true');
    const again = await state(session);
    expect(again.fair).toEqual(after.fair);
    expect(again.wallet).toEqual(after.wallet);
    expect(txCount(await ledgerOf(session, CRATE_OPEN_TX_KIND))).toBe(1);
    await expectConserved(session);
  });

  it('refuses a second open under a new key with conflict, paying and rolling nothing more', async () => {
    const session = await newSession();
    const crateId = await giveCrate(session);
    await openOk(await postOpen(session, { crateId }));
    const after = await state(session);
    const rows = await ledgerRows(session);
    for (let i = 0; i < 3; i++) {
      await expectError(await postOpen(session, { crateId }), 409, 'conflict');
    }
    const again = await state(session);
    expect(again.wallet).toEqual(after.wallet);
    expect(again.fair).toEqual(after.fair);
    expect(await ledgerRows(session)).toBe(rows);
    await expectConserved(session);
  });

  it('lets exactly one of several racing opens through', async () => {
    const session = await newSession();
    const crateId = await giveCrate(session);
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => postOpen(session, { crateId })),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409, 409, 409]);
    expect(txCount(await ledgerOf(session, CRATE_OPEN_TX_KIND))).toBe(1);
    await expectConserved(session);
  });

  it('refuses a reused Idempotency-Key for a different crate and leaves that crate held', async () => {
    const session = await newSession();
    const a = await giveCrate(session);
    const b = await giveCrate(session);
    const key = newIdempotencyKey();
    await openOk(await postOpen(session, { crateId: a }, key));
    await expectError(await postOpen(session, { crateId: b }, key), 422, 'idempotency_key_reused');
    expect(await openRecord(session, b)).toBeUndefined();
    expect(await playerStub(session.tokens.playerId).conservation()).toMatchObject({
      conserved: true,
      cratesHeld: 1,
    });
  });

  it('keeps an open final in storage: no rewrite, no delete, no second record', async () => {
    const session = await newSession();
    const crateId = await giveCrate(session);
    await openOk(await postOpen(session, { crateId }));
    await inPlayer(session, (sql) => {
      expect(() =>
        sql.exec("UPDATE crate_opens SET rarity = 'heirloom' WHERE crate_id = ?", crateId),
      ).toThrow(/opens once/);
      expect(() => sql.exec('DELETE FROM crate_opens WHERE crate_id = ?', crateId)).toThrow(
        /append-only/,
      );
      expect(() =>
        sql.exec(
          "INSERT INTO crate_opens (crate_id, opened_at, rarity, scripted) VALUES (?, 0, 'heirloom', 0)",
          crateId,
        ),
      ).toThrow(/UNIQUE|PRIMARY KEY/);
    });
    expect(await openRecord(session, crateId)).toMatchObject({ scripted: 0 });
  });
});

describe('only a crate the player holds opens', () => {
  it('refuses a crate still riding the table with not_ready, and one lost down the side with conflict', async () => {
    const session = await newSession();
    const onTable = await giveCrate(session, null);
    const lost = await giveCrate(session, 'side');
    const before = await state(session);
    const rows = await ledgerRows(session);
    await expectError(await postOpen(session, { crateId: onTable }), 409, 'not_ready');
    await expectError(await postOpen(session, { crateId: lost }), 409, 'conflict');
    expect(errorStatus('not_ready')).toBe(409);
    const after = await state(session);
    expect(after.wallet).toEqual(before.wallet);
    expect(after.fair).toEqual(before.fair);
    expect(await ledgerRows(session)).toBe(rows);
    await expectConserved(session);
  });

  it('refuses foreign and forged crate IDs alike with not_found, moving nothing', async () => {
    const owner = await newSession();
    const thief = await newSession();
    const theirs = await giveCrate(owner);
    const before = await state(thief);
    const rows = await ledgerRows(thief);
    for (const crateId of [theirs, `${ENTITY_ID_PREFIXES.crate}_${'A'.repeat(20)}`]) {
      await expectError(await postOpen(thief, { crateId }), 404, 'not_found');
    }
    for (const crateId of [
      'crate_short',
      `${ENTITY_ID_PREFIXES.safe}_${'A'.repeat(20)}`,
      `${ENTITY_ID_PREFIXES.crate}_${'A'.repeat(19)}!`,
      "crate_AAAAAAAAAAAAAAAAAA' OR 1=1 --",
      '',
      42,
      null,
    ]) {
      await expectError(await postOpen(thief, { crateId }), 400, 'validation_failed');
    }
    const after = await state(thief);
    expect(after.wallet).toEqual(before.wallet);
    expect(after.fair).toEqual(before.fair);
    expect(await ledgerRows(thief)).toBe(rows);
    expect(await openOk(await postOpen(owner, { crateId: theirs }))).toMatchObject({
      crateId: theirs,
    });
  });

  it('refuses client-sent rolls, rarities, rewards, wallets, pity and times before touching the crate', async () => {
    const session = await newSession();
    const crateId = await giveCrate(session);
    const before = await state(session);
    for (const forged of [
      { crateId, roll: { rarity: 'heirloom' } },
      { crateId, rarity: 'legendary' },
      { crateId, wallet: { pearls: 9_999 } },
      { crateId, rewards: [{ kind: 'currency', currency: 'coins', amount: 1e9 }] },
      { crateId, collectibleId: 'duchessSovereign1891' },
      { crateId, safe: true },
      { crateId, pity: { legendary: 119 } },
      { crateId, at: Date.now() + 1e9 },
      { crateId, nonce: 0 },
      { crateIds: [crateId, crateId] },
      {},
    ]) {
      await expectError(await postOpen(session, forged), 400, 'validation_failed');
    }
    const after = await state(session);
    expect(after.wallet).toEqual(before.wallet);
    expect(after.fair).toEqual(before.fair);
    expect(await openRecord(session, crateId)).toBeUndefined();
  });

  it('needs a signed request, a valid token and an Idempotency-Key', async () => {
    const session = await newSession();
    const crateId = await giveCrate(session);
    const body = { crateId };
    await expectError(
      await session.call(endpoints.cratesOpen.path, { body, idempotencyKey: null }),
      400,
      'idempotency_key_missing',
    );
    await expectError(
      await session.call(endpoints.cratesOpen.path, { body, signature: null }),
      401,
      'invalid_signature',
    );
    await expectError(
      await session.call(endpoints.cratesOpen.path, { body, accessToken: 'forged' }),
      401,
      'unauthorized',
    );
    expect(await openRecord(session, crateId)).toBeUndefined();
  });

  it('refuses a claimed crate the ledger never put in the inventory, as a broken invariant', async () => {
    const session = await newSession();
    const planted = await inPlayer(session, (sql) => {
      const crate = new Entities(sql).spawnCrate('vault', 0, Date.now());
      new Entities(sql).settleCrate(crate.id, 'claimed', Date.now());
      return crate.id;
    });
    const before = await state(session);
    const rows = await ledgerRows(session);
    await expectError(await postOpen(session, { crateId: planted }), 500, 'internal');
    const after = await state(session);
    expect(after.wallet).toEqual(before.wallet);
    expect(after.fair).toEqual(before.fair);
    expect(await ledgerRows(session)).toBe(rows);
    expect(await openRecord(session, planted)).toBeUndefined();
  });
});

describe('the open roll', () => {
  it('draws rarity, charm, album card and safe from the committed seed in Demo order, and writes pity', async () => {
    const session = await newSession();
    const committed = (await state(session)).fair;
    let pityBefore = await inPlayer(session, (sql) => readPity(sql, SOURCE));
    expect(pityBefore).toEqual(initialPityState(pity));
    const opens = 12;
    for (let i = 0; i < opens; i++) {
      const crateId = await giveCrate(session);
      const secret = await fairSecret(session);
      const opened = await openOk(await postOpen(session, { crateId }));
      expect(opened.roll.proof).toEqual({ ...committed, nonce: committed.nonce + i });

      const rng = fairRngFromDigest(
        fairDigest(secret, opened.roll.proof.clientSeed, opened.roll.proof.nonce),
      );
      const demo = demoDraw(rng, pityBefore, false);
      expect(opened.roll.rarity).toBe(demo.rarity);
      expect(collectibleOf(opened.roll.rewards)).toBe(demo.collectibleId);
      expect(safesOf(opened.roll.rewards)).toHaveLength(demo.safe ? 1 : 0);
      expect(await openRecord(session, crateId)).toMatchObject({
        rarity: demo.rarity,
        scripted: 0,
        charm_type: demo.charmType,
        collectible_id: demo.collectibleId,
      });
      expect(opened.roll.pity).toEqual({
        rare: demo.pity.rare,
        exquisite: demo.pity.exquisite,
        legendary: demo.pity.legendary,
      });
      pityBefore = demo.pity;
    }
    expect((await state(session)).fair).toEqual({ ...committed, nonce: committed.nonce + opens });
    expect(await inPlayer(session, (sql) => readPity(sql, SOURCE))).toEqual(pityBefore);
    await expectConserved(session);
  });

  it('scripts the FTUE crate as Demo does: fixed rarity and charm, pity untouched', async () => {
    const session = await newSession();
    await dropAsClient(session, crateSpawn.ftueScriptedDrop);
    const crate = (await state(session)).table.crates[0];
    if (crate === undefined) throw new Error('the scripted drop spawned no crate');
    await claims(session, [{ kind: 'crate', crateId: crate.id, tick: 0, edge: 'front' }]);
    await setPity(session, { rare: 3, exquisite: 5, legendary: 7 });
    const pityBefore = await inPlayer(session, (sql) => readPity(sql, SOURCE));
    const secret = await fairSecret(session);

    const opened = await openOk(await postOpen(session, { crateId: crate.id }));
    const rng = fairRngFromDigest(
      fairDigest(secret, opened.roll.proof.clientSeed, opened.roll.proof.nonce),
    );
    const demo = demoDraw(rng, pityBefore, true);
    expect(demo.charmType).not.toBeNull();
    expect(opened.roll.rarity).toBe(crateSpawn.ftueScriptedRarity);
    expect(opened.roll.pity).toEqual({ rare: 3, exquisite: 5, legendary: 7 });
    expect(collectibleOf(opened.roll.rewards)).toBe(demo.collectibleId);
    expect(await openRecord(session, crate.id)).toMatchObject({
      scripted: 1,
      charm_type: demo.charmType,
      collectible_id: demo.collectibleId,
    });
    expect(await inPlayer(session, (sql) => readPity(sql, SOURCE))).toEqual(pityBefore);

    const later = await giveCrate(session);
    await openOk(await postOpen(session, { crateId: later }));
    expect(await openRecord(session, later)).toMatchObject({ scripted: 0 });
  });

  it('forces each pitied rarity when its counter would expire', async () => {
    for (const rule of pity.rules) {
      const session = await newSession();
      await setPity(session, { [rule.rarity]: rule.within - 1 });
      const opened = await openOk(await postOpen(session, { crateId: await giveCrate(session) }));
      expect(rarityRank(opened.roll.rarity)).toBeGreaterThanOrEqual(rarityRank(rule.rarity));
      expect(opened.roll.pity[rule.rarity]).toBe(0);
    }
  });

  it('keeps vaultCrate pity apart from other sources', async () => {
    const session = await newSession();
    await inPlayer(session, (sql) => {
      sql.exec("INSERT INTO pity_counters (source, rarity, misses) VALUES ('goldSafe', 'rare', 7)");
    });
    await openOk(await postOpen(session, { crateId: await giveCrate(session) }));
    expect(await inPlayer(session, (sql) => readPity(sql, 'goldSafe'))).toMatchObject({ rare: 7 });
    expect(await inPlayer(session, (sql) => readPity(sql, SOURCE))).not.toEqual(
      initialPityState(pity),
    );
  });
});

describe('a crate that rolls a safe', () => {
  it('grants a safe sourced crate:<id> with unlocksAt from safeUnlocksAt on the server clock', async () => {
    const session = await newSession();
    const legendary = pity.rules.find((rule) => rule.rarity === 'legendary');
    if (legendary === undefined) throw new Error('economy pities no legendary');
    let found: { crateId: CrateId; opened: CrateOpenResponse } | null = null;
    for (let i = 0; i < 40 && found === null; i++) {
      await setPity(session, { legendary: legendary.within - 1 });
      const crateId = await giveCrate(session);
      const opened = await openOk(await postOpen(session, { crateId }));
      if (safesOf(opened.roll.rewards).length > 0) found = { crateId, opened };
    }
    if (found === null) throw new Error('40 legendary-or-better opens rolled no safe');
    const { crateId, opened } = found;

    const [safe] = safesOf(opened.roll.rewards);
    const record = await openRecord(session, crateId);
    if (safe === undefined || record === undefined) throw new Error('the safe was not recorded');
    expect(safe.type).toBe(CRATE_SAFE.id);
    expect(safe.unlocksAt).toBe(safeUnlocksAt(CRATE_SAFE.id, record.opened_at));
    expect(record.safe_id).toBe(safe.id);
    const row = await inPlayer(session, (sql) =>
      sql
        .exec<{ source: string; state: string; granted_at: number; unlocks_at: number }>(
          'SELECT source, state, granted_at, unlocks_at FROM safes WHERE id = ?',
          safe.id,
        )
        .one(),
    );
    expect(row).toEqual({
      source: `crate:${crateId}`,
      state: 'locked',
      granted_at: record.opened_at,
      unlocks_at: safe.unlocksAt,
    });
    const grants = (await ledgerOf(session, SAFE_GRANT_TX_KIND)).filter(
      (leg) => leg.ref === safe.id,
    );
    expect(grants.map(({ account, unit, delta }) => ({ account, unit, delta }))).toEqual([
      { account: 'mint', unit: 'safe', delta: -1 },
      { account: 'inventory', unit: 'safe', delta: 1 },
    ]);
    expect((await state(session)).inventory.safes).toContainEqual(safe);
    await expectConserved(session);
  });

  it('never rolls a safe off a safe-sourced table, only off safes.crateDrop.source', () => {
    for (let seed = 0; seed < 500; seed++) {
      const draw = drawCrate(GOLD_SAFE_TABLE, initialPityState(pity), createRng(seed), false);
      expect(draw.safe).toBe(false);
    }
    expect(VAULT_TABLE.source).toBe(safes.crateDrop.source);
  });
});

describe('drawCrate', () => {
  it('matches the Demo order on every rarity for many seeds, scripted or not', () => {
    const seen = new Set<RarityId>();
    for (let seed = 0; seed < 2_000; seed++) {
      for (const scripted of [false, true]) {
        const start = initialPityState(pity);
        const server = drawCrate(VAULT_TABLE, start, createRng(seed), scripted);
        const demo = demoDraw(createRng(seed), start, scripted);
        expect(server).toEqual(demo);
        seen.add(server.rarity);
      }
    }
    expect(seen.size).toBeGreaterThanOrEqual(5);
  });

  it('draws charm kinds and album cards only from the economy album, of the rolled rarity', () => {
    expect(CRATE_CHARM_TYPES.length).toBeGreaterThan(0);
    for (let seed = 0; seed < 500; seed++) {
      const draw = drawCrate(VAULT_TABLE, initialPityState(pity), createRng(seed), false);
      if (draw.charmType !== null) expect(CRATE_CHARM_TYPES).toContain(draw.charmType);
      const card = ALBUM_CARDS.find((item) => item.id === draw.collectibleId);
      expect(card?.rarity).toBe(draw.rarity);
    }
  });
});

function recordingHost(result: DoResult<CrateOpenResponse>) {
  const commands: Command<unknown>[] = [];
  const host: CrateHost = {
    openCrate(command) {
      commands.push(command);
      return Promise.resolve(result);
    },
  };
  return { host, commands };
}

function appFor(host: CrateHost): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use(requestIdMiddleware);
  app.route(
    '/',
    createCrateRoutes(() => host),
  );
  app.onError((error, c) => {
    if (!(error instanceof ApiFailure)) return c.json({ error: { code: 'internal' } }, 500);
    return c.json(error.envelope(c.get('requestId')), error.status as ContentfulStatusCode);
  });
  return app;
}

async function postTo(app: Hono<AppEnv>, session: Session, body: unknown): Promise<Response> {
  const path = endpoints.cratesOpen.path;
  const raw = JSON.stringify(body);
  const key = newIdempotencyKey();
  const headers = new Headers({
    'Content-Type': 'application/json',
    [HEADERS.authorization]: `Bearer ${session.tokens.accessToken}`,
    [HEADERS.idempotencyKey]: key,
    [HEADERS.deviceSignature]: await signParts(session.device.privateKey, 'POST', path, key, raw),
  });
  return app.fetch(
    new Request(`${API_ORIGIN}${path}`, { method: 'POST', headers, body: raw }),
    env,
  );
}

describe('createCrateRoutes', () => {
  it('forwards only the crate ID, and refuses client-sent results before reaching the player', async () => {
    const session = await newSession();
    const crateId = `${ENTITY_ID_PREFIXES.crate}_${'b'.repeat(20)}`;
    const { host, commands } = recordingHost({
      ok: false,
      error: { code: 'not_found', message: 'No crate.' },
    });
    const app = appFor(host);
    await expectError(await postTo(app, session, { crateId }), 404, 'not_found');
    expect(commands).toHaveLength(1);
    expect(commands[0]?.body).toEqual({ crateId });

    for (const forged of [
      { crateId, roll: { rarity: 'legendary' } },
      { crateId, wallet: { coins: 1e9 } },
    ]) {
      await expectError(await postTo(app, session, forged), 400, 'validation_failed');
    }
    expect(commands).toHaveLength(1);
  });

  it('refuses a host answer that breaks the response contract instead of passing it on', async () => {
    const session = await newSession();
    const crateId = `${ENTITY_ID_PREFIXES.crate}_${'c'.repeat(20)}`;
    const wallet = (await state(session)).wallet;
    const { host } = recordingHost({
      ok: true,
      replayed: false,
      body: {
        crateId,
        roll: {
          rarity: 'common',
          rewards: [],
          proof: { serverSeedHash: 'a'.repeat(64), clientSeed: 'seedseedseedseed', nonce: 0 },
          pity: { rare: 0, exquisite: 0, legendary: 0 },
        },
        wallet,
      } as unknown as CrateOpenResponse,
    });
    expect((await postTo(appFor(host), session, { crateId })).status).toBe(500);
  });
});
