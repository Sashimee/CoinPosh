import {
  crateIncomeCoins,
  crateRewards,
  dropTables,
  offlineRate,
  pity,
  rarityRank,
  rollDrop,
  safes,
  safeTypeDef,
  type PityState,
} from '@coinposh/economy';
import {
  endpoints,
  ENTITY_ID_PREFIXES,
  HEADERS,
  type IdempotencyKey,
  type Reward,
  type Safe,
  type SafeOpenResponse,
  type Wallet,
} from '@coinposh/shared';
import { runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { describe, expect, it } from 'vitest';
import type { Command, DoResult, PlayerDO } from '../do/PlayerDO.ts';
import { commit, LedgerTx } from '../do/ledger.ts';
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
import { measuredActiveRate } from './offline.ts';
import {
  createSafeRoutes,
  grantSafe,
  readPity,
  SAFE_GRANT_TX_KIND,
  SAFE_KEY_TX_KIND,
  SAFE_OPEN_TX_KIND,
  type SafeHost,
} from './safes.ts';

const GOLD = safeTypeDef(safes.crateDrop.type);
const UNLOCK_MS = GOLD.unlockSeconds * 1_000;
const GOLD_TABLE = (() => {
  const table = dropTables.find((candidate) => candidate.source === GOLD.dropSource);
  if (table === undefined) throw new Error(`economy has no ${GOLD.dropSource} table`);
  return table;
})();

function inPlayer<T>(session: Session, run: (sql: SqlStorage) => T): Promise<T> {
  return runInDurableObject(playerStub(session.tokens.playerId), (_: PlayerDO, ctx) =>
    ctx.storage.transactionSync(() => run(ctx.storage.sql)),
  );
}

/** Grants a Gold Safe as if the server had granted it `ago` ms before now on its own clock. */
function giveSafe(session: Session, ago = 0): Promise<Safe> {
  return inPlayer(session, (sql) =>
    grantSafe(
      sql,
      { type: GOLD.id, source: 'test:grant' },
      { at: Date.now() - ago, idempotencyKey: null },
    ),
  );
}

function giveKeys(session: Session, keys: number): Promise<void> {
  return inPlayer(session, (sql) => {
    commit(sql, new LedgerTx('grant.starting').move('mint', 'wallet', 'keys', keys, null), {
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
        GOLD.dropSource,
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
  return session.call(endpoints.safesOpen.path, { body, idempotencyKey });
}

async function openOk(response: Response): Promise<SafeOpenResponse> {
  expect(response.status, await response.clone().text()).toBe(200);
  return endpoints.safesOpen.response.parse(await response.json());
}

interface SafeRecord extends Record<string, SqlStorageValue> {
  readonly state: string;
  readonly opened_by: string | null;
  readonly rarity: string | null;
  readonly granted_at: number;
  readonly unlocks_at: number;
}

function safeRecord(session: Session, id: string): Promise<SafeRecord | undefined> {
  return inPlayer(
    session,
    (sql) =>
      sql
        .exec<SafeRecord>(
          'SELECT state, opened_by, rarity, granted_at, unlocks_at FROM safes WHERE id = ?',
          id,
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
}

function ledgerOf(session: Session, kind: string): Promise<LedgerLeg[]> {
  return inPlayer(session, (sql) =>
    sql
      .exec<LedgerLeg>(
        'SELECT tx_id, account, unit, delta, ref FROM ledger WHERE kind = ? ORDER BY seq',
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

/**
 * What the player can verify once the seed is revealed: the active secret, which stays in the
 * profile's meta until the first roll moves it into the seed chain.
 */
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
    if (reward.kind !== 'currency') throw new Error(`a safe paid a ${reward.kind}`);
    paid[reward.currency] = (paid[reward.currency] ?? 0) + reward.amount;
  }
  return paid;
}

/** A player with no Keys: the starting grant pays none, so every Key in a test is given. */
async function freshPlayer(): Promise<Session> {
  const session = await newSession();
  expect((await state(session)).wallet.keys).toBe(0);
  return session;
}

describe('granting a safe', () => {
  it('stamps unlocksAt from the server clock and economy config, and books one safe into the inventory', async () => {
    const session = await freshPlayer();
    const at = Date.now() - 1_234;
    const safe = await inPlayer(session, (sql) =>
      grantSafe(sql, { type: GOLD.id, source: 'crate:test' }, { at, idempotencyKey: null }),
    );
    expect(safe).toEqual({
      id: expect.stringMatching(
        new RegExp(`^${ENTITY_ID_PREFIXES.safe}_[A-Za-z0-9]{20}$`),
      ) as string,
      type: GOLD.id,
      unlocksAt: at + UNLOCK_MS,
    });
    expect(GOLD.unlockSeconds).toBe(4 * 3_600);
    expect(await ledgerOf(session, SAFE_GRANT_TX_KIND)).toEqual([
      expect.objectContaining({ account: 'mint', unit: 'safe', delta: -1, ref: safe.id }),
      expect.objectContaining({ account: 'inventory', unit: 'safe', delta: 1, ref: safe.id }),
    ]);
    expect((await state(session)).inventory.safes).toEqual([safe]);
    await expectConserved(session);
  });

  it('refuses a safe type the economy catalog does not list', async () => {
    const session = await freshPlayer();
    await expect(
      inPlayer(session, (sql) =>
        grantSafe(sql, { type: 'platinum', source: 'x' }, { at: 0, idempotencyKey: null }),
      ),
    ).rejects.toThrow(/Unknown safe type "platinum"/);
    expect((await state(session)).inventory.safes).toEqual([]);
  });

  it('lists only unopened safes, soonest timer first', async () => {
    const session = await freshPlayer();
    const later = await giveSafe(session, 0);
    const sooner = await giveSafe(session, 60_000);
    const ready = await giveSafe(session, UNLOCK_MS + 1);
    await openOk(await postOpen(session, { safeId: ready.id, method: 'timer' }));
    expect((await state(session)).inventory.safes).toEqual([sooner, later]);
  });

  it('keeps a granted safe fixed: no timer change, no delete, no second open, even from storage', async () => {
    const session = await freshPlayer();
    const safe = await giveSafe(session, UNLOCK_MS);
    await inPlayer(session, (sql) => {
      expect(() => sql.exec('UPDATE safes SET unlocks_at = 0 WHERE id = ?', safe.id)).toThrow(
        /opens once/,
      );
      expect(() => sql.exec('DELETE FROM safes')).toThrow(/append-only/);
    });
    await openOk(await postOpen(session, { safeId: safe.id, method: 'timer' }));
    await inPlayer(session, (sql) => {
      expect(() =>
        sql.exec(
          "UPDATE safes SET state = 'opened', opened_by = 'key', rarity = 'heirloom' WHERE id = ?",
          safe.id,
        ),
      ).toThrow(/opens once/);
    });
  });
});

describe('POST /v1/safes/open by timer', () => {
  it('refuses an early timer with not_ready and Retry-After from the server clock, moving nothing', async () => {
    const session = await freshPlayer();
    const safe = await giveSafe(session, UNLOCK_MS - 90_000);
    const before = await state(session);
    const rows = await ledgerRows(session);

    const response = await postOpen(session, { safeId: safe.id, method: 'timer' });
    expect(response.status).toBe(409);
    const retryAfter = Number(response.headers.get('Retry-After'));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(90);
    const body = await response.json<{ error: { code: string; retryAfterMs: number } }>();
    expect(body.error.code).toBe('not_ready');
    expect(body.error.retryAfterMs).toBeGreaterThan(0);
    expect(body.error.retryAfterMs).toBeLessThanOrEqual(90_000);

    const after = await state(session);
    expect(after.wallet).toEqual(before.wallet);
    expect(after.fair).toEqual(before.fair);
    expect(after.inventory.safes).toEqual([safe]);
    expect(await ledgerRows(session)).toBe(rows);
    expect(await safeRecord(session, safe.id)).toMatchObject({ state: 'locked', opened_by: null });
  });

  it('refuses a timer one second before unlocksAt and opens it once the server clock reaches it', async () => {
    const session = await freshPlayer();
    const almost = await giveSafe(session, UNLOCK_MS - 1_000);
    await expectError(
      await postOpen(session, { safeId: almost.id, method: 'timer' }),
      409,
      'not_ready',
    );

    const due = await giveSafe(session, UNLOCK_MS);
    const opened = await openOk(await postOpen(session, { safeId: due.id, method: 'timer' }));
    expect(opened.safeId).toBe(due.id);
    expect(await ledgerOf(session, SAFE_KEY_TX_KIND)).toEqual([]);
    expect(await safeRecord(session, due.id)).toMatchObject({
      state: 'opened',
      opened_by: 'timer',
    });
    await expectConserved(session);
  });

  it('trusts no client time: timestamps in the body are refused and clock headers change nothing', async () => {
    const session = await freshPlayer();
    const safe = await giveSafe(session);
    const future = Date.now() + 10 * UNLOCK_MS;
    for (const forged of [
      { safeId: safe.id, method: 'timer', now: future },
      { safeId: safe.id, method: 'timer', unlocksAt: 0 },
      { safeId: safe.id, method: 'timer', grantedAt: 0 },
      { safeId: safe.id, method: 'timer', at: future },
    ]) {
      await expectError(await postOpen(session, forged), 400, 'validation_failed');
    }
    await expectError(
      await postOpen(session, { safeId: safe.id, method: 'skip' }),
      400,
      'validation_failed',
    );

    const skewed = await session.call(endpoints.safesOpen.path, {
      body: { safeId: safe.id, method: 'timer' },
      via: (request) => {
        const headers = new Headers(request.headers);
        headers.set('Date', new Date(future).toUTCString());
        headers.set('X-Client-Time', String(future));
        return exports.default.fetch(new Request(request, { headers }));
      },
    });
    await expectError(skewed, 409, 'not_ready');
    expect((await state(session)).inventory.safes).toEqual([safe]);
  });
});

describe('POST /v1/safes/open by Key', () => {
  it('refuses a player without enough Keys and moves nothing', async () => {
    const session = await freshPlayer();
    const safe = await giveSafe(session);
    const before = await state(session);
    await expectError(
      await postOpen(session, { safeId: safe.id, method: 'key' }),
      409,
      'insufficient_funds',
    );
    const after = await state(session);
    expect(after.wallet).toEqual(before.wallet);
    expect(after.fair).toEqual(before.fair);
    expect(after.inventory.safes).toEqual([safe]);
    expect(await ledgerOf(session, SAFE_KEY_TX_KIND)).toEqual([]);
  });

  it('spends keysPerSafe Keys to the house through the ledger and opens a locked safe at once', async () => {
    const session = await freshPlayer();
    await giveKeys(session, GOLD.keysPerSafe + 2);
    const safe = await giveSafe(session);
    const opened = await openOk(await postOpen(session, { safeId: safe.id, method: 'key' }));

    expect(await ledgerOf(session, SAFE_KEY_TX_KIND)).toEqual([
      expect.objectContaining({
        account: 'wallet',
        unit: 'keys',
        delta: -GOLD.keysPerSafe,
        ref: safe.id,
      }),
      expect.objectContaining({
        account: 'house',
        unit: 'keys',
        delta: GOLD.keysPerSafe,
        ref: safe.id,
      }),
    ]);
    const keysWon = currencyRewards(opened.roll.rewards).keys ?? 0;
    expect(opened.wallet.keys).toBe(2 + keysWon);
    expect((await state(session)).wallet.keys).toBe(opened.wallet.keys);
    expect(await safeRecord(session, safe.id)).toMatchObject({ state: 'opened', opened_by: 'key' });
    await expectConserved(session);
  });

  it('never burns a Key on a safe whose timer already ran out', async () => {
    const session = await freshPlayer();
    await giveKeys(session, 1);
    const safe = await giveSafe(session, UNLOCK_MS + 5_000);
    const opened = await openOk(await postOpen(session, { safeId: safe.id, method: 'key' }));
    expect(await ledgerOf(session, SAFE_KEY_TX_KIND)).toEqual([]);
    expect(opened.wallet.keys).toBe(1 + (currencyRewards(opened.roll.rewards).keys ?? 0));
    expect(await safeRecord(session, safe.id)).toMatchObject({ opened_by: 'timer' });
  });
});

describe('a safe opens exactly once', () => {
  it('replays the same Idempotency-Key with the same result, rolling and paying once', async () => {
    const session = await freshPlayer();
    await giveKeys(session, 1);
    const safe = await giveSafe(session);
    const key = newIdempotencyKey();
    const first = await postOpen(session, { safeId: safe.id, method: 'key' }, key);
    const firstBody = await openOk(first);
    expect(first.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull();
    const nonce = (await state(session)).fair.nonce;

    const replay = await postOpen(session, { safeId: safe.id, method: 'key' }, key);
    expect(await openOk(replay)).toEqual(firstBody);
    expect(replay.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('true');
    expect((await state(session)).fair.nonce).toBe(nonce);
    expect(new Set((await ledgerOf(session, SAFE_OPEN_TX_KIND)).map((leg) => leg.tx_id)).size).toBe(
      1,
    );
    expect(new Set((await ledgerOf(session, SAFE_KEY_TX_KIND)).map((leg) => leg.tx_id)).size).toBe(
      1,
    );
    await expectConserved(session);
  });

  it('refuses a reused Idempotency-Key for a different safe', async () => {
    const session = await freshPlayer();
    const a = await giveSafe(session, UNLOCK_MS);
    const b = await giveSafe(session, UNLOCK_MS);
    const key = newIdempotencyKey();
    await openOk(await postOpen(session, { safeId: a.id, method: 'timer' }, key));
    await expectError(
      await postOpen(session, { safeId: b.id, method: 'timer' }, key),
      422,
      'idempotency_key_reused',
    );
    expect((await state(session)).inventory.safes).toEqual([b]);
  });

  it('refuses a second open under a new key with conflict, paying nothing more', async () => {
    const session = await freshPlayer();
    await giveKeys(session, 3);
    const safe = await giveSafe(session);
    await openOk(await postOpen(session, { safeId: safe.id, method: 'key' }));
    const after = await state(session);
    for (const method of ['key', 'timer']) {
      await expectError(await postOpen(session, { safeId: safe.id, method }), 409, 'conflict');
    }
    const again = await state(session);
    expect(again.wallet).toEqual(after.wallet);
    expect(again.fair).toEqual(after.fair);
    expect(new Set((await ledgerOf(session, SAFE_OPEN_TX_KIND)).map((leg) => leg.tx_id)).size).toBe(
      1,
    );
  });

  it('lets exactly one of two racing opens through', async () => {
    const session = await freshPlayer();
    await giveKeys(session, 2);
    const safe = await giveSafe(session);
    const responses = await Promise.all([
      postOpen(session, { safeId: safe.id, method: 'key' }),
      postOpen(session, { safeId: safe.id, method: 'key' }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect((await ledgerOf(session, SAFE_KEY_TX_KIND)).length).toBe(2);
    await expectConserved(session);
  });

  it('refuses forged and foreign safe IDs without telling them apart', async () => {
    const owner = await freshPlayer();
    const thief = await freshPlayer();
    await giveKeys(thief, 1);
    const theirs = await giveSafe(owner, UNLOCK_MS);
    const forged = `${ENTITY_ID_PREFIXES.safe}_${'A'.repeat(20)}`;
    for (const safeId of [theirs.id, forged]) {
      for (const method of ['key', 'timer']) {
        await expectError(await postOpen(thief, { safeId, method }), 404, 'not_found');
      }
    }
    for (const safeId of ['safe_short', `${ENTITY_ID_PREFIXES.crate}_${'A'.repeat(20)}`, '']) {
      await expectError(
        await postOpen(thief, { safeId, method: 'timer' }),
        400,
        'validation_failed',
      );
    }
    expect((await state(thief)).wallet.keys).toBe(1);
    expect((await state(owner)).inventory.safes).toEqual([theirs]);
  });

  it('needs a signed request and an Idempotency-Key', async () => {
    const session = await freshPlayer();
    const safe = await giveSafe(session, UNLOCK_MS);
    const body = { safeId: safe.id, method: 'timer' };
    await expectError(
      await session.call(endpoints.safesOpen.path, { body, idempotencyKey: null }),
      400,
      'idempotency_key_missing',
    );
    await expectError(
      await session.call(endpoints.safesOpen.path, { body, signature: null }),
      401,
      'invalid_signature',
    );
    await expectError(
      await session.call(endpoints.safesOpen.path, { body, accessToken: 'forged' }),
      401,
      'unauthorized',
    );
    expect((await state(session)).inventory.safes).toEqual([safe]);
  });
});

describe('the contents roll', () => {
  it('is the committed seed chain rolling goldSafe with pity, reproducible from the revealed seed', async () => {
    const session = await freshPlayer();
    const committed = (await state(session)).fair;
    let pityBefore = await inPlayer(session, (sql) => readPity(sql, GOLD.dropSource));
    for (let i = 0; i < 4; i++) {
      const safe = await giveSafe(session, UNLOCK_MS);
      const secret = await fairSecret(session);
      const opened = await openOk(await postOpen(session, { safeId: safe.id, method: 'timer' }));
      expect(opened.roll.proof).toEqual({ ...committed, nonce: committed.nonce + i });

      const digest = fairDigest(secret, opened.roll.proof.clientSeed, opened.roll.proof.nonce);
      const replayed = rollDrop(GOLD_TABLE, pity, pityBefore, fairRngFromDigest(digest));
      expect(opened.roll.rarity).toBe(replayed.rarity);
      expect(opened.roll.pity).toEqual({
        rare: replayed.state.rare,
        exquisite: replayed.state.exquisite,
        legendary: replayed.state.legendary,
      });
      pityBefore = replayed.state;
    }
    expect((await state(session)).fair).toEqual({ ...committed, nonce: committed.nonce + 4 });
    expect(await inPlayer(session, (sql) => readPity(sql, GOLD.dropSource))).toEqual(pityBefore);
  });

  it('counts misses up and resets them on a hit, rarity by rarity', async () => {
    const session = await freshPlayer();
    await setPity(session, { rare: 3, exquisite: 20, legendary: 50 });
    const safe = await giveSafe(session, UNLOCK_MS);
    const opened = await openOk(await postOpen(session, { safeId: safe.id, method: 'timer' }));
    const rank = rarityRank(opened.roll.rarity);
    expect(opened.roll.pity).toEqual({
      rare: rank >= rarityRank('rare') ? 0 : 4,
      exquisite: rank >= rarityRank('exquisite') ? 0 : 21,
      legendary: rank >= rarityRank('legendary') ? 0 : 51,
    });
  });

  it('forces a pitied rarity when its counter would expire, and resets it', async () => {
    for (const rule of pity.rules) {
      const session = await freshPlayer();
      await setPity(session, { [rule.rarity]: rule.within - 1 });
      const safe = await giveSafe(session, UNLOCK_MS);
      const opened = await openOk(await postOpen(session, { safeId: safe.id, method: 'timer' }));
      expect(rarityRank(opened.roll.rarity)).toBeGreaterThanOrEqual(rarityRank(rule.rarity));
      expect(opened.roll.pity[rule.rarity]).toBe(0);
      expect(await safeRecord(session, safe.id)).toMatchObject({ rarity: opened.roll.rarity });
    }
  });

  it('keeps pity per drop source: a safe never moves another source’s counters', async () => {
    const session = await freshPlayer();
    await inPlayer(session, (sql) => {
      sql.exec(
        "INSERT INTO pity_counters (source, rarity, misses) VALUES ('vaultCrate', 'rare', 7)",
      );
    });
    const safe = await giveSafe(session, UNLOCK_MS);
    await openOk(await postOpen(session, { safeId: safe.id, method: 'timer' }));
    expect(await inPlayer(session, (sql) => readPity(sql, 'vaultCrate'))).toMatchObject({
      rare: 7,
    });
  });

  it('pays that rarity’s crateRewards currencies from the mint, and never a safe', async () => {
    const session = await freshPlayer();
    const safe = await giveSafe(session, UNLOCK_MS);
    const rate = await inPlayer(session, (sql) => measuredActiveRate(sql));
    const before = await state(session);
    const opened = await openOk(await postOpen(session, { safeId: safe.id, method: 'timer' }));
    const row = crateRewards[opened.roll.rarity];
    const expected = {
      coins: crateIncomeCoins(row.incomeSeconds, rate, offlineRate),
      ...(row.pearls > 0 ? { pearls: row.pearls } : {}),
      ...(row.keys > 0 ? { keys: row.keys } : {}),
      ...(row.tickets > 0 ? { tickets: row.tickets } : {}),
    };
    expect(currencyRewards(opened.roll.rewards)).toEqual(expected);
    expect(opened.roll.rewards.some((reward) => reward.kind === 'safe')).toBe(false);
    expect(opened.wallet.pearls - before.wallet.pearls).toBe(expected.pearls ?? 0);
    expect(opened.wallet.tickets - before.wallet.tickets).toBe(expected.tickets ?? 0);

    const legs = await ledgerOf(session, SAFE_OPEN_TX_KIND);
    expect(legs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ account: 'inventory', unit: 'safe', delta: -1, ref: safe.id }),
        expect.objectContaining({ account: 'house', unit: 'safe', delta: 1, ref: safe.id }),
        expect.objectContaining({ account: 'wallet', unit: 'coins', delta: expected.coins }),
      ]),
    );
    expect(legs.filter((leg) => leg.account === 'mint').every((leg) => leg.delta < 0)).toBe(true);
    expect((await state(session)).inventory.safes).toEqual([]);
    await expectConserved(session);
  });
});

function recordingHost(result: DoResult<SafeOpenResponse>) {
  const commands: Command<unknown>[] = [];
  const host: SafeHost = {
    openSafe(command) {
      commands.push(command);
      return Promise.resolve(result);
    },
  };
  return { host, commands };
}

function appFor(host: SafeHost): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use(requestIdMiddleware);
  app.route(
    '/',
    createSafeRoutes(() => host),
  );
  app.onError((error, c) => {
    if (!(error instanceof ApiFailure)) throw error;
    return c.json(error.envelope(c.get('requestId')), error.status as ContentfulStatusCode);
  });
  return app;
}

async function postTo(app: Hono<AppEnv>, session: Session, body: unknown): Promise<Response> {
  const path = endpoints.safesOpen.path;
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

describe('createSafeRoutes', () => {
  it('forwards only the safe and method, and refuses client-sent rolls or wallets before the player', async () => {
    const session = await newSession();
    const safeId = `${ENTITY_ID_PREFIXES.safe}_${'b'.repeat(20)}`;
    const { host, commands } = recordingHost({
      ok: false,
      error: { code: 'not_found', message: 'No safe.' },
    });
    const app = appFor(host);
    await expectError(await postTo(app, session, { safeId, method: 'key' }), 404, 'not_found');
    expect(commands).toHaveLength(1);
    expect(commands[0]?.body).toEqual({ safeId, method: 'key' });

    for (const forged of [
      { safeId, method: 'key', roll: { rarity: 'heirloom' } },
      { safeId, method: 'key', wallet: { keys: 99 } },
      { safeId, method: 'key', keys: 0 },
      { safeId, method: 'key', pity: { legendary: 119 } },
    ]) {
      await expectError(await postTo(app, session, forged), 400, 'validation_failed');
    }
    expect(commands).toHaveLength(1);
  });
});
