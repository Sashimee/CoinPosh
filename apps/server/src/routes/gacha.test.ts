import {
  crateIncomeCoins,
  crateRewards,
  dropTables,
  offlineRate,
  pity,
  rarityRank,
  type PityState,
} from '@coinposh/economy';
import {
  endpoints,
  HEADERS,
  MAX_GACHA_PULLS,
  type GachaPullResponse,
  type IdempotencyKey,
  type Reward,
  type Wallet,
} from '@coinposh/shared';
import { runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { describe, expect, it } from 'vitest';
import { commit, LedgerTx, TX_KINDS } from '../do/ledger.ts';
import { PlayerDO, type Command, type DoResult } from '../do/PlayerDO.ts';
import { MIGRATIONS } from '../do/schema.ts';
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
import { expectConserved, expectError, playerStub, state } from '../test/game.ts';
import { drawCrate } from './crates.ts';
import {
  createGachaRoutes,
  GACHA_DROP_SOURCE,
  GACHA_PULL_TX_KIND,
  GACHA_SQL,
  GACHA_TICKETS_PER_PULL,
  type GachaHost,
} from './gacha.ts';
import { measuredActiveRate } from './offline.ts';
import { readPity } from './safes.ts';

const GACHA_TABLE = (() => {
  const table = dropTables.find((candidate) => candidate.source === GACHA_DROP_SOURCE);
  if (table === undefined) throw new Error(`economy has no ${GACHA_DROP_SOURCE} table`);
  return table;
})();

function inPlayer<T>(session: Session, run: (sql: SqlStorage) => T): Promise<T> {
  return runInDurableObject(playerStub(session.tokens.playerId), (_: PlayerDO, ctx) =>
    ctx.storage.transactionSync(() => run(ctx.storage.sql)),
  );
}

function giveTickets(session: Session, tickets: number): Promise<void> {
  return inPlayer(session, (sql) => {
    commit(sql, new LedgerTx('grant.starting').move('mint', 'wallet', 'tickets', tickets, null), {
      at: Date.now(),
      idempotencyKey: null,
    });
  });
}

function setPity(session: Session, misses: PityState): Promise<void> {
  return inPlayer(session, (sql) => {
    for (const [rarity, count] of Object.entries(misses)) {
      sql.exec(
        `INSERT INTO pity_counters (source, rarity, misses) VALUES (?, ?, ?)
         ON CONFLICT (source, rarity) DO UPDATE SET misses = excluded.misses`,
        GACHA_DROP_SOURCE,
        rarity,
        count,
      );
    }
  });
}

function postPull(
  session: Session,
  body: unknown,
  idempotencyKey: IdempotencyKey = newIdempotencyKey(),
): Promise<Response> {
  return session.call(endpoints.gachaPull.path, { body, idempotencyKey });
}

async function pullOk(response: Response): Promise<GachaPullResponse> {
  expect(response.status, await response.clone().text()).toBe(200);
  return endpoints.gachaPull.response.parse(await response.json());
}

interface LedgerLeg extends Record<string, SqlStorageValue> {
  readonly tx_id: string;
  readonly account: string;
  readonly unit: string;
  readonly delta: number;
  readonly ref: string | null;
  readonly idempotency_key: string | null;
}

function ledgerOf(session: Session, kind: string): Promise<LedgerLeg[]> {
  return inPlayer(session, (sql) =>
    sql
      .exec<LedgerLeg>(
        'SELECT tx_id, account, unit, delta, ref, idempotency_key FROM ledger WHERE kind = ? ORDER BY seq',
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

interface PullRecord extends Record<string, SqlStorageValue> {
  readonly id: string;
  readonly batch_id: string;
  readonly idx: number;
  readonly pulled_at: number;
  readonly tickets_paid: number;
  readonly rarity: string;
  readonly collectible_id: string | null;
}

function pullRecords(session: Session): Promise<PullRecord[]> {
  return inPlayer(session, (sql) =>
    sql
      .exec<PullRecord>(
        `SELECT id, batch_id, idx, pulled_at, tickets_paid, rarity, collectible_id
         FROM gacha_pulls ORDER BY rowid`,
      )
      .toArray(),
  );
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

function currencyTotals(rewards: readonly Reward[]): Partial<Wallet> {
  const paid: Partial<Record<keyof Wallet, number>> = {};
  for (const reward of rewards) {
    if (reward.kind === 'currency') {
      paid[reward.currency] = (paid[reward.currency] ?? 0) + reward.amount;
    }
  }
  return paid;
}

function allRewards(pulled: GachaPullResponse): Reward[] {
  return pulled.pulls.flatMap((pull) => pull.rewards);
}

describe('POST /v1/gacha/pull refuses a pull the wallet cannot pay', () => {
  it('answers insufficient_funds with no Tickets, moving nothing and rolling nothing', async () => {
    const session = await newSession();
    const before = await state(session);
    expect(before.wallet.tickets).toBe(0);
    const rows = await ledgerRows(session);
    await expectError(await postPull(session, { count: 1 }), 409, 'insufficient_funds');
    const after = await state(session);
    expect(after.wallet).toEqual(before.wallet);
    expect(after.fair).toEqual(before.fair);
    expect(await ledgerRows(session)).toBe(rows);
    expect(await pullRecords(session)).toEqual([]);
    await expectConserved(session);
  });

  it('refuses a ten-pull one Ticket short whole, then takes it at exactly the price', async () => {
    const session = await newSession();
    const price = GACHA_TICKETS_PER_PULL * MAX_GACHA_PULLS;
    await giveTickets(session, price - 1);
    const before = await state(session);
    const rows = await ledgerRows(session);
    const response = await postPull(session, { count: MAX_GACHA_PULLS });
    await expectError(response.clone(), 409, 'insufficient_funds');
    expect(await response.text()).toContain(`holds ${price - 1}`);
    expect((await state(session)).wallet).toEqual(before.wallet);
    expect(await ledgerRows(session)).toBe(rows);
    expect(await pullRecords(session)).toEqual([]);

    await giveTickets(session, 1);
    const pulled = await pullOk(await postPull(session, { count: MAX_GACHA_PULLS }));
    expect(pulled.pulls).toHaveLength(MAX_GACHA_PULLS);
    expect(pulled.wallet.tickets).toBe(currencyTotals(allRewards(pulled)).tickets ?? 0);
    await expectConserved(session);
  });

  it('does not reuse a refused Idempotency-Key’s answer once the wallet can pay', async () => {
    const session = await newSession();
    const key = newIdempotencyKey();
    await expectError(await postPull(session, { count: 1 }, key), 409, 'insufficient_funds');
    await giveTickets(session, GACHA_TICKETS_PER_PULL);
    const pulled = await pullOk(await postPull(session, { count: 1 }, key));
    expect(pulled.pulls).toHaveLength(1);
  });
});

describe('POST /v1/gacha/pull', () => {
  it('debits exactly the Ticket price and credits only what the server rolled, conserving value', async () => {
    const session = await newSession();
    await giveTickets(session, 7);
    const rate = await inPlayer(session, (sql) => measuredActiveRate(sql));
    const before = await state(session);
    const key = newIdempotencyKey();
    const pulled = await pullOk(await postPull(session, { count: 3 }, key));

    expect(pulled.pulls).toHaveLength(3);
    const records = await pullRecords(session);
    expect(records).toHaveLength(3);
    for (const [i, pull] of pulled.pulls.entries()) {
      const row = crateRewards[pull.rarity];
      const currencies = currencyTotals(pull.rewards);
      expect(currencies).toEqual({
        coins: crateIncomeCoins(row.incomeSeconds, rate, offlineRate),
        ...(row.pearls > 0 ? { pearls: row.pearls } : {}),
        ...(row.keys > 0 ? { keys: row.keys } : {}),
        ...(row.tickets > 0 ? { tickets: row.tickets } : {}),
      });
      expect(pull.rewards.some((reward) => reward.kind === 'safe')).toBe(false);
      const card = pull.rewards.find((reward) => reward.kind === 'collectible');
      expect(card === undefined ? null : card.collectibleId).toBe(records[i]?.collectible_id);
      expect(records[i]).toMatchObject({ idx: i, rarity: pull.rarity, tickets_paid: 1 });
    }
    expect(new Set(records.map((record) => record.batch_id)).size).toBe(1);

    const paid = currencyTotals(allRewards(pulled));
    const price = 3 * GACHA_TICKETS_PER_PULL;
    expect(pulled.wallet.tickets - before.wallet.tickets).toBe((paid.tickets ?? 0) - price);
    expect(pulled.wallet.pearls - before.wallet.pearls).toBe(paid.pearls ?? 0);
    expect(pulled.wallet.keys - before.wallet.keys).toBe(paid.keys ?? 0);
    expect((await state(session)).wallet).toEqual(pulled.wallet);

    const legs = await ledgerOf(session, GACHA_PULL_TX_KIND);
    expect(txCount(legs)).toBe(1);
    expect(legs.every((leg) => leg.idempotency_key === key)).toBe(true);
    const batchId = records[0]?.batch_id;
    expect(legs.filter((leg) => leg.unit === 'tickets' && leg.delta < 0)).toEqual([
      expect.objectContaining({ account: 'wallet', delta: -price, ref: batchId }),
    ]);
    expect(legs).toContainEqual(
      expect.objectContaining({ account: 'house', unit: 'tickets', delta: price, ref: batchId }),
    );
    const minted = legs.filter((leg) => leg.account === 'mint');
    expect(minted.every((leg) => leg.delta < 0)).toBe(true);
    const walletCredits = legs.filter((leg) => leg.account === 'wallet' && leg.delta > 0);
    expect(walletCredits.reduce((sum, leg) => sum + leg.delta, 0)).toBe(
      Object.values(paid).reduce((sum, amount) => sum + amount, 0),
    );
    expect(walletCredits.every((leg) => records.some((record) => record.id === leg.ref))).toBe(
      true,
    );

    const cards = records.filter((record) => record.collectible_id !== null).length;
    expect(await playerStub(session.tokens.playerId).conservation()).toMatchObject({
      collectiblesHeld: cards,
      ledgerCollectiblesHeld: cards,
      conserved: true,
    });
  });

  it('puts every pulled album card in the album', async () => {
    const session = await newSession();
    await giveTickets(session, MAX_GACHA_PULLS);
    const pulled = await pullOk(await postPull(session, { count: MAX_GACHA_PULLS }));
    const granted = new Map<string, number>();
    for (const reward of allRewards(pulled)) {
      if (reward.kind === 'collectible') {
        granted.set(reward.collectibleId, (granted.get(reward.collectibleId) ?? 0) + 1);
      }
    }
    expect(granted.size).toBeGreaterThan(0);
    const response = await session.call(endpoints.album.path);
    const albumBody = endpoints.album.response.parse(await response.json());
    const owned = new Map<string, number>(
      albumBody.sets.flatMap((set) => set.entries).map((entry) => [entry.id, entry.count]),
    );
    for (const [id, count] of granted) expect(owned.get(id)).toBe(count);
  });

  it('stamps pulled_at from the server clock, whatever clock headers the client sends', async () => {
    const session = await newSession();
    await giveTickets(session, 1);
    const future = Date.now() + 365 * 24 * 3_600_000;
    const started = Date.now();
    const response = await session.call(endpoints.gachaPull.path, {
      body: { count: 1 },
      via: (request) => {
        const headers = new Headers(request.headers);
        headers.set('Date', new Date(future).toUTCString());
        headers.set('X-Client-Time', String(future));
        return exports.default.fetch(new Request(request, { headers }));
      },
    });
    await pullOk(response);
    const [record] = await pullRecords(session);
    expect(record?.pulled_at).toBeGreaterThanOrEqual(started);
    expect(record?.pulled_at).toBeLessThanOrEqual(Date.now());
  });

  it('keeps every pull record final: no rewrite, no delete', async () => {
    const session = await newSession();
    await giveTickets(session, 1);
    await pullOk(await postPull(session, { count: 1 }));
    await inPlayer(session, (sql) => {
      expect(() => sql.exec("UPDATE gacha_pulls SET rarity = 'heirloom'")).toThrow(/final/);
      expect(() => sql.exec('DELETE FROM gacha_pulls')).toThrow(/append-only/);
    });
  });
});

describe('a gacha pull spends once', () => {
  it('replays the same Idempotency-Key with the same capsules, debiting and rolling once', async () => {
    const session = await newSession();
    await giveTickets(session, 5);
    const key = newIdempotencyKey();
    const first = await postPull(session, { count: 2 }, key);
    const firstBody = await pullOk(first);
    expect(first.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull();
    const after = await state(session);

    for (let i = 0; i < 3; i++) {
      const replay = await postPull(session, { count: 2 }, key);
      expect(await pullOk(replay)).toEqual(firstBody);
      expect(replay.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('true');
    }
    const again = await state(session);
    expect(again.fair).toEqual(after.fair);
    expect(again.wallet).toEqual(after.wallet);
    expect(txCount(await ledgerOf(session, GACHA_PULL_TX_KIND))).toBe(1);
    expect(await pullRecords(session)).toHaveLength(2);
    await expectConserved(session);
  });

  it('refuses a reused Idempotency-Key for a different count, spending nothing more', async () => {
    const session = await newSession();
    await giveTickets(session, 5);
    const key = newIdempotencyKey();
    await pullOk(await postPull(session, { count: 1 }, key));
    const after = await state(session);
    await expectError(await postPull(session, { count: 3 }, key), 422, 'idempotency_key_reused');
    expect((await state(session)).wallet).toEqual(after.wallet);
    expect(await pullRecords(session)).toHaveLength(1);
  });

  it('never overdraws the wallet when racing pulls compete for the last Ticket', async () => {
    const session = await newSession();
    await giveTickets(session, GACHA_TICKETS_PER_PULL);
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => postPull(session, { count: 1 })),
    );
    const ok = responses.filter((response) => response.status === 200);
    const refused = responses.filter((response) => response.status !== 200);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const response of refused) await expectError(response, 409, 'insufficient_funds');

    const earned = (await Promise.all(ok.map(pullOk)))
      .map((pulled) => currencyTotals(allRewards(pulled)).tickets ?? 0)
      .reduce((sum, n) => sum + n, 0);
    const wallet = (await state(session)).wallet;
    expect(wallet.tickets).toBe(GACHA_TICKETS_PER_PULL * (1 - ok.length) + earned);
    expect(wallet.tickets).toBeGreaterThanOrEqual(0);
    expect(txCount(await ledgerOf(session, GACHA_PULL_TX_KIND))).toBe(ok.length);
    await expectConserved(session);
  });
});

describe('the pull request carries nothing the server trusts', () => {
  it('refuses empty, out-of-range and malformed counts with validation_failed', async () => {
    const session = await newSession();
    await giveTickets(session, 50);
    const before = await state(session);
    const rows = await ledgerRows(session);
    for (const body of [
      {},
      { count: 0 },
      { count: -1 },
      { count: MAX_GACHA_PULLS + 1 },
      { count: 1.5 },
      { count: '1' },
      { count: null },
      { count: Number.MAX_SAFE_INTEGER },
      [],
      null,
    ]) {
      await expectError(await postPull(session, body), 400, 'validation_failed');
    }
    const after = await state(session);
    expect(after.wallet).toEqual(before.wallet);
    expect(after.fair).toEqual(before.fair);
    expect(await ledgerRows(session)).toBe(rows);
  });

  it('refuses client-sent prices, rolls, rarities, wallets, seeds and times', async () => {
    const session = await newSession();
    await giveTickets(session, 5);
    const before = await state(session);
    for (const forged of [
      { count: 1, cost: 0 },
      { count: 1, tickets: 0 },
      { count: 1, rarity: 'heirloom' },
      { count: 1, pulls: [{ rarity: 'legendary' }] },
      { count: 1, wallet: { tickets: 9_999 } },
      { count: 1, rewards: [{ kind: 'currency', currency: 'pearls', amount: 1e9 }] },
      { count: 1, pity: { legendary: 119 } },
      { count: 1, nonce: 0 },
      { count: 1, clientSeed: 'aaaaaaaaaaaaaaaa' },
      { count: 1, at: Date.now() + 1e9 },
      { count: 1, source: 'goldSafe' },
    ]) {
      await expectError(await postPull(session, forged), 400, 'validation_failed');
    }
    const after = await state(session);
    expect(after.wallet).toEqual(before.wallet);
    expect(after.fair).toEqual(before.fair);
    expect(await pullRecords(session)).toEqual([]);
  });

  it('needs a signed request, a valid token and an Idempotency-Key', async () => {
    const session = await newSession();
    await giveTickets(session, 1);
    const body = { count: 1 };
    await expectError(
      await session.call(endpoints.gachaPull.path, { body, idempotencyKey: null }),
      400,
      'idempotency_key_missing',
    );
    await expectError(
      await session.call(endpoints.gachaPull.path, { body, signature: null }),
      401,
      'invalid_signature',
    );
    await expectError(
      await session.call(endpoints.gachaPull.path, { body, accessToken: 'forged' }),
      401,
      'unauthorized',
    );
    expect((await state(session)).wallet.tickets).toBe(1);
  });

  it('charges the caller only: another player’s Tickets are untouched', async () => {
    const rich = await newSession();
    const poor = await newSession();
    await giveTickets(rich, 3);
    await expectError(await postPull(poor, { count: 1 }), 409, 'insufficient_funds');
    expect((await state(rich)).wallet.tickets).toBe(3);
  });
});

describe('the pull roll', () => {
  it('is the committed seed chain rolling gacha with running pity, one nonce per capsule', async () => {
    const session = await newSession();
    await giveTickets(session, 20);
    const committed = (await state(session)).fair;
    let pityBefore = await inPlayer(session, (sql) => readPity(sql, GACHA_DROP_SOURCE));
    const secret = await fairSecret(session);
    let nonce = committed.nonce;
    for (const count of [1, 4, MAX_GACHA_PULLS]) {
      const pulled = await pullOk(await postPull(session, { count }));
      for (const pull of pulled.pulls) {
        expect(pull.proof).toEqual({ ...committed, nonce });
        const rng = fairRngFromDigest(fairDigest(secret, pull.proof.clientSeed, nonce));
        const replayed = drawCrate(GACHA_TABLE, pityBefore, rng, false);
        expect(replayed.safe).toBe(false);
        expect(pull.rarity).toBe(replayed.rarity);
        const card = pull.rewards.find((reward) => reward.kind === 'collectible');
        expect(card === undefined ? null : card.collectibleId).toBe(replayed.collectibleId);
        expect(pull.pity).toEqual({
          rare: replayed.pity.rare,
          exquisite: replayed.pity.exquisite,
          legendary: replayed.pity.legendary,
        });
        pityBefore = replayed.pity;
        nonce++;
      }
    }
    expect((await state(session)).fair).toEqual({ ...committed, nonce });
    expect(await inPlayer(session, (sql) => readPity(sql, GACHA_DROP_SOURCE))).toEqual(pityBefore);
  });

  it('forces each pitied rarity when its counter would expire', async () => {
    for (const rule of pity.rules) {
      const session = await newSession();
      await giveTickets(session, 1);
      await setPity(session, { [rule.rarity]: rule.within - 1 });
      const [pull] = (await pullOk(await postPull(session, { count: 1 }))).pulls;
      expect(rarityRank(pull?.rarity ?? 'common')).toBeGreaterThanOrEqual(rarityRank(rule.rarity));
      expect(pull?.pity[rule.rarity]).toBe(0);
    }
  });

  it('keeps gacha pity apart from other sources', async () => {
    const session = await newSession();
    await giveTickets(session, 1);
    await inPlayer(session, (sql) => {
      sql.exec(
        "INSERT INTO pity_counters (source, rarity, misses) VALUES ('vaultCrate', 'rare', 7)",
      );
    });
    await pullOk(await postPull(session, { count: 1 }));
    expect(await inPlayer(session, (sql) => readPity(sql, 'vaultCrate'))).toMatchObject({
      rare: 7,
    });
  });
});

describe('gacha storage', () => {
  it('lists gacha.pull as a core ledger kind', () => {
    expect(TX_KINDS).toContain(GACHA_PULL_TX_KIND);
  });

  it('migrates a player stored before gacha pulls onto an empty gacha_pulls table', async () => {
    const session = await newSession();
    await state(session);
    await runInDurableObject(playerStub(session.tokens.playerId), (_live: PlayerDO, ctx) => {
      const sql = ctx.storage.sql;
      const objects = () =>
        sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger', 'index') AND name LIKE 'gacha\\_pulls%' ESCAPE '\\' ORDER BY name",
          )
          .toArray()
          .map((row) => row.name);
      const migrated = objects();
      expect(migrated).toEqual([
        'gacha_pulls',
        'gacha_pulls_collectible',
        'gacha_pulls_no_delete',
        'gacha_pulls_no_update',
      ]);
      sql.exec('DROP TABLE gacha_pulls');
      const before = MIGRATIONS.indexOf(GACHA_SQL);
      expect(before).toBe(MIGRATIONS.length - 1);
      sql.exec('UPDATE schema_version SET version = ?', before);
      expect(objects()).toEqual([]);

      new PlayerDO(ctx, env);
      expect(sql.exec<{ version: number }>('SELECT version FROM schema_version').one()).toEqual({
        version: MIGRATIONS.length,
      });
      expect(objects()).toEqual(migrated);
      expect(sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM gacha_pulls').one().n).toBe(0);
    });
    await expectConserved(session);
  });
});

function recordingHost(result: DoResult<GachaPullResponse>) {
  const commands: Command<unknown>[] = [];
  const host: GachaHost = {
    pullGacha(command) {
      commands.push(command);
      return Promise.resolve(result);
    },
  };
  return { host, commands };
}

function appFor(host: GachaHost): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use(requestIdMiddleware);
  app.route(
    '/',
    createGachaRoutes(() => host),
  );
  app.onError((error, c) => {
    if (!(error instanceof ApiFailure)) return c.json({ error: { code: 'internal' } }, 500);
    return c.json(error.envelope(c.get('requestId')), error.status as ContentfulStatusCode);
  });
  return app;
}

async function postTo(app: Hono<AppEnv>, session: Session, body: unknown): Promise<Response> {
  const path = endpoints.gachaPull.path;
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

describe('createGachaRoutes', () => {
  it('forwards only the count, and refuses client-sent results before reaching the player', async () => {
    const session = await newSession();
    const { host, commands } = recordingHost({
      ok: false,
      error: { code: 'insufficient_funds', message: 'No Tickets.' },
    });
    const app = appFor(host);
    await expectError(await postTo(app, session, { count: 2 }), 409, 'insufficient_funds');
    expect(commands).toHaveLength(1);
    expect(commands[0]?.body).toEqual({ count: 2 });

    for (const forged of [
      { count: 2, cost: 0 },
      { count: 2, pulls: [{ rarity: 'heirloom' }] },
      { count: 2, wallet: { tickets: 1e9 } },
    ]) {
      await expectError(await postTo(app, session, forged), 400, 'validation_failed');
    }
    expect(commands).toHaveLength(1);
  });

  it('refuses a host answer that breaks the response contract instead of passing it on', async () => {
    const session = await newSession();
    const wallet = (await state(session)).wallet;
    const { host } = recordingHost({
      ok: true,
      replayed: false,
      body: { pulls: [], wallet } as unknown as GachaPullResponse,
    });
    expect((await postTo(appFor(host), session, { count: 1 })).status).toBe(500);
  });
});
