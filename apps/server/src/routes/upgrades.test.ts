import { upgradeCost, upgradeLines, venues } from '@coinposh/economy';
import {
  endpoints,
  HEADERS,
  WalletSchema,
  type ErrorCode,
  type IdempotencyKey,
  type UpgradeBuyRequest,
  type UpgradeBuyResponse,
  type Wallet,
} from '@coinposh/shared';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { describe, expect, it } from 'vitest';
import type { Command, DoResult, PlayerDO } from '../do/PlayerDO.ts';
import { HOME_VENUE } from '../do/entities.ts';
import { readWallet } from '../do/ledger.ts';
import type { AppEnv } from '../http/context.ts';
import { IDEMPOTENT_REPLAYED_HEADER } from '../http/cors.ts';
import { ApiFailure } from '../http/errors.ts';
import { requestIdMiddleware } from '../http/signed.ts';
import {
  API_ORIGIN,
  newIdempotencyKey,
  newSession,
  send,
  signParts,
  type Session,
} from '../test/client.ts';
import {
  claims,
  expectConserved,
  expectError,
  playerStub,
  state,
  vaultCoins,
} from '../test/game.ts';
import {
  createUpgradeRoutes,
  quoteUpgrade,
  readUpgradeLevels,
  recordUpgrade,
  UPGRADE_LEVELS_SQL,
  UPGRADE_LINE_IDS_V1,
  UPGRADE_LINES_V1,
  upgradeEffect,
  type UpgradeHost,
  type UpgradeLineIdV1,
} from './upgrades.ts';

function wallet(coins: number): Wallet {
  return WalletSchema.parse({
    coins,
    bullion: 0,
    goldBars: 0,
    pearls: 0,
    keys: 0,
    tickets: 0,
    stars: 0,
  });
}

function buy(lineId: string, level: number, venueId: string = HOME_VENUE.id): UpgradeBuyRequest {
  return endpoints.upgradesBuy.body.parse({ venueId, lineId, level });
}

function economyLine(id: UpgradeLineIdV1) {
  const line = upgradeLines.find((candidate) => candidate.id === id);
  if (line === undefined) throw new Error(`economy has no ${id} line`);
  return line;
}

function failureCode(run: () => unknown): ErrorCode {
  try {
    run();
  } catch (error) {
    if (error instanceof ApiFailure) return error.code;
    throw error;
  }
  throw new Error('Expected an ApiFailure, but the call succeeded.');
}

const RICH = wallet(1_000_000_000);

describe('the v1 upgrade tree', () => {
  it('is the six venue lines of the slice, taken as-is from economy config', () => {
    expect(UPGRADE_LINES_V1.map((line) => line.id)).toEqual([
      'pusherSpeed',
      'dropRate',
      'coinValue',
      'crateChance',
      'vaultCapacity',
      'offlineHours',
    ]);
    for (const line of UPGRADE_LINES_V1) {
      expect(line).toBe(upgradeLines.find((candidate) => candidate.id === line.id));
      expect(line.scope).toBe('venue');
    }
  });

  it('prices every level from upgradeCost, so the first level costs the base price', () => {
    for (const id of UPGRADE_LINE_IDS_V1) {
      const line = economyLine(id);
      expect(quoteUpgrade({}, RICH, buy(id, 1), HOME_VENUE.id).cost).toBe(line.baseCost);
      const quote = quoteUpgrade({ [id]: 3 }, RICH, buy(id, 4), HOME_VENUE.id);
      expect(quote).toEqual({
        venueId: HOME_VENUE.id,
        lineId: id,
        level: 4,
        currency: line.currency,
        cost: upgradeCost(line, 3),
      });
    }
  });

  it('sells when the wallet holds exactly the price and refuses one coin short', () => {
    const line = economyLine('dropRate');
    const price = upgradeCost(line, 2);
    expect(
      quoteUpgrade({ dropRate: 2 }, wallet(price), buy('dropRate', 3), HOME_VENUE.id).cost,
    ).toBe(price);
    expect(
      failureCode(() =>
        quoteUpgrade({ dropRate: 2 }, wallet(price - 1), buy('dropRate', 3), HOME_VENUE.id),
      ),
    ).toBe('insufficient_funds');
  });

  it('answers conflict to a stale, replayed or skipped-ahead level instead of charging', () => {
    expect(
      failureCode(() => quoteUpgrade({ coinValue: 4 }, RICH, buy('coinValue', 4), HOME_VENUE.id)),
    ).toBe('conflict');
    expect(
      failureCode(() => quoteUpgrade({ coinValue: 4 }, RICH, buy('coinValue', 3), HOME_VENUE.id)),
    ).toBe('conflict');
    expect(
      failureCode(() => quoteUpgrade({ coinValue: 4 }, RICH, buy('coinValue', 6), HOME_VENUE.id)),
    ).toBe('conflict');
  });

  it('refuses to go past the max level from config', () => {
    const line = economyLine('vaultCapacity');
    expect(
      quoteUpgrade(
        { vaultCapacity: line.maxLevel - 1 },
        RICH,
        buy(line.id, line.maxLevel),
        HOME_VENUE.id,
      ).level,
    ).toBe(line.maxLevel);
    expect(
      failureCode(() =>
        quoteUpgrade(
          { vaultCapacity: line.maxLevel },
          RICH,
          buy(line.id, line.maxLevel + 1),
          HOME_VENUE.id,
        ),
      ),
    ).toBe('conflict');
  });

  it('does not sell lines outside the v1 tree, global lines or made-up ones', () => {
    for (const id of ['fusionWindow', 'decorumCapacity', 'oldMoney', 'goldPlated']) {
      expect(failureCode(() => quoteUpgrade({}, RICH, buy(id, 1), HOME_VENUE.id))).toBe(
        'not_found',
      );
    }
  });

  it('sells venue upgrades only at the current venue the server names', () => {
    const [home, next] = [venues[0], venues[1]];
    expect(failureCode(() => quoteUpgrade({}, RICH, buy('pusherSpeed', 1, next.id), home.id))).toBe(
      'forbidden',
    );
    expect(failureCode(() => quoteUpgrade({}, RICH, buy('pusherSpeed', 1, home.id), next.id))).toBe(
      'forbidden',
    );
    expect(quoteUpgrade({}, RICH, buy('pusherSpeed', 1, next.id), next.id)).toMatchObject({
      venueId: next.id,
      level: 1,
    });
  });

  it('reads effects through upgradeStat at the stored level', () => {
    expect(upgradeEffect({}, 'offlineHours')).toBe(2);
    expect(upgradeEffect({ offlineHours: 3 }, 'offlineHours')).toBe(5);
    expect(upgradeEffect({ offlineHours: 99 }, 'offlineHours')).toBe(12);
    expect(upgradeEffect({ coinValue: 5 }, 'coinValue')).toBeCloseTo(2);
    expect(() => upgradeEffect({}, 'fusionWindow')).toThrow(/No v1 upgrade line/);
  });
});

describe('upgrade levels in PlayerDO storage', () => {
  it('start at zero for every v1 line and persist per venue once bought', async () => {
    const session = await newSession();
    await runInDurableObject(playerStub(session.tokens.playerId), (_: PlayerDO, ctx) => {
      const sql = ctx.storage.sql;
      sql.exec(UPGRADE_LEVELS_SQL);
      expect(readUpgradeLevels(sql, HOME_VENUE.id)).toEqual(
        Object.fromEntries(UPGRADE_LINE_IDS_V1.map((id) => [id, 0])),
      );
      const rich = quoteUpgrade(
        readUpgradeLevels(sql, HOME_VENUE.id),
        RICH,
        buy('dropRate', 1),
        HOME_VENUE.id,
      );
      recordUpgrade(sql, rich);
      recordUpgrade(
        sql,
        quoteUpgrade(
          readUpgradeLevels(sql, HOME_VENUE.id),
          RICH,
          buy('dropRate', 2),
          HOME_VENUE.id,
        ),
      );
      expect(readUpgradeLevels(sql, HOME_VENUE.id)).toMatchObject({ dropRate: 2, pusherSpeed: 0 });
      const other = venues[1];
      expect(readUpgradeLevels(sql, other.id)).toMatchObject({ dropRate: 0 });
    });
  });

  it('prices against the real wallet: a new player cannot afford a line above their grant', async () => {
    const session = await newSession();
    await runInDurableObject(playerStub(session.tokens.playerId), (_: PlayerDO, ctx) => {
      const sql = ctx.storage.sql;
      sql.exec(UPGRADE_LEVELS_SQL);
      const real = readWallet(sql);
      const pricey = UPGRADE_LINES_V1.find((line) => line.baseCost > real.coins);
      if (pricey === undefined) throw new Error('expected a v1 line above the starting grant');
      expect(
        failureCode(() =>
          quoteUpgrade(
            readUpgradeLevels(sql, HOME_VENUE.id),
            real,
            buy(pricey.id, 1),
            HOME_VENUE.id,
          ),
        ),
      ).toBe('insufficient_funds');
    });
  });
});

interface RecordingHost extends UpgradeHost {
  readonly commands: Command<UpgradeBuyRequest>[];
}

function recordingHost(result: DoResult<UpgradeBuyResponse>): RecordingHost {
  const commands: Command<UpgradeBuyRequest>[] = [];
  return {
    commands,
    buyUpgrade(command) {
      commands.push(command);
      return Promise.resolve(result);
    },
  };
}

function appFor(host: UpgradeHost): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use(requestIdMiddleware);
  app.route(
    '/',
    createUpgradeRoutes(() => host),
  );
  app.onError((error, c) => {
    if (!(error instanceof ApiFailure)) throw error;
    return c.json(error.envelope(c.get('requestId')), error.status as ContentfulStatusCode);
  });
  return app;
}

async function post(
  app: Hono<AppEnv>,
  session: Session,
  body: unknown,
  options: { idempotencyKey?: IdempotencyKey | null; authorized?: boolean } = {},
): Promise<Response> {
  const path = endpoints.upgradesBuy.path;
  const raw = JSON.stringify(body);
  const key = options.idempotencyKey === undefined ? newIdempotencyKey() : options.idempotencyKey;
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (options.authorized !== false) {
    headers.set(HEADERS.authorization, `Bearer ${session.tokens.accessToken}`);
  }
  if (key !== null) headers.set(HEADERS.idempotencyKey, key);
  headers.set(
    HEADERS.deviceSignature,
    await signParts(session.device.privateKey, 'POST', path, key, raw),
  );
  return app.fetch(
    new Request(`${API_ORIGIN}${path}`, { method: 'POST', headers, body: raw }),
    env,
  );
}

const CONFIRMED: UpgradeBuyResponse = endpoints.upgradesBuy.response.parse({
  venueId: HOME_VENUE.id,
  lineId: 'pusherSpeed',
  level: 1,
  wallet: wallet(75),
});

describe('POST /v1/upgrades/buy', () => {
  it('forwards only the line, level and idempotency key, and returns the confirmed wallet', async () => {
    const session = await newSession();
    const host = recordingHost({ ok: true, replayed: false, body: CONFIRMED });
    const key = newIdempotencyKey();
    const response = await post(appFor(host), session, buy('pusherSpeed', 1), {
      idempotencyKey: key,
    });

    expect(response.status).toBe(200);
    expect(endpoints.upgradesBuy.response.parse(await response.json())).toEqual(CONFIRMED);
    expect(response.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull();
    expect(host.commands).toHaveLength(1);
    expect(host.commands[0]).toMatchObject({ idempotencyKey: key, body: buy('pusherSpeed', 1) });
    expect(host.commands[0]?.fingerprint).toMatch(/^POST \/v1\/upgrades\/buy [0-9a-f]{64}$/);
  });

  it('refuses a client-supplied price, wallet or effect without reaching the player', async () => {
    const session = await newSession();
    const host = recordingHost({ ok: true, replayed: false, body: CONFIRMED });
    const app = appFor(host);
    for (const forged of [
      { ...buy('pusherSpeed', 1), cost: 0 },
      { ...buy('pusherSpeed', 1), wallet: wallet(1e9) },
      { ...buy('pusherSpeed', 1), effect: 99 },
      { venueId: HOME_VENUE.id, lineId: 'pusherSpeed', level: 0 },
      { venueId: HOME_VENUE.id, lineId: 'pusherSpeed', level: 1.5 },
    ]) {
      await expectError(await post(app, session, forged), 400, 'validation_failed');
    }
    expect(host.commands).toHaveLength(0);
  });

  it('needs a signed-in device and an Idempotency-Key', async () => {
    const session = await newSession();
    const host = recordingHost({ ok: true, replayed: false, body: CONFIRMED });
    const app = appFor(host);
    expect((await post(app, session, buy('pusherSpeed', 1), { authorized: false })).status).toBe(
      401,
    );
    await expectError(
      await post(app, session, buy('pusherSpeed', 1), { idempotencyKey: null }),
      400,
      'idempotency_key_missing',
    );
    expect(host.commands).toHaveLength(0);
  });

  it('passes the player error through and marks replays', async () => {
    const session = await newSession();
    const broke = recordingHost({
      ok: false,
      error: { code: 'insufficient_funds', message: 'pusherSpeed level 1 costs 25 coins.' },
    });
    await expectError(
      await post(appFor(broke), session, buy('pusherSpeed', 1)),
      409,
      'insufficient_funds',
    );

    const replay = recordingHost({ ok: true, replayed: true, body: CONFIRMED });
    const response = await post(appFor(replay), session, buy('pusherSpeed', 1));
    expect(response.status).toBe(200);
    expect(response.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('true');
  });
});

async function buyThroughWorker(
  session: Session,
  body: unknown,
  idempotencyKey: IdempotencyKey = newIdempotencyKey(),
): Promise<Response> {
  return send(session.device, endpoints.upgradesBuy.path, {
    accessToken: session.tokens.accessToken,
    idempotencyKey,
    body,
  });
}

/** Collects the whole opening heap at the front edge, the way a real player earns coins. */
async function collectHeap(session: Session): Promise<void> {
  const heap = (await state(session)).table.coins;
  await claims(
    session,
    heap.map((coin) => ({ kind: 'fall', coinId: coin.id, tick: 1, edge: 'front' })),
  );
}

function ledgerRows(session: Session, kind: string) {
  return runInDurableObject(playerStub(session.tokens.playerId), (_: PlayerDO, ctx) =>
    ctx.storage.sql
      .exec<{
        account: string;
        unit: string;
        delta: number;
      }>('SELECT account, unit, delta FROM ledger WHERE kind = ? ORDER BY seq', kind)
      .toArray(),
  );
}

describe('POST /v1/upgrades/buy on the deployed worker', () => {
  it('is routed to the player, not answered 404', async () => {
    const session = await newSession();
    const response = await buyThroughWorker(session, buy('pusherSpeed', 1));
    expect(response.status).not.toBe(404);
    await expectError(response, 409, 'insufficient_funds');
  });

  it('charges the price from config to the house once, and the snapshot shows the level', async () => {
    const session = await newSession();
    await collectHeap(session);
    const line = economyLine('pusherSpeed');
    const before = (await state(session)).wallet.coins;
    expect(before).toBeGreaterThanOrEqual(line.baseCost);
    const vault = await vaultCoins(session);
    const key = newIdempotencyKey();

    const first = await buyThroughWorker(session, buy('pusherSpeed', 1), key);
    expect(first.status).toBe(200);
    const bought = endpoints.upgradesBuy.response.parse(await first.json());
    expect(bought).toMatchObject({ venueId: HOME_VENUE.id, lineId: 'pusherSpeed', level: 1 });
    expect(bought.wallet.coins).toBe(before - line.baseCost);

    const replay = await buyThroughWorker(session, buy('pusherSpeed', 1), key);
    expect(replay.status).toBe(200);
    expect(replay.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('true');
    expect(endpoints.upgradesBuy.response.parse(await replay.json())).toEqual(bought);
    await expectError(await buyThroughWorker(session, buy('pusherSpeed', 1)), 409, 'conflict');

    expect(await vaultCoins(session)).toBe(vault - line.baseCost);
    expect(await ledgerRows(session, 'upgrade.buy')).toEqual([
      { account: 'wallet', unit: 'coins', delta: -line.baseCost },
      { account: 'house', unit: 'coins', delta: line.baseCost },
    ]);
    expect((await state(session)).venue.upgrades).toMatchObject({ pusherSpeed: 1, dropRate: 0 });
    await expectConserved(session);
  });

  it('refuses a forged price and a key reused for another line without charging', async () => {
    const session = await newSession();
    await collectHeap(session);
    const before = (await state(session)).wallet.coins;
    await expectError(
      await buyThroughWorker(session, { ...buy('pusherSpeed', 1), cost: 0 }),
      400,
      'validation_failed',
    );
    const key = newIdempotencyKey();
    expect((await buyThroughWorker(session, buy('pusherSpeed', 1), key)).status).toBe(200);
    await expectError(
      await buyThroughWorker(session, buy('dropRate', 1), key),
      422,
      'idempotency_key_reused',
    );
    expect((await state(session)).wallet.coins).toBe(before - economyLine('pusherSpeed').baseCost);
    expect(await ledgerRows(session, 'upgrade.buy')).toHaveLength(2);
  });
});
