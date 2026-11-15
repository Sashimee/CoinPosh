import {
  coinTiers,
  crateSpawnInterval,
  createRng,
  crateRewards,
  NEUTRAL_MULTIPLIER_BP,
  oddsTotal,
  openingHeap,
  soireeConfig,
  soireeReward,
  soireeSeatCount,
  type CoinTierId,
  type SoireeFavorDef,
} from '@coinposh/economy';
import {
  endpoints,
  RARITY_IDS,
  soireeEndpoints,
  type IdempotencyKey,
  type SoireeDraftResponse,
  type SoireeFinishResponse,
  type SoireeGuest,
  type SoireeStartResponse,
} from '@coinposh/shared';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Entities } from '../do/entities.ts';
import { commit, LedgerTx, readWallet } from '../do/ledger.ts';
import type { PlayerDO } from '../do/PlayerDO.ts';
import { IDEMPOTENT_REPLAYED_HEADER } from '../http/cors.ts';
import { newIdempotencyKey, newSession, type Session } from '../test/client.ts';
import {
  claims,
  drop,
  dropAsClient,
  expectConserved,
  expectError,
  playerStub,
  reload,
  state,
  tableSession,
} from '../test/game.ts';
import {
  judgeSoiree,
  liveSoireeRun,
  recordSoireeCoin,
  rollSoiree,
  rollSoireeRarity,
  SOIREE_REWARD_TX_KIND,
  type FrontFall,
} from './soiree.ts';

const { soireeStart, soireeDraft, soireeFinish } = soireeEndpoints;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const SEATS = soireeSeatCount();

let clock = 0;

beforeEach(() => {
  clock = Math.floor(Date.now() / DAY_MS) * DAY_MS + DAY_MS + 6 * HOUR_MS;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function inPlayer<T>(session: Session, run: (sql: SqlStorage) => T): Promise<T> {
  return runInDurableObject(playerStub(session.tokens.playerId), (_: PlayerDO, ctx) =>
    ctx.storage.transactionSync(() => run(ctx.storage.sql)),
  );
}

function post(
  session: Session,
  path: string,
  body: unknown,
  idempotencyKey: IdempotencyKey = newIdempotencyKey(),
): Promise<Response> {
  return session.call(path, { body, idempotencyKey });
}

async function startOk(session: Session): Promise<SoireeStartResponse> {
  const response = await post(session, soireeStart.path, {});
  expect(response.status, await response.clone().text()).toBe(200);
  return soireeStart.response.parse(await response.json());
}

async function draftOk(
  session: Session,
  body: { runId: string; favorId: string | null },
): Promise<SoireeDraftResponse> {
  const response = await post(session, soireeDraft.path, body);
  expect(response.status, await response.clone().text()).toBe(200);
  return soireeDraft.response.parse(await response.json());
}

async function finishOk(
  session: Session,
  runId: string,
  idempotencyKey: IdempotencyKey = newIdempotencyKey(),
): Promise<SoireeFinishResponse> {
  const response = await post(session, soireeFinish.path, { runId }, idempotencyKey);
  expect(response.status, await response.clone().text()).toBe(200);
  return soireeFinish.response.parse(await response.json());
}

/**
 * Stakes `count` coins of `tier` on the table in play: the live run's own table while one is
 * open, the main table otherwise. The house stakes each coin, as it stakes the opening heap.
 */
async function stage(session: Session, tier: CoinTierId, count: number): Promise<string[]> {
  await tableSession(session);
  const value = coinTiers.find((t) => t.id === tier)?.value;
  if (value === undefined) throw new Error(`No coin tier ${tier}.`);
  return inPlayer(session, (sql) => {
    const run = liveSoireeRun(sql);
    return Array.from({ length: count }, () => {
      const coin = new Entities(sql).mintCoin(tier, value, null, 'table', 0, Date.now());
      if (run !== null) recordSoireeCoin(sql, run.id, coin.id, true);
      commit(sql, new LedgerTx('grant.heap').move('house', 'table', 'coins', value, coin.id), {
        at: Date.now(),
        idempotencyKey: null,
      });
      return coin.id;
    });
  });
}

/** Pushes `count` staged coins of `tier` over an edge through the real claims route now. */
async function pushOff(
  session: Session,
  tier: CoinTierId,
  count: number,
  edge: 'front' | 'left' | 'right' = 'front',
): Promise<void> {
  const ids = await stage(session, tier, count);
  const { results } = await claims(
    session,
    ids.map((coinId) => ({ kind: 'fall', coinId, tick: 0, edge })),
  );
  expect(results.every((r) => r.status === 'accepted')).toBe(true);
}

/** Fulfils `guest` with exactly the falls it asks for, then waits out the interlude. */
async function serve(session: Session, guest: SoireeGuest): Promise<void> {
  await pushOff(session, guest.request.tier, guest.request.count);
  clock += soireeConfig.interludeMs;
}

function guestAt(run: SoireeStartResponse, order: number): SoireeGuest {
  const guest = run.guests[order - 1];
  if (guest === undefined) throw new Error(`The run seats no guest ${order}.`);
  return guest;
}

function soireeLegs(session: Session) {
  return inPlayer(session, (sql) =>
    sql
      .exec<{ tx_id: string; account: string; unit: string; delta: number; ref: string | null }>(
        'SELECT tx_id, account, unit, delta, ref FROM ledger WHERE kind = ? ORDER BY seq',
        SOIREE_REWARD_TX_KIND,
      )
      .toArray(),
  );
}

describe('POST /v1/soiree/start', () => {
  it('returns the table seed, an act-ordered seat plan and the first draft on the server clock', async () => {
    const session = await newSession();
    const run = await startOk(session);

    expect(run.startedAt).toBe(clock);
    expect(run.durationMs).toBe(soireeConfig.durationMs);
    expect(run.interludeMs).toBe(soireeConfig.interludeMs);
    expect(run.guests).toHaveLength(SEATS);
    const acts = run.guests.map((g) => soireeConfig.guests.find((d) => d.id === g.id)?.act);
    expect(acts).toEqual([...acts].sort((a, b) => (a ?? 0) - (b ?? 0)));
    for (const guest of run.guests) {
      const def = soireeConfig.guests.find((d) => d.id === guest.id);
      expect(guest.request).toEqual(def?.request);
      expect(guest.favors).toBe(def?.favors);
    }
    for (const favor of run.offered) {
      expect(soireeConfig.favors).toContainEqual(favor);
    }
    await expectConserved(session);
  });

  it('refuses any client-chosen field: the seed, clock and seat plan are the server’s', async () => {
    const session = await newSession();
    for (const body of [{ seed: 7 }, { startedAt: 0 }, { guests: [] }, { rewarded: true }]) {
      await expectError(await post(session, soireeStart.path, body), 400, 'validation_failed');
    }
    const open = await inPlayer(
      session,
      (sql) => sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM soiree_runs').one().n,
    );
    expect(open).toBe(0);
  });

  it('replays a start under the same key instead of rolling a second run', async () => {
    const session = await newSession();
    const key = newIdempotencyKey();
    const first = await post(session, soireeStart.path, {}, key);
    const again = await post(session, soireeStart.path, {}, key);
    expect(again.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('true');
    expect(await again.json()).toEqual(await first.json());
  });

  it('refuses a second run while one is open, with the time it has left', async () => {
    const session = await newSession();
    const run = await startOk(session);
    clock += 60_000;
    const response = await post(session, soireeStart.path, {});
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'conflict', retryAfterMs: run.startedAt + run.durationMs - clock },
    });
  });

  it('lets exactly one of two concurrent starts through', async () => {
    const session = await newSession();
    const responses = await Promise.all([
      post(session, soireeStart.path, {}),
      post(session, soireeStart.path, {}),
      post(session, soireeStart.path, {}),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    const runs = await inPlayer(
      session,
      (sql) => sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM soiree_runs').one().n,
    );
    expect(runs).toBe(1);
  });

  it('settles a run that ran out unfinished before starting the next', async () => {
    const session = await newSession();
    const first = await startOk(session);
    await serve(session, guestAt(first, 1));
    clock = first.startedAt + first.durationMs;
    const second = await startOk(session);
    expect(second.runId).not.toBe(first.runId);

    const settled = await finishOk(session, first.runId);
    expect(settled.guestsServed).toBe(1);
    expect(settled.rewards).toHaveLength(soireeReward(1).crates);
    await expectConserved(session);
  });

  it('rolls a table seed, seat plan and drafts that differ between runs', async () => {
    const session = await newSession();
    const first = await startOk(session);
    clock += soireeConfig.durationMs;
    await finishOk(session, first.runId);
    const second = await startOk(session);
    expect(second.proof.nonce).not.toBe(first.proof.nonce);
    expect([second.seed, second.guests, second.offered]).not.toEqual([
      first.seed,
      first.guests,
      first.offered,
    ]);
  });
});

describe('guest judging from accepted claims', () => {
  it('fulfils a guest from front falls of the requested tier inside the window', async () => {
    const session = await newSession();
    const run = await startOk(session);
    const guest = guestAt(run, 1);
    await pushOff(session, guest.request.tier, guest.request.count - 1);
    await expectError(
      await post(session, soireeDraft.path, { runId: run.runId, favorId: null }),
      409,
      'not_ready',
    );
    await pushOff(session, guest.request.tier, 1);
    const draft = await draftOk(session, { runId: run.runId, favorId: null });
    expect(draft).toMatchObject({ draft: 1, picked: null, favorsLeft: guest.favors });

    clock = run.startedAt + run.durationMs;
    const finished = await finishOk(session, run.runId);
    expect(finished.results[0]).toEqual({
      guestId: guest.id,
      fulfilled: true,
      progress: guest.request.count,
    });
  });

  it('fails a guest whose window closes short, counting only what fell inside it', async () => {
    const session = await newSession();
    const run = await startOk(session);
    const guest = guestAt(run, 1);
    await pushOff(session, guest.request.tier, guest.request.count - 1);
    clock = run.startedAt + guest.request.windowMs;
    await pushOff(session, guest.request.tier, 5);

    const draft = await draftOk(session, { runId: run.runId, favorId: null });
    expect(draft).toMatchObject({ draft: 1, favorsLeft: 0 });
    clock = run.startedAt + run.durationMs;
    const finished = await finishOk(session, run.runId);
    expect(finished.results[0]).toEqual({
      guestId: guest.id,
      fulfilled: false,
      progress: guest.request.count - 1,
    });
    expect(finished.guestsServed).toBe(0);
    expect(finished.rewards).toEqual([]);
  });

  it('ignores side falls, other tiers and falls from before the run', async () => {
    const session = await newSession();
    for (const { id } of coinTiers.slice(0, 4)) await pushOff(session, id, 20);
    clock += 1;
    const run = await startOk(session);
    const guest = guestAt(run, 1);
    const other = coinTiers.find((t) => t.id !== guest.request.tier)?.id;
    if (other === undefined) throw new Error('Only one coin tier is configured.');
    await pushOff(session, guest.request.tier, guest.request.count, 'left');
    await pushOff(session, other, guest.request.count);

    clock = run.startedAt + run.durationMs;
    const finished = await finishOk(session, run.runId);
    expect(finished.results[0]).toEqual({ guestId: guest.id, fulfilled: false, progress: 0 });
    await expectConserved(session);
  });

  it('counts nothing for same-tier coins staged on the main table before the run', async () => {
    const session = await newSession();
    const staged = new Map<string, string[]>();
    for (const { id } of coinTiers.slice(0, 5)) staged.set(id, await stage(session, id, 30));
    clock += 1;
    const run = await startOk(session);
    const guest = guestAt(run, 1);
    const sameTier = staged.get(guest.request.tier) ?? [];
    const ids = sameTier.slice(0, guest.request.count);
    expect(ids).toHaveLength(guest.request.count);

    const { results } = await claims(
      session,
      ids.map((coinId) => ({ kind: 'fall', coinId, tick: 0, edge: 'front' })),
    );
    expect(results).toEqual(ids.map(() => ({ status: 'rejected', reason: 'not_on_table' })));
    const fused = await claims(session, [{ kind: 'fusion', coinIds: sameTier.slice(-3), tick: 0 }]);
    expect(fused.results).toEqual([{ status: 'rejected', reason: 'not_on_table' }]);

    clock = run.startedAt + run.durationMs;
    const finished = await finishOk(session, run.runId);
    expect(finished.results[0]).toEqual({ guestId: guest.id, fulfilled: false, progress: 0 });
    const left = await inPlayer(
      session,
      (sql) =>
        sql
          .exec<{ n: number }>(
            `SELECT COUNT(*) AS n FROM coins WHERE state = 'table' AND id IN (${ids.map(() => '?').join(',')})`,
            ...ids,
          )
          .one().n,
    );
    expect(left).toBe(ids.length);
    await expectConserved(session);
  });

  it('counts nothing for a claim the client sends under a superseded table session', async () => {
    const session = await newSession();
    const run = await startOk(session);
    const guest = guestAt(run, 1);
    const stale = await tableSession(session);
    await reload(session);
    const value = coinTiers.find((t) => t.id === guest.request.tier)?.value ?? 0;
    const coinId = await inPlayer(session, (sql) => {
      const coin = new Entities(sql).mintCoin(guest.request.tier, value, null, 'table', 0, clock);
      commit(sql, new LedgerTx('grant.heap').move('house', 'table', 'coins', value, coin.id), {
        at: clock,
        idempotencyKey: null,
      });
      return coin.id;
    });
    await expectError(
      await session.call(endpoints.tableClaims.path, {
        body: { session: stale, claims: [{ kind: 'fall', coinId, tick: 0, edge: 'front' }] },
      }),
      409,
      'session_superseded',
    );
    clock = run.startedAt + run.durationMs;
    const finished = await finishOk(session, run.runId);
    expect(finished.results[0]).toMatchObject({ fulfilled: false, progress: 0 });
  });

  it('keeps a guest’s window shut through the interlude and spends each fall once', async () => {
    const session = await newSession();
    const run = await startOk(session);
    const first = guestAt(run, 1);
    const second = guestAt(run, 2);
    await pushOff(session, first.request.tier, first.request.count);
    await pushOff(session, second.request.tier, second.request.count);
    clock += soireeConfig.interludeMs - 1;
    await pushOff(session, second.request.tier, second.request.count);

    clock = run.startedAt + run.durationMs;
    const finished = await finishOk(session, run.runId);
    expect(finished.results.slice(0, 2)).toEqual([
      { guestId: first.id, fulfilled: true, progress: first.request.count },
      { guestId: second.id, fulfilled: false, progress: 0 },
    ]);
  });

  it('judges every guest in turn and closes the last window at the end of the run', () => {
    const run = rollSoiree(createRng(11));
    const startedAt = 1_000_000;
    const endsAt = startedAt + soireeConfig.durationMs;
    const [g1, g2] = run.guests;
    if (g1 === undefined || g2 === undefined) throw new Error('rollSoiree seated nobody.');
    const falls: FrontFall[] = [
      ...Array.from({ length: g1.request.count }, (_, i) => ({
        tier: g1.request.tier,
        at: startedAt + i,
      })),
    ];
    const opensSecond = startedAt + g1.request.count - 1 + soireeConfig.interludeMs;
    const verdicts = judgeSoiree(
      { guests: run.guests, startedAt, endsAt, interludeMs: soireeConfig.interludeMs },
      falls,
      endsAt,
    );
    expect(verdicts[0]).toMatchObject({
      status: 'fulfilled',
      resolvedAt: opensSecond - soireeConfig.interludeMs,
    });
    expect(verdicts[1]).toMatchObject({
      status: 'failed',
      opensAt: opensSecond,
      resolvedAt: opensSecond + g2.request.windowMs,
    });
    expect(verdicts.every((v) => v.status === 'fulfilled' || v.status === 'failed')).toBe(true);
    const last = verdicts.at(-1);
    expect(last?.resolvedAt).toBeLessThanOrEqual(endsAt);

    const midRun = judgeSoiree(
      { guests: run.guests, startedAt, endsAt, interludeMs: soireeConfig.interludeMs },
      falls,
      opensSecond - 1,
    );
    expect(midRun.map((v) => v.status).slice(0, 3)).toEqual(['fulfilled', 'waiting', 'waiting']);
  });
});

describe('POST /v1/soiree/draft', () => {
  async function servedFirst(session: Session) {
    const run = await startOk(session);
    await pushOff(session, guestAt(run, 1).request.tier, guestAt(run, 1).request.count);
    return run;
  }

  it('drafts one of the offered perks, paid from the Favors the server counted', async () => {
    const session = await newSession();
    const run = await servedFirst(session);
    const cheap = run.offered.find((f) => f.cost <= guestAt(run, 1).favors);
    const draft = await draftOk(session, { runId: run.runId, favorId: cheap?.id ?? null });
    if (cheap === undefined) {
      expect(draft.picked).toBeNull();
      return;
    }
    expect(draft.picked).toEqual({
      id: cheap.id,
      startsAt: clock,
      endsAt: Math.min(clock + cheap.durationMs, run.startedAt + run.durationMs),
    });
    expect(draft.favorsLeft).toBe(guestAt(run, 1).favors - cheap.cost);
    expect(draft.offered).toHaveLength(soireeConfig.draftSize);
    await expectConserved(session);
  });

  it('refuses a favor the server did not offer for this draft', async () => {
    const session = await newSession();
    const run = await servedFirst(session);
    const offered = new Set<string>(run.offered.map((f) => f.id));
    const unoffered = soireeConfig.favors.find((f) => !offered.has(f.id));
    if (unoffered === undefined) throw new Error('Every favor is on offer.');
    await expectError(
      await post(session, soireeDraft.path, { runId: run.runId, favorId: unoffered.id }),
      400,
      'bad_request',
    );
    await expectError(
      await post(session, soireeDraft.path, { runId: run.runId, favorId: 'freeMoney' }),
      400,
      'bad_request',
    );
    await expectError(
      await post(session, soireeDraft.path, { runId: run.runId, favorId: 'not a favor!' }),
      400,
      'validation_failed',
    );
    const passed = await draftOk(session, { runId: run.runId, favorId: null });
    expect(passed.draft).toBe(1);
  });

  it('refuses a perk the counted Favors cannot pay for', async () => {
    const session = await newSession();
    const run = await startOk(session);
    const guest = guestAt(run, 1);
    clock = run.startedAt + guest.request.windowMs;
    const priciest = [...run.offered].sort((a, b) => b.cost - a.cost)[0];
    if (priciest === undefined) throw new Error('The draft is empty.');
    await expectError(
      await post(session, soireeDraft.path, { runId: run.runId, favorId: priciest.id }),
      409,
      'insufficient_funds',
    );
  });

  it('allows one pick per draft and closes it when the next guest arrives', async () => {
    const session = await newSession();
    const run = await servedFirst(session);
    await draftOk(session, { runId: run.runId, favorId: null });
    await expectError(
      await post(session, soireeDraft.path, { runId: run.runId, favorId: null }),
      409,
      'conflict',
    );

    const late = await newSession();
    const other = await servedFirst(late);
    clock += soireeConfig.interludeMs;
    await expectError(
      await post(late, soireeDraft.path, { runId: other.runId, favorId: null }),
      409,
      'conflict',
    );
  });

  it('replays a draft under the same key without spending twice', async () => {
    const session = await newSession();
    const run = await servedFirst(session);
    const key = newIdempotencyKey();
    const body = { runId: run.runId, favorId: null };
    const first = await post(session, soireeDraft.path, body, key);
    const again = await post(session, soireeDraft.path, body, key);
    expect(again.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('true');
    expect(await again.json()).toEqual(await first.json());
    await expectError(
      await post(session, soireeDraft.path, { ...body, favorId: run.offered[0]?.id }, key),
      422,
      'idempotency_key_reused',
    );
  });

  it('refuses stale, forged and foreign run IDs', async () => {
    const session = await newSession();
    const run = await servedFirst(session);
    const stranger = await newSession();
    const theirs = await startOk(stranger);

    await expectError(
      await post(session, soireeDraft.path, { runId: theirs.runId, favorId: null }),
      404,
      'not_found',
    );
    await expectError(
      await post(session, soireeDraft.path, {
        runId: 'soiree_AAAAAAAAAAAAAAAAAAAA',
        favorId: null,
      }),
      404,
      'not_found',
    );
    for (const runId of ['crate_AAAAAAAAAAAAAAAAAAAA', 'soiree_', "soiree_x' OR 1=1 --", 7]) {
      await expectError(
        await post(session, soireeDraft.path, { runId, favorId: null }),
        400,
        'validation_failed',
      );
    }

    clock = run.startedAt + run.durationMs;
    await expectError(
      await post(session, soireeDraft.path, { runId: run.runId, favorId: null }),
      409,
      'conflict',
    );
    await finishOk(session, run.runId);
    const next = await startOk(session);
    await pushOff(session, guestAt(next, 1).request.tier, guestAt(next, 1).request.count);
    await expectError(
      await post(session, soireeDraft.path, { runId: run.runId, favorId: null }),
      409,
      'conflict',
    );
  });
});

describe('POST /v1/soiree/finish', () => {
  it('pays the economy table for the guests served, once, through the ledger', async () => {
    const session = await newSession();
    const before = await inPlayer(session, readWallet);
    const run = await startOk(session);
    const served = 3;
    for (let order = 1; order <= served; order++) await serve(session, guestAt(run, order));
    await expectError(
      await post(session, soireeFinish.path, { runId: run.runId }),
      409,
      'not_ready',
    );

    clock = run.startedAt + run.durationMs;
    const key = newIdempotencyKey();
    const finished = await finishOk(session, run.runId, key);
    const tier = soireeReward(served);
    expect(finished.guestsServed).toBe(served);
    expect(finished.results.map((r) => r.fulfilled)).toEqual(run.guests.map((_, i) => i < served));
    expect(finished.favorsEarned).toBe(
      run.guests.slice(0, served).reduce((sum, g) => sum + g.favors, 0),
    );
    const crates = finished.rewards.filter((r) => r.kind === 'crate');
    expect(crates).toHaveLength(tier.crates + tier.perfectCrates);
    expect(finished.rewards.filter((r) => r.kind === 'currency')).toEqual(
      tier.keys > 0 ? [{ kind: 'currency', currency: 'keys', amount: tier.keys }] : [],
    );
    expect(finished.wallet.keys - before.keys).toBe(tier.keys);

    const legs = await soireeLegs(session);
    expect(new Set(legs.map((l) => l.tx_id)).size).toBe(1);
    expect(legs.map(({ account, unit, delta, ref }) => ({ account, unit, delta, ref }))).toEqual([
      ...crates.flatMap((c) => [
        { account: 'mint', unit: 'crate', delta: -1, ref: c.crateId },
        { account: 'inventory', unit: 'crate', delta: 1, ref: c.crateId },
      ]),
      ...(tier.keys > 0
        ? [
            { account: 'mint', unit: 'keys', delta: -tier.keys, ref: run.runId },
            { account: 'wallet', unit: 'keys', delta: tier.keys, ref: run.runId },
          ]
        : []),
    ]);

    const replay = await post(session, soireeFinish.path, { runId: run.runId }, key);
    expect(replay.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('true');
    const repeat = await finishOk(session, run.runId);
    expect(repeat).toEqual(finished);
    expect(await soireeLegs(session)).toHaveLength(legs.length);
    await expectConserved(session);
  });

  it('pays the perfect crate for a full house, at once when the last guest is served', async () => {
    const session = await newSession();
    const run = await startOk(session);
    for (const guest of run.guests) await serve(session, guest);
    const finished = await finishOk(session, run.runId);
    const tier = soireeReward(SEATS);
    expect(finished.guestsServed).toBe(SEATS);
    const crates = finished.rewards.filter((r) => r.kind === 'crate');
    expect(crates).toHaveLength(tier.crates + tier.perfectCrates);
    const perfect = crates.slice(tier.crates);
    for (const crate of perfect) {
      expect(soireeConfig.perfectCrateOdds[crate.rarity]).toBeGreaterThan(0);
    }
    const stamped = await inPlayer(session, (sql) =>
      sql
        .exec<{ crate_id: string; rarity: string }>(
          'SELECT crate_id, rarity FROM soiree_crates ORDER BY rowid',
        )
        .toArray(),
    );
    expect(stamped).toEqual(crates.map((c) => ({ crate_id: c.crateId, rarity: c.rarity })));
    await expectConserved(session);
  });

  it('pays only the day’s rewarded runs', async () => {
    const session = await newSession();
    for (let n = 0; n < soireeConfig.rewardedRunsPerDay; n++) {
      const run = await startOk(session);
      await serve(session, guestAt(run, 1));
      clock = run.startedAt + run.durationMs;
      expect((await finishOk(session, run.runId)).rewards.length).toBeGreaterThan(0);
    }
    const unpaid = await startOk(session);
    for (const guest of unpaid.guests) await serve(session, guest);
    const finished = await finishOk(session, unpaid.runId);
    expect(finished.guestsServed).toBe(SEATS);
    expect(finished.rewards).toEqual([]);
    await expectConserved(session);
  });

  it('opens a Soirée crate once, at the rarity it was paid at, leaving the vault pity alone', async () => {
    const session = await newSession();
    const run = await startOk(session);
    for (const guest of run.guests) await serve(session, guest);
    const finished = await finishOk(session, run.runId);
    const paid = finished.rewards.flatMap((r) => (r.kind === 'crate' ? [r] : []));
    expect(paid.length).toBeGreaterThan(0);
    const pityBefore = await inPlayer(session, (sql) =>
      sql.exec('SELECT * FROM pity_counters ORDER BY source, rarity').toArray(),
    );

    for (const crate of paid) {
      const key = newIdempotencyKey();
      const response = await post(
        session,
        endpoints.cratesOpen.path,
        { crateId: crate.crateId },
        key,
      );
      expect(response.status, await response.clone().text()).toBe(200);
      const opened = endpoints.cratesOpen.response.parse(await response.json());
      expect(opened.roll.rarity).toBe(crate.rarity);
      const reward = crateRewards[crate.rarity];
      for (const currency of ['pearls', 'keys', 'tickets'] as const) {
        const amount = opened.roll.rewards.find(
          (r) => r.kind === 'currency' && r.currency === currency,
        );
        expect(amount?.kind === 'currency' ? amount.amount : 0).toBe(reward[currency]);
      }
      const replay = await post(
        session,
        endpoints.cratesOpen.path,
        { crateId: crate.crateId },
        key,
      );
      expect(replay.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('true');
      await expectError(
        await post(session, endpoints.cratesOpen.path, { crateId: crate.crateId }),
        409,
        'conflict',
      );
    }
    const pityAfter = await inPlayer(session, (sql) =>
      sql.exec('SELECT * FROM pity_counters ORDER BY source, rarity').toArray(),
    );
    expect(pityAfter).toEqual(pityBefore);
    const held = await inPlayer(
      session,
      (sql) =>
        sql
          .exec<{ n: number }>(
            "SELECT COALESCE(SUM(delta), 0) AS n FROM ledger WHERE account = 'inventory' AND unit = 'crate'",
          )
          .one().n,
    );
    expect(held).toBe(0);
    await expectConserved(session);
  });

  it('refuses an unknown run and a body with client-chosen results', async () => {
    const session = await newSession();
    await expectError(
      await post(session, soireeFinish.path, { runId: 'soiree_BBBBBBBBBBBBBBBBBBBB' }),
      404,
      'not_found',
    );
    const run = await startOk(session);
    for (const extra of [{ guestsServed: 6 }, { results: [] }, { rewards: [] }, { at: 0 }]) {
      await expectError(
        await post(session, soireeFinish.path, { runId: run.runId, ...extra }),
        400,
        'validation_failed',
      );
    }
  });

  it('pays a run once however many finishes race for it', async () => {
    const session = await newSession();
    const run = await startOk(session);
    await serve(session, guestAt(run, 1));
    clock = run.startedAt + run.durationMs;
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => post(session, soireeFinish.path, { runId: run.runId })),
    );
    const bodies = await Promise.all(responses.map((r) => r.json()));
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    for (const body of bodies) expect(body).toEqual(bodies[0]);
    expect(new Set((await soireeLegs(session)).map((l) => l.tx_id)).size).toBe(1);
    await expectConserved(session);
  });
});

describe('Soirée rolls', () => {
  it('replays the seat plan and drafts from the fair stream', () => {
    const a = rollSoiree(createRng(42));
    expect(rollSoiree(createRng(42))).toEqual(a);
    expect(a.guests).toHaveLength(SEATS);
    expect(a.offers).toHaveLength(SEATS - 1);
    for (const offer of a.offers) {
      expect(new Set(offer.map((f) => f.id)).size).toBe(soireeConfig.draftSize);
    }
  });

  it('never rolls a rarity its odds table weighs at zero', () => {
    const rng = createRng(7);
    const seen = new Set<string>();
    for (let i = 0; i < 2_000; i++) seen.add(rollSoireeRarity(soireeConfig.perfectCrateOdds, rng));
    for (const rarity of RARITY_IDS) {
      expect(seen.has(rarity)).toBe(soireeConfig.perfectCrateOdds[rarity] > 0);
    }
    expect(oddsTotal(soireeConfig.crateOdds)).toBeGreaterThan(0);
  });
});

describe('the run’s own table', () => {
  function mainTable(session: Session) {
    return inPlayer(session, (sql) => ({
      snapshot: sql.exec('SELECT * FROM table_snapshot').toArray(),
      coins: sql
        .exec<{ id: string }>(
          "SELECT id FROM coins WHERE state = 'table' AND id NOT IN (SELECT coin_id FROM soiree_coins) ORDER BY rowid",
        )
        .toArray()
        .map((row) => row.id),
    }));
  }

  it('starts its own session on a heap the house stakes from the run, which pays no coins', async () => {
    const session = await newSession();
    const before = await reload(session);
    await startOk(session);
    const during = await state(session);

    expect(during.table.session).not.toBe(before.table.session);
    await expectError(
      await session.call(endpoints.tableDrop.path, {
        body: { session: before.table.session, x: 0, tick: 0 },
      }),
      409,
      'session_superseded',
    );
    expect(during.table.coins).toHaveLength(openingHeap.coins);
    expect(during.table.coins.every((c) => c.tier === openingHeap.tier)).toBe(true);
    const mainIds = new Set(before.table.coins.map((c) => c.id));
    expect(during.table.coins.some((c) => mainIds.has(c.id))).toBe(false);

    const booted = await reload(session);
    expect(booted.table.layout?.coins).toEqual(
      Array.from({ length: openingHeap.coins }, (_, slot) => ({ kind: 'heapSlot', slot })),
    );
    const heapCoin = booted.table.coins[0];
    if (heapCoin === undefined) throw new Error('The run table has no heap.');
    const { results, wallet } = await claims(session, [
      { kind: 'fall', coinId: heapCoin.id, tick: 0, edge: 'front' },
    ]);
    expect(results).toEqual([{ status: 'accepted', credited: 0, cascade: null, minted: null }]);
    expect(wallet.coins).toBe(booted.wallet.coins);
    await expectConserved(session);
  });

  it('settles its coins to the house and puts the main table back when the run finishes', async () => {
    const session = await newSession();
    await reload(session);
    const main = await mainTable(session);
    const run = await startOk(session);
    const runSession = await tableSession(session);
    const [dropped] = await dropAsClient(session, 1);
    if (dropped === undefined) throw new Error('No drop was made.');
    const walletBefore = (await state(session)).wallet.coins;

    clock = run.startedAt + run.durationMs;
    await finishOk(session, run.runId);
    expect(await tableSession(session)).not.toBe(runSession);
    expect(await mainTable(session)).toEqual(main);
    const settled = await inPlayer(session, (sql) =>
      sql
        .exec<{ state: string; n: number }>(
          `SELECT coins.state AS state, COUNT(*) AS n FROM soiree_coins
           JOIN coins ON coins.id = soiree_coins.coin_id GROUP BY coins.state`,
        )
        .toArray(),
    );
    expect(settled).toEqual([{ state: 'refunded', n: openingHeap.coins + 1 }]);
    const after = await state(session);
    expect(after.table.coins.map((c) => c.id)).toEqual(main.coins);
    expect(after.wallet.coins).toBe(walletBefore + 1);
    await expectConserved(session);
  });

  it('keeps the run table through a boot mid-run and closes it on a boot after the end', async () => {
    const session = await newSession();
    const main = (await reload(session)).table.coins.map((c) => c.id);
    const run = await startOk(session);
    const midRun = await reload(session);
    expect(midRun.table.coins.map((c) => c.id)).not.toEqual(main);
    expect(midRun.table.coins).toHaveLength(openingHeap.coins);

    clock = run.startedAt + run.durationMs;
    const afterEnd = await reload(session);
    expect(afterEnd.table.coins.map((c) => c.id)).toEqual(main);
    const finished = await finishOk(session, run.runId);
    expect(finished.guestsServed).toBe(0);
    await expectConserved(session);
  });
});

describe('drafted perks', () => {
  function favor(id: string): SoireeFavorDef {
    const def = soireeConfig.favors.find((f) => f.id === id);
    if (def === undefined) throw new Error(`No Soirée favor ${id}.`);
    return def;
  }

  function grantPerk(
    session: Session,
    perk: SoireeFavorDef,
    startsAt: number,
    endsAt = startsAt + perk.durationMs,
  ) {
    return inPlayer(session, (sql) => {
      sql.exec(
        'UPDATE soiree_runs SET perk_id = ?, perk_starts_at = ?, perk_ends_at = ? WHERE finished_at IS NULL',
        perk.id,
        startsAt,
        endsAt,
      );
    });
  }

  function mintMicros(session: Session, coinId: string) {
    return inPlayer(
      session,
      (sql) =>
        sql.exec<{ m: number }>('SELECT mint_micros AS m FROM coins WHERE id = ?', coinId).one().m,
    );
  }

  it('raises the minted value of drops only inside the champagne tower’s window', async () => {
    const session = await newSession();
    const tower = favor('champagneTower');
    expect(tower.stat).toBe('coinValue');
    const run = await startOk(session);
    const base = await mintMicros(session, (await drop(session)).coin.id);
    await grantPerk(session, tower, clock + 1_000);

    expect(await mintMicros(session, (await drop(session)).coin.id)).toBe(base);
    clock += 1_000;
    const boosted = Math.floor((base * (10_000 + tower.magnitudeBp)) / 10_000);
    expect(await mintMicros(session, (await drop(session)).coin.id)).toBe(boosted);
    const [reserved] = await dropAsClient(session, 1);
    if (reserved === undefined) throw new Error('No drop was made.');
    expect(await mintMicros(session, reserved.coin.id)).toBe(boosted);
    await expectConserved(session);

    clock += tower.durationMs;
    expect(await mintMicros(session, (await drop(session)).coin.id)).toBe(base);
    clock = run.startedAt + run.durationMs;
    await finishOk(session, run.runId);
    await expectConserved(session);
  });

  /**
   * Sets the net drop count, so the next drop is drop `count + 1`, and the high-water mark a
   * drop must lift to reach a new spawn index.
   */
  function setDropCount(session: Session, count: number, highWater = count) {
    return inPlayer(session, (sql) => {
      sql.exec("UPDATE meta SET value = ? WHERE key = 'drop_count'", String(count));
      sql.exec("UPDATE meta SET value = ? WHERE key = 'drop_high_water'", String(highWater));
    });
  }

  it('spawns Vault Crates closer together only inside the midnight buffet’s window', async () => {
    const buffet = favor('midnightBuffet');
    expect(buffet.stat).toBe('crateChance');
    const base = crateSpawnInterval({});
    const boosted = crateSpawnInterval({}, NEUTRAL_MULTIPLIER_BP + buffet.magnitudeBp);
    expect(boosted).toBeLessThan(base);
    expect(base % boosted).not.toBe(0);

    const session = await newSession();
    const run = await startOk(session);
    await setDropCount(session, boosted - 1);
    expect((await drop(session)).spawnedCrates).toEqual([]);

    await grantPerk(session, buffet, clock);
    await setDropCount(session, 2 * boosted - 1);
    const spawned = await drop(session);
    expect(spawned.spawnedCrates).toHaveLength(1);
    expect(spawned.spawnedCrates[0]?.kind).toBe('vault');
    const minted = await inPlayer(session, (sql) =>
      sql
        .exec<{ account: string; delta: number }>(
          "SELECT account, delta FROM ledger WHERE kind = 'crate.spawn' AND ref = ? ORDER BY seq",
          spawned.spawnedCrates[0]?.id ?? '',
        )
        .toArray(),
    );
    expect(minted).toEqual([
      { account: 'mint', delta: -1 },
      { account: 'table', delta: 1 },
    ]);
    await expectConserved(session);

    await setDropCount(session, 2 * boosted - 1, 2 * boosted);
    expect((await drop(session)).spawnedCrates).toEqual([]);
    await expectConserved(session);

    clock += buffet.durationMs;
    await setDropCount(session, 3 * boosted - 1);
    expect((await drop(session)).spawnedCrates).toEqual([]);
    clock = run.startedAt + run.durationMs;
    await finishOk(session, run.runId);
    await expectConserved(session);
  });

  it('closes drafts on a run past the day’s rewarded limit, and a forced perk lifts nothing', async () => {
    const session = await newSession();
    for (let n = 0; n < soireeConfig.rewardedRunsPerDay; n++) {
      const paid = await startOk(session);
      for (const guest of paid.guests) await serve(session, guest);
      expect((await finishOk(session, paid.runId)).rewards.length).toBeGreaterThan(0);
    }
    const unpaid = await startOk(session);
    const baseMicros = await mintMicros(session, (await drop(session)).coin.id);
    await pushOff(session, guestAt(unpaid, 1).request.tier, guestAt(unpaid, 1).request.count);
    for (const favorId of [...unpaid.offered.map((f) => f.id), null]) {
      await expectError(
        await post(session, soireeDraft.path, { runId: unpaid.runId, favorId }),
        409,
        'conflict',
      );
    }

    await grantPerk(session, favor('goldLeaf'), clock);
    expect(await mintMicros(session, (await drop(session)).coin.id)).toBe(baseMicros);
    const buffet = favor('midnightBuffet');
    await grantPerk(session, buffet, clock);
    await setDropCount(
      session,
      2 * crateSpawnInterval({}, NEUTRAL_MULTIPLIER_BP + buffet.magnitudeBp) - 1,
    );
    expect((await drop(session)).spawnedCrates).toEqual([]);
    await expectConserved(session);

    clock = unpaid.startedAt + unpaid.durationMs;
    expect((await finishOk(session, unpaid.runId)).rewards).toEqual([]);
    await expectConserved(session);
  });

  it('ends with the run table: a perk never lifts the main table', async () => {
    const session = await newSession();
    const run = await startOk(session);
    const base = await mintMicros(session, (await drop(session)).coin.id);
    clock = run.startedAt + run.durationMs;
    await grantPerk(session, favor('goldLeaf'), run.startedAt, clock + HOUR_MS);
    await finishOk(session, run.runId);
    await reload(session);
    expect(await mintMicros(session, (await drop(session)).coin.id)).toBe(base);
    await expectConserved(session);
  });
});
