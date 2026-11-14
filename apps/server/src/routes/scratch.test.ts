import {
  createRng,
  crateIncomeCoins,
  crateRewards,
  dropTables,
  offlineRate,
  pity,
  rarityRank,
  rollDrop,
  type PityState,
} from '@coinposh/economy';
import {
  endpoints,
  ENTITY_ID_PREFIXES,
  HEADERS,
  RARITY_IDS,
  SCRATCH_GRID_SIZE,
  type IdempotencyKey,
  type Rarity,
  type Reward,
  type ScratchCardId,
  type ScratchRevealResponse,
  type Wallet,
} from '@coinposh/shared';
import { runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { describe, expect, it } from 'vitest';
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
import { expectConserved, expectError, playerStub, state } from '../test/game.ts';
import { measuredActiveRate } from './offline.ts';
import { readPity } from './safes.ts';
import {
  createScratchRoutes,
  grantScratchCard,
  SCRATCH_DROP_SOURCE,
  SCRATCH_GRANT_TX_KIND,
  SCRATCH_MATCH,
  SCRATCH_REVEAL_TX_KIND,
  scratchGrid,
  type ScratchHost,
} from './scratch.ts';

const SCRATCH_TABLE = (() => {
  const table = dropTables.find((candidate) => candidate.source === SCRATCH_DROP_SOURCE);
  if (table === undefined) throw new Error(`economy has no ${SCRATCH_DROP_SOURCE} table`);
  return table;
})();

function inPlayer<T>(session: Session, run: (sql: SqlStorage) => T): Promise<T> {
  return runInDurableObject(playerStub(session.tokens.playerId), (_: PlayerDO, ctx) =>
    ctx.storage.transactionSync(() => run(ctx.storage.sql)),
  );
}

function giveCard(session: Session, source = 'test:grant'): Promise<ScratchCardId> {
  return inPlayer(session, (sql) =>
    grantScratchCard(sql, { source }, { at: Date.now(), idempotencyKey: null }),
  );
}

function setPity(session: Session, misses: PityState): Promise<void> {
  return inPlayer(session, (sql) => {
    for (const [rarity, count] of Object.entries(misses)) {
      sql.exec(
        `INSERT INTO pity_counters (source, rarity, misses) VALUES (?, ?, ?)
         ON CONFLICT (source, rarity) DO UPDATE SET misses = excluded.misses`,
        SCRATCH_DROP_SOURCE,
        rarity,
        count,
      );
    }
  });
}

function postReveal(
  session: Session,
  body: unknown,
  idempotencyKey: IdempotencyKey = newIdempotencyKey(),
): Promise<Response> {
  return session.call(endpoints.scratchReveal.path, { body, idempotencyKey });
}

async function revealOk(response: Response): Promise<ScratchRevealResponse> {
  expect(response.status, await response.clone().text()).toBe(200);
  return endpoints.scratchReveal.response.parse(await response.json());
}

interface CardRecord extends Record<string, SqlStorageValue> {
  readonly state: string;
  readonly source: string;
  readonly granted_at: number;
  readonly revealed_at: number | null;
  readonly rarity: string | null;
  readonly grid: string | null;
}

function cardRecord(session: Session, id: string): Promise<CardRecord | undefined> {
  return inPlayer(
    session,
    (sql) =>
      sql
        .exec<CardRecord>(
          'SELECT state, source, granted_at, revealed_at, rarity, grid FROM scratch_cards WHERE id = ?',
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
    if (reward.kind !== 'currency') throw new Error(`a scratch card paid a ${reward.kind}`);
    paid[reward.currency] = (paid[reward.currency] ?? 0) + reward.amount;
  }
  return paid;
}

function counts(grid: readonly Rarity[]): Map<Rarity, number> {
  const tally = new Map<Rarity, number>();
  for (const gem of grid) tally.set(gem, (tally.get(gem) ?? 0) + 1);
  return tally;
}

/** The card pays exactly one 3-match, of `winner`, and nothing else reaches three. */
function expectOneMatchOf(grid: readonly Rarity[], winner: Rarity): void {
  expect(grid).toHaveLength(SCRATCH_GRID_SIZE);
  const tally = counts(grid);
  expect(tally.get(winner)).toBe(SCRATCH_MATCH);
  const matches = [...tally].filter(([, n]) => n >= SCRATCH_MATCH).map(([rarity]) => rarity);
  expect(matches).toEqual([winner]);
}

describe('granting a scratch card', () => {
  it('stamps the server clock and books one card mint → inventory, listed in state', async () => {
    const session = await newSession();
    const at = Date.now() - 4_321;
    const cardId = await inPlayer(session, (sql) =>
      grantScratchCard(sql, { source: 'quest:test' }, { at, idempotencyKey: null }),
    );
    expect(cardId).toMatch(new RegExp(`^${ENTITY_ID_PREFIXES.scratchCard}_[A-Za-z0-9]{20}$`));
    expect(await cardRecord(session, cardId)).toEqual({
      state: 'held',
      source: 'quest:test',
      granted_at: at,
      revealed_at: null,
      rarity: null,
      grid: null,
    });
    expect(await ledgerOf(session, SCRATCH_GRANT_TX_KIND)).toEqual([
      expect.objectContaining({ account: 'mint', unit: 'scratchCard', delta: -1, ref: cardId }),
      expect.objectContaining({ account: 'inventory', unit: 'scratchCard', delta: 1, ref: cardId }),
    ]);
    expect((await state(session)).inventory.scratchCards).toEqual([cardId]);
    expect(await playerStub(session.tokens.playerId).conservation()).toMatchObject({
      scratchCardsHeld: 1,
      ledgerScratchCardsHeld: 1,
      conserved: true,
    });
  });

  it('refuses a grant with no source to audit', async () => {
    const session = await newSession();
    await expect(
      inPlayer(session, (sql) =>
        grantScratchCard(sql, { source: '' }, { at: Date.now(), idempotencyKey: null }),
      ),
    ).rejects.toThrow(/name the source/);
    expect((await state(session)).inventory.scratchCards).toEqual([]);
  });

  it('starts a new player with no cards and lists only unrevealed ones, oldest first', async () => {
    const session = await newSession();
    expect((await state(session)).inventory.scratchCards).toEqual([]);
    const first = await giveCard(session, 'quest:a');
    const second = await giveCard(session, 'goldenHour:b');
    const third = await giveCard(session, 'quest:c');
    expect((await state(session)).inventory.scratchCards).toEqual([first, second, third]);
    await revealOk(await postReveal(session, { cardId: second }));
    expect((await state(session)).inventory.scratchCards).toEqual([first, third]);
    await expectConserved(session);
  });

  it('keeps a card fixed in storage: no delete, no rewrite, no second reveal', async () => {
    const session = await newSession();
    const cardId = await giveCard(session);
    await inPlayer(session, (sql) => {
      expect(() =>
        sql.exec('UPDATE scratch_cards SET granted_at = 0 WHERE id = ?', cardId),
      ).toThrow(/reveals once/);
      expect(() => sql.exec('DELETE FROM scratch_cards')).toThrow(/append-only/);
      expect(() =>
        sql.exec(
          "UPDATE scratch_cards SET state = 'revealed', revealed_at = ? WHERE id = ?",
          Date.now(),
          cardId,
        ),
      ).toThrow(/CHECK/);
    });
    await revealOk(await postReveal(session, { cardId }));
    await inPlayer(session, (sql) => {
      expect(() =>
        sql.exec("UPDATE scratch_cards SET rarity = 'legendary', grid = '[]' WHERE id = ?", cardId),
      ).toThrow(/reveals once/);
      expect(() =>
        sql.exec(
          "UPDATE scratch_cards SET state = 'held', revealed_at = NULL WHERE id = ?",
          cardId,
        ),
      ).toThrow(/reveals once/);
    });
  });
});

describe('POST /v1/scratch/reveal', () => {
  it('pays the rarity’s crateRewards from the mint, retires the card to the house and conserves value', async () => {
    const session = await newSession();
    const cardId = await giveCard(session);
    const rate = await inPlayer(session, (sql) => measuredActiveRate(sql));
    const before = await state(session);
    const key = newIdempotencyKey();
    const revealed = await revealOk(await postReveal(session, { cardId }, key));

    expect(revealed.cardId).toBe(cardId);
    const row = crateRewards[revealed.roll.rarity];
    const expected = {
      coins: crateIncomeCoins(row.incomeSeconds, rate, offlineRate),
      ...(row.pearls > 0 ? { pearls: row.pearls } : {}),
      ...(row.keys > 0 ? { keys: row.keys } : {}),
      ...(row.tickets > 0 ? { tickets: row.tickets } : {}),
    };
    expect(currencyRewards(revealed.roll.rewards)).toEqual(expected);
    expect(revealed.wallet.pearls - before.wallet.pearls).toBe(expected.pearls ?? 0);
    expect(revealed.wallet.keys - before.wallet.keys).toBe(expected.keys ?? 0);
    expect(revealed.wallet.tickets - before.wallet.tickets).toBe(expected.tickets ?? 0);
    expect((await state(session)).wallet).toEqual(revealed.wallet);

    const legs = await ledgerOf(session, SCRATCH_REVEAL_TX_KIND);
    expect(txCount(legs)).toBe(1);
    expect(legs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ account: 'inventory', unit: 'scratchCard', delta: -1 }),
        expect.objectContaining({ account: 'house', unit: 'scratchCard', delta: 1 }),
        expect.objectContaining({ account: 'wallet', unit: 'coins', delta: expected.coins }),
      ]),
    );
    expect(legs.every((leg) => leg.ref === cardId && leg.idempotency_key === key)).toBe(true);
    expect(legs.filter((leg) => leg.account === 'mint').every((leg) => leg.delta < 0)).toBe(true);

    const record = await cardRecord(session, cardId);
    expect(record).toMatchObject({ state: 'revealed', rarity: revealed.roll.rarity });
    expect(JSON.parse(record?.grid ?? 'null')).toEqual(revealed.grid);
    expect((await state(session)).inventory.scratchCards).toEqual([]);
    expect(await playerStub(session.tokens.playerId).conservation()).toMatchObject({
      scratchCardsHeld: 0,
      ledgerScratchCardsHeld: 0,
      conserved: true,
    });
  });

  it('shows exactly one 3-match on the card, of the rarity the roll paid', async () => {
    const session = await newSession();
    const seen = new Set<Rarity>();
    for (let i = 0; i < 12; i++) {
      const revealed = await revealOk(
        await postReveal(session, { cardId: await giveCard(session) }),
      );
      expectOneMatchOf(revealed.grid, revealed.roll.rarity);
      seen.add(revealed.roll.rarity);
    }
    expect(seen.has('heirloom')).toBe(false);
    await expectConserved(session);
  });

  it('stamps revealed_at from the server clock, whatever clock headers the client sends', async () => {
    const session = await newSession();
    const cardId = await giveCard(session);
    const future = Date.now() + 365 * 24 * 3_600_000;
    const started = Date.now();
    const response = await session.call(endpoints.scratchReveal.path, {
      body: { cardId },
      via: (request) => {
        const headers = new Headers(request.headers);
        headers.set('Date', new Date(future).toUTCString());
        headers.set('X-Client-Time', String(future));
        return exports.default.fetch(new Request(request, { headers }));
      },
    });
    await revealOk(response);
    const record = await cardRecord(session, cardId);
    expect(record?.revealed_at).toBeGreaterThanOrEqual(started);
    expect(record?.revealed_at).toBeLessThanOrEqual(Date.now());
  });
});

describe('a scratch card reveals exactly once', () => {
  it('replays the same Idempotency-Key with the same card, rolling and paying once', async () => {
    const session = await newSession();
    const cardId = await giveCard(session);
    const key = newIdempotencyKey();
    const first = await postReveal(session, { cardId }, key);
    const firstBody = await revealOk(first);
    expect(first.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull();
    const after = await state(session);

    const replay = await postReveal(session, { cardId }, key);
    expect(await revealOk(replay)).toEqual(firstBody);
    expect(replay.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('true');
    const again = await state(session);
    expect(again.fair).toEqual(after.fair);
    expect(again.wallet).toEqual(after.wallet);
    expect(txCount(await ledgerOf(session, SCRATCH_REVEAL_TX_KIND))).toBe(1);
    await expectConserved(session);
  });

  it('refuses a second reveal under a new key with conflict, paying nothing more', async () => {
    const session = await newSession();
    const cardId = await giveCard(session);
    await revealOk(await postReveal(session, { cardId }));
    const after = await state(session);
    const rows = await ledgerRows(session);
    for (let i = 0; i < 3; i++) {
      await expectError(await postReveal(session, { cardId }), 409, 'conflict');
    }
    const again = await state(session);
    expect(again.wallet).toEqual(after.wallet);
    expect(again.fair).toEqual(after.fair);
    expect(await ledgerRows(session)).toBe(rows);
    await expectConserved(session);
  });

  it('refuses a reused Idempotency-Key for a different card and leaves that card held', async () => {
    const session = await newSession();
    const a = await giveCard(session);
    const b = await giveCard(session);
    const key = newIdempotencyKey();
    await revealOk(await postReveal(session, { cardId: a }, key));
    await expectError(await postReveal(session, { cardId: b }, key), 422, 'idempotency_key_reused');
    expect((await state(session)).inventory.scratchCards).toEqual([b]);
    expect(await cardRecord(session, b)).toMatchObject({ state: 'held' });
  });

  it('lets exactly one of several racing reveals through', async () => {
    const session = await newSession();
    const cardId = await giveCard(session);
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => postReveal(session, { cardId })),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409, 409, 409]);
    expect(txCount(await ledgerOf(session, SCRATCH_REVEAL_TX_KIND))).toBe(1);
    await expectConserved(session);
  });

  it('refuses foreign and forged card IDs alike with not_found, moving nothing', async () => {
    const owner = await newSession();
    const thief = await newSession();
    const theirs = await giveCard(owner);
    const before = await state(thief);
    const rows = await ledgerRows(thief);
    const forged = `${ENTITY_ID_PREFIXES.scratchCard}_${'A'.repeat(20)}`;
    for (const cardId of [theirs, forged]) {
      const response = await postReveal(thief, { cardId });
      await expectError(response, 404, 'not_found');
    }
    for (const cardId of [
      'scratch_short',
      `${ENTITY_ID_PREFIXES.safe}_${'A'.repeat(20)}`,
      `${ENTITY_ID_PREFIXES.scratchCard}_${'A'.repeat(19)}!`,
      '',
      42,
      null,
    ]) {
      await expectError(await postReveal(thief, { cardId }), 400, 'validation_failed');
    }
    const after = await state(thief);
    expect(after.wallet).toEqual(before.wallet);
    expect(after.fair).toEqual(before.fair);
    expect(await ledgerRows(thief)).toBe(rows);
    expect((await state(owner)).inventory.scratchCards).toEqual([theirs]);
    expect(await cardRecord(owner, theirs)).toMatchObject({ state: 'held' });
  });

  it('refuses client-sent grids, rolls, rarities, wallets and times before touching the card', async () => {
    const session = await newSession();
    const cardId = await giveCard(session);
    const before = await state(session);
    for (const forged of [
      { cardId, grid: Array.from({ length: SCRATCH_GRID_SIZE }, () => 'legendary') },
      { cardId, roll: { rarity: 'heirloom' } },
      { cardId, rarity: 'legendary' },
      { cardId, wallet: { pearls: 9_999 } },
      { cardId, rewards: [{ kind: 'currency', currency: 'coins', amount: 1e9 }] },
      { cardId, pity: { legendary: 119 } },
      { cardId, at: Date.now() + 1e9 },
      { cardId, nonce: 0 },
      {},
    ]) {
      await expectError(await postReveal(session, forged), 400, 'validation_failed');
    }
    const after = await state(session);
    expect(after.wallet).toEqual(before.wallet);
    expect(after.fair).toEqual(before.fair);
    expect(after.inventory.scratchCards).toEqual([cardId]);
  });

  it('needs a signed request, a valid token and an Idempotency-Key', async () => {
    const session = await newSession();
    const cardId = await giveCard(session);
    const body = { cardId };
    await expectError(
      await session.call(endpoints.scratchReveal.path, { body, idempotencyKey: null }),
      400,
      'idempotency_key_missing',
    );
    await expectError(
      await session.call(endpoints.scratchReveal.path, { body, signature: null }),
      401,
      'invalid_signature',
    );
    await expectError(
      await session.call(endpoints.scratchReveal.path, { body, accessToken: 'forged' }),
      401,
      'unauthorized',
    );
    expect((await state(session)).inventory.scratchCards).toEqual([cardId]);
  });
});

describe('the reveal roll', () => {
  it('is the committed seed chain rolling scratch with pity, and the grid rebuilds from the revealed seed', async () => {
    const session = await newSession();
    const committed = (await state(session)).fair;
    let pityBefore = await inPlayer(session, (sql) => readPity(sql, SCRATCH_DROP_SOURCE));
    for (let i = 0; i < 4; i++) {
      const cardId = await giveCard(session);
      const secret = await fairSecret(session);
      const revealed = await revealOk(await postReveal(session, { cardId }));
      expect(revealed.roll.proof).toEqual({ ...committed, nonce: committed.nonce + i });

      const rng = fairRngFromDigest(
        fairDigest(secret, revealed.roll.proof.clientSeed, revealed.roll.proof.nonce),
      );
      const replayed = rollDrop(SCRATCH_TABLE, pity, pityBefore, rng);
      expect(revealed.roll.rarity).toBe(replayed.rarity);
      expect(revealed.grid).toEqual(scratchGrid(replayed.rarity, rng));
      expect(revealed.roll.pity).toEqual({
        rare: replayed.state.rare,
        exquisite: replayed.state.exquisite,
        legendary: replayed.state.legendary,
      });
      pityBefore = replayed.state;
    }
    expect((await state(session)).fair).toEqual({ ...committed, nonce: committed.nonce + 4 });
    expect(await inPlayer(session, (sql) => readPity(sql, SCRATCH_DROP_SOURCE))).toEqual(
      pityBefore,
    );
  });

  it('forces each pitied rarity when its counter would expire, and never an Heirloom', async () => {
    for (const rule of pity.rules) {
      const session = await newSession();
      await setPity(session, { [rule.rarity]: rule.within - 1 });
      const cardId = await giveCard(session);
      const revealed = await revealOk(await postReveal(session, { cardId }));
      expect(rarityRank(revealed.roll.rarity)).toBeGreaterThanOrEqual(rarityRank(rule.rarity));
      expect(revealed.roll.rarity).not.toBe('heirloom');
      expect(revealed.roll.pity[rule.rarity]).toBe(0);
      expectOneMatchOf(revealed.grid, revealed.roll.rarity);
    }
  });

  it('keeps scratch pity apart from other sources', async () => {
    const session = await newSession();
    await inPlayer(session, (sql) => {
      sql.exec("INSERT INTO pity_counters (source, rarity, misses) VALUES ('goldSafe', 'rare', 7)");
    });
    await revealOk(await postReveal(session, { cardId: await giveCard(session) }));
    expect(await inPlayer(session, (sql) => readPity(sql, 'goldSafe'))).toMatchObject({ rare: 7 });
  });
});

describe('scratchGrid', () => {
  it('always lays one 3-match of the winner and at most two of any other rarity', () => {
    for (const winner of RARITY_IDS) {
      for (let seed = 0; seed < 500; seed++) {
        expectOneMatchOf(scratchGrid(winner, createRng(seed)), winner);
      }
    }
  });

  it('is a pure function of the roll stream and spreads the match across the card', () => {
    expect(scratchGrid('rare', createRng(7))).toEqual(scratchGrid('rare', createRng(7)));
    const winnerCells = new Set<number>();
    for (let seed = 0; seed < 200; seed++) {
      scratchGrid('fine', createRng(seed)).forEach((gem, cell) => {
        if (gem === 'fine') winnerCells.add(cell);
      });
    }
    expect(winnerCells.size).toBe(SCRATCH_GRID_SIZE);
  });
});

function recordingHost(result: DoResult<ScratchRevealResponse>) {
  const commands: Command<unknown>[] = [];
  const host: ScratchHost = {
    revealScratch(command) {
      commands.push(command);
      return Promise.resolve(result);
    },
  };
  return { host, commands };
}

function appFor(host: ScratchHost): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use(requestIdMiddleware);
  app.route(
    '/',
    createScratchRoutes(() => host),
  );
  app.onError((error, c) => {
    if (!(error instanceof ApiFailure)) return c.json({ error: { code: 'internal' } }, 500);
    return c.json(error.envelope(c.get('requestId')), error.status as ContentfulStatusCode);
  });
  return app;
}

async function postTo(app: Hono<AppEnv>, session: Session, body: unknown): Promise<Response> {
  const path = endpoints.scratchReveal.path;
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

describe('createScratchRoutes', () => {
  it('forwards only the card ID, and refuses client-sent results before reaching the player', async () => {
    const session = await newSession();
    const cardId = `${ENTITY_ID_PREFIXES.scratchCard}_${'b'.repeat(20)}`;
    const { host, commands } = recordingHost({
      ok: false,
      error: { code: 'not_found', message: 'No scratch card.' },
    });
    const app = appFor(host);
    await expectError(await postTo(app, session, { cardId }), 404, 'not_found');
    expect(commands).toHaveLength(1);
    expect(commands[0]?.body).toEqual({ cardId });

    for (const forged of [
      { cardId, grid: ['heirloom', 'heirloom', 'heirloom'] },
      { cardId, roll: { rarity: 'legendary' } },
      { cardId, wallet: { coins: 1e9 } },
    ]) {
      await expectError(await postTo(app, session, forged), 400, 'validation_failed');
    }
    expect(commands).toHaveLength(1);
  });

  it('refuses a host answer that breaks the response contract instead of passing it on', async () => {
    const session = await newSession();
    const cardId = `${ENTITY_ID_PREFIXES.scratchCard}_${'c'.repeat(20)}`;
    const wallet = (await state(session)).wallet;
    const { host } = recordingHost({
      ok: true,
      replayed: false,
      body: {
        cardId,
        grid: ['common', 'common'],
        roll: {
          rarity: 'common',
          rewards: [{ kind: 'currency', currency: 'coins', amount: 1 }],
          proof: { serverSeedHash: 'a'.repeat(64), clientSeed: 'seedseedseedseed', nonce: 0 },
          pity: { rare: 0, exquisite: 0, legendary: 0 },
        },
        wallet,
      } as unknown as ScratchRevealResponse,
    });
    expect((await postTo(appFor(host), session, { cardId })).status).toBe(500);
  });
});
