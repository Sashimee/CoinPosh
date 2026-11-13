import {
  ascension,
  ascensionGoldBars,
  bullion,
  coinTiers,
  MINT_MICROS_PER_COIN,
  mintedCoinMicros,
  mintedCoinValue,
  openingHeap,
  upgradeCost,
  upgradeLines,
  upgradeStat,
  venues,
} from '@coinposh/economy';
import {
  endpoints,
  HEADERS,
  WalletSchema,
  type AscendRequest,
  type AscendResponse,
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
import { Entities } from '../do/entities.ts';
import type { Command, DoResult, PlayerDO } from '../do/PlayerDO.ts';
import { commit, ledgerBalance, LedgerTx, readWallet, type Leg } from '../do/ledger.ts';
import type { AppEnv } from '../http/context.ts';
import { IDEMPOTENT_REPLAYED_HEADER } from '../http/cors.ts';
import { ApiFailure } from '../http/errors.ts';
import { requestIdMiddleware } from '../http/signed.ts';
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
  tableSession,
  vaultCoins,
} from '../test/game.ts';
import {
  applyAscension,
  ASCEND_TX_KIND,
  ascensionLegs,
  buyFamilyOffice,
  createAscendRoutes,
  currentVenue,
  familyOfficeEffect,
  isFamilyOfficeLine,
  lifetimeBullion,
  quoteAscension,
  quoteFamilyOffice,
  readFamilyOfficeLevels,
  unlockedVenues,
  type AscendHost,
  type AscensionCommit,
} from './ascend.ts';
import { readUpgradeLevels, recordUpgrade } from './upgrades.ts';

const RIVIERA = venues[0];
const PARIS = venues[1];

function wallet(partial: Partial<Wallet>): Wallet {
  return WalletSchema.parse({
    coins: 0,
    bullion: 0,
    goldBars: 0,
    pearls: 0,
    keys: 0,
    tickets: 0,
    stars: 0,
    ...partial,
  });
}

function ascend(venueId: string): AscendRequest {
  return endpoints.ascend.body.parse({ venueId });
}

function buy(lineId: string, level: number, venueId: string = RIVIERA.id): UpgradeBuyRequest {
  return endpoints.upgradesBuy.body.parse({ venueId, lineId, level });
}

function line(id: string) {
  const found = upgradeLines.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`economy has no ${id} line`);
  return found;
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

/** Commits the ascension's legs as one real `ascend` ledger transaction. */
const postToLedger =
  (sql: SqlStorage, at: number): AscensionCommit =>
  (kind, legs: readonly Leg[]) => {
    const tx = new LedgerTx(kind);
    for (const leg of legs) tx.post(leg.account, leg.unit, leg.delta, leg.ref);
    commit(sql, tx, { at, idempotencyKey: null });
  };

/** Wins `value` coins the way play does: the house stakes the table, a claim pays the wallet. */
function win(sql: SqlStorage, value: number): void {
  const context = { at: 1, idempotencyKey: null };
  commit(sql, new LedgerTx('grant.heap').move('mint', 'table', 'coins', value, null), context);
  commit(sql, new LedgerTx('claim.fall').move('table', 'wallet', 'coins', value, null), context);
}

function valueForBullion(amount: number): number {
  return amount * bullion.valuePerBullion;
}

/** Runs `body` against a fresh player's real PlayerDO storage, inside one storage transaction. */
async function withPlayer<T>(body: (sql: SqlStorage) => T): Promise<T> {
  const session = await newSession();
  return runInDurableObject(playerStub(session.tokens.playerId), (_: PlayerDO, ctx) =>
    ctx.storage.transactionSync(() => body(ctx.storage.sql)),
  );
}

describe('Bullion and eligibility come from server state only', () => {
  it('counts Bullion from the ledger winnings at 1 per valuePerBullion, ignoring house losses', async () => {
    await withPlayer((sql) => {
      expect(lifetimeBullion(sql)).toBe(0);
      win(sql, valueForBullion(3) + bullion.valuePerBullion - 1);
      commit(
        sql,
        new LedgerTx('claim.fall').move('table', 'house', 'coins', valueForBullion(50), null),
        { at: 1, idempotencyKey: null },
      );
      expect(lifetimeBullion(sql)).toBe(3);
    });
  });

  it('refuses an ineligible ascension with not_ready and moves no value', async () => {
    await withPlayer((sql) => {
      win(sql, valueForBullion(RIVIERA.bullionThreshold) - 1);
      const before = readWallet(sql);
      expect(failureCode(() => quoteAscension(sql, ascend(RIVIERA.id)))).toBe('not_ready');
      expect(
        failureCode(() => applyAscension(sql, ascend(RIVIERA.id), postToLedger(sql, 2), 2)),
      ).toBe('not_ready');
      expect(readWallet(sql)).toEqual(before);
      expect(currentVenue(sql).id).toBe(RIVIERA.id);
    });
  });

  it('refuses a venue that is not the current one', async () => {
    await withPlayer((sql) => {
      win(sql, valueForBullion(PARIS.bullionThreshold * 4));
      expect(failureCode(() => quoteAscension(sql, ascend(PARIS.id)))).toBe('forbidden');
    });
  });
});

describe('applyAscension', () => {
  it('resets the venue, credits Gold Bars from the economy formula and unlocks the next venue', async () => {
    await withPlayer((sql) => {
      const earned = RIVIERA.bullionThreshold * 4;
      win(sql, valueForBullion(earned));
      recordUpgrade(sql, {
        venueId: RIVIERA.id,
        lineId: 'coinValue',
        level: 3,
        currency: 'coins',
        cost: 0,
      });
      const wonCoins = readWallet(sql).coins;
      expect(wonCoins).toBeGreaterThan(valueForBullion(earned) - 1);

      const result = applyAscension(sql, ascend(RIVIERA.id), postToLedger(sql, 5), 5);

      const bars = ascensionGoldBars(earned, RIVIERA.bullionThreshold, ascension);
      expect(bars).toBe(20);
      expect(result).toEqual({
        venueId: RIVIERA.id,
        goldBarsGranted: bars,
        unlockedVenueId: PARIS.id,
      });
      const after = readWallet(sql);
      expect(after.goldBars).toBe(bars);
      expect(after.coins).toBe(upgradeStat(line('trustFund'), 0));
      expect(after.bullion).toBe(0);
      expect(readUpgradeLevels(sql, RIVIERA.id)).toMatchObject({ coinValue: 0 });
      expect(currentVenue(sql).id).toBe(PARIS.id);
      expect(unlockedVenues(sql)).toEqual([RIVIERA.id, PARIS.id]);
      expect(lifetimeBullion(sql)).toBe(0);
      for (const unit of ['coins', 'goldBars'] as const) {
        expect(ledgerBalance(sql, 'wallet', unit)).toBe(after[unit]);
      }
    });
  });

  it('cannot be double-submitted: a second ascension finds the venue already left behind', async () => {
    await withPlayer((sql) => {
      win(sql, valueForBullion(RIVIERA.bullionThreshold));
      const first = applyAscension(sql, ascend(RIVIERA.id), postToLedger(sql, 5), 5);
      expect(first.goldBarsGranted).toBe(ascension.goldBarScale);
      const credited = readWallet(sql);

      expect(
        failureCode(() => applyAscension(sql, ascend(RIVIERA.id), postToLedger(sql, 6), 6)),
      ).toBe('conflict');
      expect(
        failureCode(() => applyAscension(sql, ascend(PARIS.id), postToLedger(sql, 6), 6)),
      ).toBe('not_ready');
      expect(readWallet(sql)).toEqual(credited);
      expect(sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM ascensions').one().n).toBe(1);
    });
  });

  it('starts the next venue from the Trust Fund level bought in the Family Office', async () => {
    await withPlayer((sql) => {
      win(sql, valueForBullion(RIVIERA.bullionThreshold));
      sql.exec("INSERT INTO family_office_levels (line_id, level) VALUES ('trustFund', 2)");
      applyAscension(sql, ascend(RIVIERA.id), postToLedger(sql, 5), 5);
      expect(readWallet(sql).coins).toBe(upgradeStat(line('trustFund'), 2));
      expect(readFamilyOfficeLevels(sql)).toMatchObject({ trustFund: 2 });
    });
  });

  it('only counts winnings after the last ascension toward the next venue', async () => {
    await withPlayer((sql) => {
      win(sql, valueForBullion(RIVIERA.bullionThreshold * 9));
      applyAscension(sql, ascend(RIVIERA.id), postToLedger(sql, 5), 5);
      win(sql, valueForBullion(PARIS.bullionThreshold - 1));
      expect(lifetimeBullion(sql)).toBe(PARIS.bullionThreshold - 1);
      expect(failureCode(() => quoteAscension(sql, ascend(PARIS.id)))).toBe('not_ready');
      win(sql, valueForBullion(1));
      expect(quoteAscension(sql, ascend(PARIS.id)).goldBars).toBe(ascension.goldBarScale);
    });
  });

  it('keeps the final venue current and starts it anew on every later ascension', async () => {
    await withPlayer((sql) => {
      const ordered = [...venues].sort((a, b) => a.order - b.order);
      const last = ordered[ordered.length - 1];
      if (last === undefined) throw new Error('economy has no venues');
      ordered.forEach((venue, index) => {
        expect(currentVenue(sql).id).toBe(venue.id);
        win(sql, valueForBullion(venue.bullionThreshold));
        const result = applyAscension(
          sql,
          ascend(venue.id),
          postToLedger(sql, 10 + index),
          10 + index,
        );
        expect(result.unlockedVenueId).toBe(ordered[index + 1]?.id ?? null);
      });
      expect(currentVenue(sql).id).toBe(last.id);
      expect(unlockedVenues(sql)).toEqual(ordered.map((venue) => venue.id));
      expect(lifetimeBullion(sql)).toBe(0);

      expect(
        failureCode(() => applyAscension(sql, ascend(last.id), postToLedger(sql, 20), 20)),
      ).toBe('not_ready');
      win(sql, valueForBullion(last.bullionThreshold * 4));
      const bars = readWallet(sql).goldBars;
      const again = applyAscension(sql, ascend(last.id), postToLedger(sql, 21), 21);

      expect(again).toEqual({
        venueId: last.id,
        goldBarsGranted: ascensionGoldBars(
          last.bullionThreshold * 4,
          last.bullionThreshold,
          ascension,
        ),
        unlockedVenueId: null,
      });
      expect(readWallet(sql).goldBars).toBe(bars + again.goldBarsGranted);
      expect(currentVenue(sql).id).toBe(last.id);
      expect(lifetimeBullion(sql)).toBe(0);
      expect(sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM ascensions').one().n).toBe(
        ordered.length + 1,
      );
      expect(
        failureCode(() => applyAscension(sql, ascend(last.id), postToLedger(sql, 22), 22)),
      ).toBe('not_ready');
      expect(failureCode(() => quoteAscension(sql, ascend(RIVIERA.id)))).toBe('conflict');
    });
  });

  it('builds balanced legs that never take more than the wallet holds', () => {
    const legs = ascensionLegs(
      { venue: RIVIERA, next: PARIS, lifetimeBullion: 0, goldBars: 7, startingCoins: 20 },
      wallet({ coins: 900, bullion: 4, goldBars: 3 }),
    );
    const byUnit = new Map<string, number>();
    for (const leg of legs) byUnit.set(leg.unit, (byUnit.get(leg.unit) ?? 0) + leg.delta);
    expect([...byUnit.values()].every((sum) => sum === 0)).toBe(true);
    const walletDelta = (unit: string) =>
      legs
        .filter((leg) => leg.account === 'wallet' && leg.unit === unit)
        .reduce((sum, leg) => sum + leg.delta, 0);
    expect(walletDelta('coins')).toBe(20 - 900);
    expect(walletDelta('bullion')).toBe(-4);
    expect(walletDelta('goldBars')).toBe(7);
    expect(legs.every((leg) => leg.ref === RIVIERA.id)).toBe(true);
    expect(ASCEND_TX_KIND).toBe('ascend');
  });
});

describe('The Family Office', () => {
  it('sells only the global lines from economy config', () => {
    for (const id of ['oldMoney', 'privateCourier', 'trustFund']) {
      expect(isFamilyOfficeLine(id)).toBe(true);
    }
    for (const id of ['pusherSpeed', 'coinValue', 'goldPlated']) {
      expect(isFamilyOfficeLine(id)).toBe(false);
      expect(failureCode(() => quoteFamilyOffice({}, wallet({ goldBars: 99 }), buy(id, 1)))).toBe(
        'not_found',
      );
    }
  });

  it('prices from upgradeCost in Gold Bars and refuses one bar short or a stale level', () => {
    const oldMoney = line('oldMoney');
    const price = upgradeCost(oldMoney, 2);
    expect(
      quoteFamilyOffice({ oldMoney: 2 }, wallet({ goldBars: price }), buy('oldMoney', 3)),
    ).toEqual({ lineId: 'oldMoney', level: 3, cost: price });
    expect(
      failureCode(() =>
        quoteFamilyOffice(
          { oldMoney: 2 },
          wallet({ goldBars: price - 1, coins: 1e9 }),
          buy('oldMoney', 3),
        ),
      ),
    ).toBe('insufficient_funds');
    expect(
      failureCode(() =>
        quoteFamilyOffice({ oldMoney: 2 }, wallet({ goldBars: 1e6 }), buy('oldMoney', 2)),
      ),
    ).toBe('conflict');
    expect(
      failureCode(() =>
        quoteFamilyOffice(
          { oldMoney: oldMoney.maxLevel },
          wallet({ goldBars: 1e9 }),
          buy('oldMoney', oldMoney.maxLevel + 1),
        ),
      ),
    ).toBe('conflict');
  });

  it('spends Gold Bars to the house, keeps the level through an ascension and reads its effect', async () => {
    await withPlayer((sql) => {
      win(sql, valueForBullion(RIVIERA.bullionThreshold * 4));
      applyAscension(sql, ascend(RIVIERA.id), postToLedger(sql, 5), 5);
      const bars = readWallet(sql).goldBars;
      const cost = upgradeCost(line('oldMoney'), 0);

      const bought = buyFamilyOffice(sql, buy('oldMoney', 1, PARIS.id), {
        at: 6,
        idempotencyKey: 'k',
      });
      expect(bought).toMatchObject({ lineId: 'oldMoney', level: 1 });
      expect(bought.wallet.goldBars).toBe(bars - cost);
      expect(ledgerBalance(sql, 'house', 'goldBars')).toBe(cost);
      expect(readFamilyOfficeLevels(sql)).toMatchObject({ oldMoney: 1, trustFund: 0 });
      expect(familyOfficeEffect(readFamilyOfficeLevels(sql), 'globalCoinValue')).toBeCloseTo(
        upgradeStat(line('oldMoney'), 1),
      );
      expect(
        failureCode(() =>
          buyFamilyOffice(sql, buy('oldMoney', 1, PARIS.id), { at: 7, idempotencyKey: 'k2' }),
        ),
      ).toBe('conflict');
    });
  });
});

interface RecordingHost extends AscendHost {
  readonly commands: Command<AscendRequest>[];
}

function recordingHost(result: DoResult<AscendResponse>): RecordingHost {
  const commands: Command<AscendRequest>[] = [];
  return {
    commands,
    ascend(command) {
      commands.push(command);
      return Promise.resolve(result);
    },
  };
}

function appFor(host: AscendHost): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use(requestIdMiddleware);
  app.route(
    '/',
    createAscendRoutes(() => host),
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
  const path = endpoints.ascend.path;
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

const ASCENDED: AscendResponse = endpoints.ascend.response.parse({
  venueId: RIVIERA.id,
  goldBarsGranted: 20,
  unlockedVenueId: PARIS.id,
  wallet: wallet({ coins: 20, goldBars: 20 }),
});

describe('POST /v1/ascend', () => {
  it('forwards only the venue and idempotency key, and returns the server result', async () => {
    const session = await newSession();
    const host = recordingHost({ ok: true, replayed: false, body: ASCENDED });
    const key = newIdempotencyKey();
    const response = await post(appFor(host), session, ascend(RIVIERA.id), {
      idempotencyKey: key,
    });
    expect(response.status).toBe(200);
    expect(endpoints.ascend.response.parse(await response.json())).toEqual(ASCENDED);
    expect(host.commands).toHaveLength(1);
    expect(host.commands[0]).toMatchObject({ idempotencyKey: key, body: ascend(RIVIERA.id) });
    expect(host.commands[0]?.fingerprint).toMatch(/^POST \/v1\/ascend [0-9a-f]{64}$/);
  });

  it('refuses client-sent Gold Bars, Bullion or wallets without reaching the player', async () => {
    const session = await newSession();
    const host = recordingHost({ ok: true, replayed: false, body: ASCENDED });
    const app = appFor(host);
    for (const forged of [
      { ...ascend(RIVIERA.id), goldBarsGranted: 999 },
      { ...ascend(RIVIERA.id), lifetimeBullion: 1e9 },
      { ...ascend(RIVIERA.id), wallet: wallet({ goldBars: 1e6 }) },
      { venueId: 'atlantis' },
      {},
    ]) {
      await expectError(await post(app, session, forged), 400, 'validation_failed');
    }
    expect(host.commands).toHaveLength(0);
  });

  it('needs a signed-in device and an Idempotency-Key', async () => {
    const session = await newSession();
    const host = recordingHost({ ok: true, replayed: false, body: ASCENDED });
    const app = appFor(host);
    expect((await post(app, session, ascend(RIVIERA.id), { authorized: false })).status).toBe(401);
    await expectError(
      await post(app, session, ascend(RIVIERA.id), { idempotencyKey: null }),
      400,
      'idempotency_key_missing',
    );
    expect(host.commands).toHaveLength(0);
  });

  it('passes not_ready through and marks a replayed ascension', async () => {
    const session = await newSession();
    const early = recordingHost({
      ok: false,
      error: { code: 'not_ready', message: 'Ascending rivieraYacht needs 4400 Bullion.' },
    });
    await expectError(await post(appFor(early), session, ascend(RIVIERA.id)), 409, 'not_ready');

    const replay = recordingHost({ ok: true, replayed: true, body: ASCENDED });
    const response = await post(appFor(replay), session, ascend(RIVIERA.id));
    expect(response.status).toBe(200);
    expect(response.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('true');
    expect(endpoints.ascend.response.parse(await response.json())).toEqual(ASCENDED);
  });
});

const COPPER = coinTiers[0];
const TRUST_FUND = line('trustFund');

function inPlayer<T>(session: Session, run: (sql: SqlStorage) => T): Promise<T> {
  return runInDurableObject(playerStub(session.tokens.playerId), (_: PlayerDO, ctx) =>
    ctx.storage.transactionSync(() => run(ctx.storage.sql)),
  );
}

/**
 * Wins `value` coins the way play does: the house stakes a coin on the table and the real
 * claims route takes it over the front lip, so the Bullion comes from an ordinary win.
 */
async function winAtTable(session: Session, value: number): Promise<void> {
  await tableSession(session);
  const coinId = await inPlayer(session, (sql) => {
    const coin = new Entities(sql).mintCoin(COPPER.id, value, null, 'table', 0, Date.now());
    commit(sql, new LedgerTx('grant.heap').move('house', 'table', 'coins', value, coin.id), {
      at: Date.now(),
      idempotencyKey: null,
    });
    return coin.id;
  });
  const { results } = await claims(session, [{ kind: 'fall', coinId, tick: 0, edge: 'front' }]);
  expect(results).toEqual([expect.objectContaining({ status: 'accepted' })]);
}

/** A Vault Crate on the table, minted the way a drop spawns one. */
function spawnCrate(session: Session): Promise<string> {
  return inPlayer(session, (sql) => {
    const crate = new Entities(sql).spawnCrate('vault', 0, Date.now());
    commit(sql, new LedgerTx('crate.spawn').move('mint', 'table', 'crate', 1, crate.id), {
      at: Date.now(),
      idempotencyKey: null,
    });
    return crate.id;
  });
}

function postAscend(
  session: Session,
  body: unknown,
  idempotencyKey: IdempotencyKey = newIdempotencyKey(),
): Promise<Response> {
  return session.call(endpoints.ascend.path, { body, idempotencyKey });
}

async function ascendOk(response: Response): Promise<AscendResponse> {
  expect(response.status, await response.clone().text()).toBe(200);
  return endpoints.ascend.response.parse(await response.json());
}

function postBuy(
  session: Session,
  body: unknown,
  idempotencyKey: IdempotencyKey = newIdempotencyKey(),
): Promise<Response> {
  return session.call(endpoints.upgradesBuy.path, { body, idempotencyKey });
}

async function buyOk(response: Response): Promise<UpgradeBuyResponse> {
  expect(response.status, await response.clone().text()).toBe(200);
  return endpoints.upgradesBuy.response.parse(await response.json());
}

interface LedgerLeg {
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
      .exec<LedgerLeg & Record<string, SqlStorageValue>>(
        'SELECT tx_id, account, unit, delta, ref, idempotency_key FROM ledger WHERE kind = ? ORDER BY seq',
        kind,
      )
      .toArray(),
  );
}

/** A player at the first venue holding `bullionEarned` Bullion, ready to ascend. */
async function eligiblePlayer(bullionEarned: number = RIVIERA.bullionThreshold): Promise<Session> {
  const session = await newSession();
  await winAtTable(session, valueForBullion(bullionEarned));
  expect((await state(session)).venue.lifetimeBullion).toBe(bullionEarned);
  return session;
}

const NO_FAMILY_OFFICE = { oldMoney: 0, privateCourier: 0, trustFund: 0 };

describe('GET /v1/state venue progress', () => {
  it('reports the current venue, unlocked venues, Bullion and Family Office from storage', async () => {
    const session = await newSession();
    const fresh = await state(session);
    expect(fresh.venue).toMatchObject({
      id: RIVIERA.id,
      unlocked: [RIVIERA.id],
      lifetimeBullion: 0,
    });
    expect(fresh.venue.loadout).toHaveLength(RIVIERA.charmSockets);
    expect(fresh.familyOffice).toEqual(NO_FAMILY_OFFICE);
    expect(Object.keys(fresh.venue.upgrades)).not.toContain('oldMoney');

    await winAtTable(session, valueForBullion(7) + bullion.valuePerBullion - 1);
    expect((await state(session)).venue.lifetimeBullion).toBe(7);
  });
});

describe('POST /v1/ascend against a real PlayerDO', () => {
  it('refuses an ascension below the threshold and moves nothing', async () => {
    const session = await eligiblePlayer(RIVIERA.bullionThreshold - 1);
    const before = await state(session);
    const report = await playerStub(session.tokens.playerId).conservation();

    await expectError(await postAscend(session, ascend(RIVIERA.id)), 409, 'not_ready');

    const after = await state(session);
    expect(after.wallet).toEqual(before.wallet);
    expect(after.venue).toEqual(before.venue);
    expect(after.table.coins).toEqual(before.table.coins);
    expect(await playerStub(session.tokens.playerId).conservation()).toEqual(report);
    expect(await ledgerOf(session, ASCEND_TX_KIND)).toEqual([]);
  });

  it('refuses venues other than the current one and any client-sent value', async () => {
    const session = await eligiblePlayer(PARIS.bullionThreshold * 2);
    await expectError(await postAscend(session, ascend(PARIS.id)), 403, 'forbidden');
    await expectError(await postAscend(session, { venueId: 'atlantis' }), 400, 'validation_failed');
    for (const forged of [
      { ...ascend(RIVIERA.id), goldBarsGranted: 1e6 },
      { ...ascend(RIVIERA.id), lifetimeBullion: 1e9 },
      { ...ascend(RIVIERA.id), at: 0 },
    ]) {
      await expectError(await postAscend(session, forged), 400, 'validation_failed');
    }
    expect(await ledgerOf(session, ASCEND_TX_KIND)).toEqual([]);
    expect((await state(session)).venue.id).toBe(RIVIERA.id);

    await ascendOk(await postAscend(session, ascend(RIVIERA.id)));
    await expectError(await postAscend(session, ascend(RIVIERA.id)), 409, 'conflict');
    await expectError(await postAscend(session, ascend(PARIS.id)), 409, 'not_ready');
    expect(new Set((await ledgerOf(session, ASCEND_TX_KIND)).map((leg) => leg.tx_id)).size).toBe(1);
  });

  it('resets the venue, settles the old table and credits Gold Bars in one ascend entry', async () => {
    const earned = RIVIERA.bullionThreshold * 4;
    const session = await eligiblePlayer(earned);
    await buyOk(await postBuy(session, buy('coinValue', 1)));
    const crateId = await spawnCrate(session);
    const [dropped] = await dropAsClient(session, 1);
    if (dropped === undefined) throw new Error('the drop failed');
    const before = await state(session);
    expect(before.venue.upgrades).toMatchObject({ coinValue: 1 });
    expect(before.table.buffer.length).toBeGreaterThan(0);
    const key = newIdempotencyKey();

    const result = await ascendOk(await postAscend(session, ascend(RIVIERA.id), key));

    const bars = ascensionGoldBars(earned, RIVIERA.bullionThreshold, ascension);
    expect(bars).toBe(2 * ascension.goldBarScale);
    expect(result).toMatchObject({
      venueId: RIVIERA.id,
      goldBarsGranted: bars,
      unlockedVenueId: PARIS.id,
    });
    expect(result.wallet).toMatchObject({ goldBars: bars, bullion: 0 });
    expect(await vaultCoins(session)).toBe(upgradeStat(TRUST_FUND, 0));

    const after = await state(session, { hydrate: 'boot' });
    expect(after.wallet).toEqual(result.wallet);
    expect(after.venue).toMatchObject({
      id: PARIS.id,
      unlocked: [RIVIERA.id, PARIS.id],
      lifetimeBullion: 0,
    });
    expect(Object.values(after.venue.upgrades).every((level) => level === 0)).toBe(true);
    expect(after.venue.loadout).toHaveLength(PARIS.charmSockets);
    expect(after.familyOffice).toEqual(NO_FAMILY_OFFICE);

    const oldIds = new Set([...before.table.coins, ...before.table.buffer].map((coin) => coin.id));
    const heapTier = coinTiers.find((tier) => tier.id === openingHeap.tier);
    if (heapTier === undefined) throw new Error('economy has no opening heap tier');
    const heapValue = mintedCoinValue(heapTier, PARIS, {});
    expect(heapValue).toBe(heapTier.value * PARIS.coinValueMultiplier);
    expect(after.table.coins).toHaveLength(openingHeap.coins);
    for (const coin of after.table.coins) {
      expect(oldIds.has(coin.id)).toBe(false);
      expect(coin.tier).toBe(openingHeap.tier);
      expect(coin.value - heapValue).toBeGreaterThanOrEqual(0);
      expect(coin.value - heapValue).toBeLessThanOrEqual(1);
    }
    expect(after.table.buffer.some((coin) => oldIds.has(coin.id))).toBe(false);
    expect(after.table.crates).toEqual([]);

    const legs = await ledgerOf(session, ASCEND_TX_KIND);
    expect(new Set(legs.map((leg) => leg.tx_id)).size).toBe(1);
    expect(legs.every((leg) => leg.idempotency_key === key)).toBe(true);
    const sum = (filter: (leg: LedgerLeg) => boolean) =>
      legs.filter(filter).reduce((total, leg) => total + leg.delta, 0);
    for (const unit of new Set(legs.map((leg) => leg.unit))) {
      expect(sum((leg) => leg.unit === unit)).toBe(0);
    }
    expect(sum((leg) => leg.account === 'wallet' && leg.unit === 'goldBars')).toBe(bars);
    expect(sum((leg) => leg.account === 'mint' && leg.unit === 'goldBars')).toBe(-bars);
    expect(sum((leg) => leg.account === 'table' && leg.unit === 'coins')).toBe(
      -before.table.coins.reduce((total, coin) => total + coin.value, 0),
    );
    expect(sum((leg) => leg.account === 'table' && leg.unit === 'crate')).toBe(-1);
    expect(sum((leg) => leg.account === 'buffer' && leg.unit === 'coins')).toBe(
      -before.table.buffer.length * COPPER.value,
    );
    await expectConserved(session);
    expect(await playerStub(session.tokens.playerId).conservation()).toMatchObject({
      currenciesConserved: true,
      tableCrates: 0,
      ledgerCratesOnTable: 0,
    });

    const late = await claims(session, [
      { kind: 'fall', coinId: dropped.coin.id, tick: 1, edge: 'front' },
      { kind: 'crate', crateId, tick: 1, edge: 'front' },
    ]);
    expect(late.results).toEqual([
      { status: 'rejected', reason: 'already_claimed' },
      { status: 'rejected', reason: 'already_claimed' },
    ]);
    const oldBuffered = before.table.buffer[0];
    if (oldBuffered === undefined) throw new Error('expected a reserved coin before ascending');
    const replayedDrop = await session.call(endpoints.tableDrop.path, {
      body: { session: await tableSession(session), x: 0, tick: 1, coinId: oldBuffered.id },
    });
    await expectError(replayedDrop, 409, 'conflict');
    expect((await state(session)).wallet).toEqual(after.wallet);
    await expectConserved(session);
  });

  it('replays the same Idempotency-Key with the same result and never ascends twice', async () => {
    const session = await eligiblePlayer(RIVIERA.bullionThreshold * 4);
    const key = newIdempotencyKey();
    const first = await ascendOk(await postAscend(session, ascend(RIVIERA.id), key));

    const again = await postAscend(session, ascend(RIVIERA.id), key);
    expect(again.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('true');
    expect(await ascendOk(again)).toEqual(first);
    await expectError(
      await postAscend(session, ascend(PARIS.id), key),
      422,
      'idempotency_key_reused',
    );

    const now = await state(session);
    expect(now.wallet.goldBars).toBe(first.goldBarsGranted);
    expect(now.venue.unlocked).toEqual([RIVIERA.id, PARIS.id]);
    expect(new Set((await ledgerOf(session, ASCEND_TX_KIND)).map((leg) => leg.tx_id)).size).toBe(1);
    await expectConserved(session);
  });

  it('lets exactly one of two racing ascensions through', async () => {
    const session = await eligiblePlayer(RIVIERA.bullionThreshold * 4);
    const responses = await Promise.all([
      postAscend(session, ascend(RIVIERA.id)),
      postAscend(session, ascend(RIVIERA.id)),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const bars = ascensionGoldBars(
      RIVIERA.bullionThreshold * 4,
      RIVIERA.bullionThreshold,
      ascension,
    );
    expect((await state(session)).wallet.goldBars).toBe(bars);
    expect(new Set((await ledgerOf(session, ASCEND_TX_KIND)).map((leg) => leg.tx_id)).size).toBe(1);
    await expectConserved(session);
  });
});

describe('The Family Office through POST /v1/upgrades/buy', () => {
  it('charges Gold Bars only, and refuses a player without them', async () => {
    const session = await newSession();
    const before = await state(session);
    await expectError(await postBuy(session, buy('trustFund', 1)), 409, 'insufficient_funds');
    const after = await state(session);
    expect(after.wallet).toEqual(before.wallet);
    expect(after.familyOffice).toEqual(NO_FAMILY_OFFICE);
  });

  it('sells levels for Gold Bars, keeps them through ascensions and pays starting coins from them', async () => {
    const session = await eligiblePlayer(RIVIERA.bullionThreshold * 4);
    const { goldBarsGranted } = await ascendOk(await postAscend(session, ascend(RIVIERA.id)));
    const vaultBefore = await vaultCoins(session);
    const cost = upgradeCost(TRUST_FUND, 0);
    const key = newIdempotencyKey();

    const bought = await buyOk(await postBuy(session, buy('trustFund', 1, PARIS.id), key));
    expect(bought).toMatchObject({ venueId: PARIS.id, lineId: 'trustFund', level: 1 });
    expect(bought.wallet.goldBars).toBe(goldBarsGranted - cost);
    expect(await vaultCoins(session)).toBe(vaultBefore);
    const replay = await postBuy(session, buy('trustFund', 1, PARIS.id), key);
    expect(replay.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('true');
    expect(await buyOk(replay)).toEqual(bought);
    await expectError(await postBuy(session, buy('trustFund', 1, PARIS.id)), 409, 'conflict');
    await expectError(await postBuy(session, buy('trustFund', 2, RIVIERA.id)), 403, 'forbidden');
    await expectError(await postBuy(session, buy('coinValue', 1, RIVIERA.id)), 403, 'forbidden');

    const upgraded = await state(session);
    expect(upgraded.wallet.goldBars).toBe(goldBarsGranted - cost);
    expect(upgraded.familyOffice).toEqual({ ...NO_FAMILY_OFFICE, trustFund: 1 });
    expect(Object.values(upgraded.venue.upgrades).every((level) => level === 0)).toBe(true);
    const spend = (await ledgerOf(session, 'upgrade.buy')).filter((leg) => leg.unit === 'goldBars');
    expect(spend).toEqual([
      expect.objectContaining({ account: 'wallet', delta: -cost, ref: 'trustFund' }),
      expect.objectContaining({ account: 'house', delta: cost, ref: 'trustFund' }),
    ]);

    await winAtTable(session, valueForBullion(PARIS.bullionThreshold));
    const next = await ascendOk(await postAscend(session, ascend(PARIS.id)));
    expect(next.unlockedVenueId).toBe(venues[2].id);
    expect(next.wallet.goldBars).toBe(goldBarsGranted - cost + ascension.goldBarScale);
    expect(await vaultCoins(session)).toBe(Math.floor(upgradeStat(TRUST_FUND, 1)));
    expect((await state(session)).familyOffice).toEqual({ ...NO_FAMILY_OFFICE, trustFund: 1 });
    await expectConserved(session);
  });

  it('raises the value of every coin minted from Old Money on, the reserved buffer included', async () => {
    const session = await eligiblePlayer(RIVIERA.bullionThreshold * 4);
    await ascendOk(await postAscend(session, ascend(RIVIERA.id)));
    const plain = (await state(session)).table.buffer;
    const plainMicros = mintedCoinMicros(COPPER, PARIS, {});
    expect(plain.every((coin) => coin.value * MINT_MICROS_PER_COIN === plainMicros)).toBe(true);

    await buyOk(await postBuy(session, buy('oldMoney', 1, PARIS.id)));

    const richer = mintedCoinMicros(COPPER, PARIS, { oldMoney: 1 });
    expect(richer).toBeGreaterThan(plainMicros);
    const { buffer } = (await state(session)).table;
    expect(buffer.map((coin) => coin.id)).toEqual(plain.map((coin) => coin.id));
    const total = buffer.reduce((sum, coin) => sum + coin.value, 0);
    const raise = Math.floor((plain.length * (richer - plainMicros)) / MINT_MICROS_PER_COIN);
    expect(total).toBeGreaterThanOrEqual(
      plain.length * COPPER.value * PARIS.coinValueMultiplier + raise,
    );
    expect(total).toBeLessThanOrEqual(
      plain.length * COPPER.value * PARIS.coinValueMultiplier + raise + 1,
    );
    await expectConserved(session);
  });
});
