import {
  drawSoireeOffer,
  oddsTotal,
  seatSoireeGuests,
  soireeConfig,
  soireeReward,
  soireeRunEndsAt,
  spendSoireeFavors,
  type OddsTable,
  type RarityId,
  type Rng,
  type SoireeFavorDef,
  type SoireeGuestDef,
  type SoireeRewardTier,
} from '@coinposh/economy';
import {
  ENTITY_ID_PREFIXES,
  FairProofSchema,
  RARITY_IDS,
  RaritySchema,
  soireeEndpoints,
  SoireeFavorSchema,
  SoireeGuestResultSchema,
  SoireeGuestSchema,
  SoireeRewardSchema,
  SoireeRunIdSchema,
  type CrateId,
  type FairProof,
  type PlayerId,
  type SoireeActiveFavor,
  type SoireeDraftRequest,
  type SoireeDraftResponse,
  type SoireeFavor,
  type SoireeFinishRequest,
  type SoireeFinishResponse,
  type SoireeGuest,
  type SoireeGuestResult,
  type SoireeReward,
  type SoireeRunId,
  type SoireeStartRequest,
  type SoireeStartResponse,
} from '@coinposh/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { randomBase62 } from '../crypto.ts';
import { Entities } from '../do/entities.ts';
import { commit, LedgerTx, type CommitContext, type TxKind } from '../do/ledger.ts';
import type { Command, DoResult } from '../do/PlayerDO.ts';
import type { Env } from '../env.ts';
import type { AppEnv } from '../http/context.ts';
import { ApiFailure } from '../http/errors.ts';
import {
  authenticate,
  fingerprint,
  parseBody,
  requireIdempotencyKey,
  respond,
} from '../http/signed.ts';
import type { FairSeeds } from '../rng/fair.ts';

/**
 * PlayerDO tables for Soirée Nights (T-3.06). A run's seat plan, table seed, drafts and proof are
 * frozen when it starts; afterwards only the draft bookkeeping moves forward, and a finished run
 * is final. The partial unique index keeps one run open per player even if every other check
 * were bypassed. `soiree_crates` stamps the rarity each paid crate was rolled at.
 */
export const SOIREE_SQL = `
  CREATE TABLE IF NOT EXISTS soiree_runs (
    id             TEXT PRIMARY KEY,
    seed           INTEGER NOT NULL CHECK (seed BETWEEN 0 AND 4294967295),
    started_at     INTEGER NOT NULL CHECK (started_at >= 0),
    ends_at        INTEGER NOT NULL CHECK (ends_at > started_at),
    interlude_ms   INTEGER NOT NULL CHECK (interlude_ms >= 0),
    rewarded       INTEGER NOT NULL CHECK (rewarded IN (0, 1)),
    guests         TEXT NOT NULL,
    offers         TEXT NOT NULL,
    proof          TEXT NOT NULL,
    last_draft     INTEGER NOT NULL DEFAULT 0 CHECK (last_draft >= 0),
    favors_spent   INTEGER NOT NULL DEFAULT 0 CHECK (favors_spent >= 0),
    perk_id        TEXT,
    perk_starts_at INTEGER,
    perk_ends_at   INTEGER,
    finished_at    INTEGER,
    result         TEXT,
    CHECK ((finished_at IS NULL) = (result IS NULL)),
    CHECK ((perk_id IS NULL) = (perk_starts_at IS NULL) AND (perk_id IS NULL) = (perk_ends_at IS NULL))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS soiree_runs_one_open
    ON soiree_runs ((finished_at IS NULL)) WHERE finished_at IS NULL;
  CREATE INDEX IF NOT EXISTS soiree_runs_started ON soiree_runs (started_at);

  CREATE TRIGGER IF NOT EXISTS soiree_runs_commitment_fixed BEFORE UPDATE ON soiree_runs
  WHEN NEW.id IS NOT OLD.id
    OR NEW.seed IS NOT OLD.seed
    OR NEW.started_at IS NOT OLD.started_at
    OR NEW.ends_at IS NOT OLD.ends_at
    OR NEW.interlude_ms IS NOT OLD.interlude_ms
    OR NEW.rewarded IS NOT OLD.rewarded
    OR NEW.guests IS NOT OLD.guests
    OR NEW.offers IS NOT OLD.offers
    OR NEW.proof IS NOT OLD.proof
    OR NEW.last_draft < OLD.last_draft
    OR NEW.favors_spent < OLD.favors_spent
    OR OLD.finished_at IS NOT NULL
  BEGIN
    SELECT RAISE(ABORT, 'a Soirée run is committed when it starts and final once finished');
  END;

  CREATE TRIGGER IF NOT EXISTS soiree_runs_no_delete BEFORE DELETE ON soiree_runs
  BEGIN
    SELECT RAISE(ABORT, 'soiree_runs is append-only');
  END;

  CREATE TABLE IF NOT EXISTS soiree_crates (
    crate_id TEXT PRIMARY KEY REFERENCES crates (id),
    run_id   TEXT NOT NULL REFERENCES soiree_runs (id),
    rarity   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS soiree_crates_run ON soiree_crates (run_id);

  CREATE TRIGGER IF NOT EXISTS soiree_crates_no_update BEFORE UPDATE ON soiree_crates
  BEGIN
    SELECT RAISE(ABORT, 'a Soirée crate keeps the rarity it was paid at');
  END;

  CREATE TRIGGER IF NOT EXISTS soiree_crates_no_delete BEFORE DELETE ON soiree_crates
  BEGIN
    SELECT RAISE(ABORT, 'soiree_crates is append-only');
  END;

  CREATE INDEX IF NOT EXISTS coins_settled ON coins (state, settled_at);
`;

/** The mint pays a run's crates into the inventory and its keys into the wallet. */
export const SOIREE_REWARD_TX_KIND = 'soiree.reward' satisfies TxKind;

const RUN_ID_LENGTH = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

const StoredGuestsSchema = z.array(SoireeGuestSchema);
const StoredOffersSchema = z.array(z.array(SoireeFavorSchema));
const StoredResultSchema = z.object({
  runId: SoireeRunIdSchema,
  guestsServed: z.int().nonnegative(),
  favorsEarned: z.int().nonnegative(),
  results: z.array(SoireeGuestResultSchema),
  rewards: z.array(SoireeRewardSchema),
  proof: FairProofSchema,
});
type StoredResult = z.infer<typeof StoredResultSchema>;

interface RunRow extends Record<string, SqlStorageValue> {
  readonly id: string;
  readonly seed: number;
  readonly started_at: number;
  readonly ends_at: number;
  readonly interlude_ms: number;
  readonly rewarded: number;
  readonly guests: string;
  readonly offers: string;
  readonly proof: string;
  readonly last_draft: number;
  readonly favors_spent: number;
  readonly perk_id: string | null;
  readonly perk_starts_at: number | null;
  readonly perk_ends_at: number | null;
  readonly finished_at: number | null;
  readonly result: string | null;
}

export interface SoireeRun {
  readonly id: SoireeRunId;
  readonly seed: number;
  readonly startedAt: number;
  readonly endsAt: number;
  readonly interludeMs: number;
  readonly rewarded: boolean;
  readonly guests: readonly SoireeGuest[];
  /** `offers[n - 1]` is draft `n`, which follows guest `n`. */
  readonly offers: readonly (readonly SoireeFavor[])[];
  readonly proof: FairProof;
  /** The latest draft taken or passed; 0 before the first. */
  readonly lastDraft: number;
  readonly favorsSpent: number;
  readonly perk: SoireeActiveFavor | null;
  readonly result: StoredResult | null;
}

function toRun(row: RunRow): SoireeRun {
  return {
    id: SoireeRunIdSchema.parse(row.id),
    seed: row.seed,
    startedAt: row.started_at,
    endsAt: row.ends_at,
    interludeMs: row.interlude_ms,
    rewarded: row.rewarded === 1,
    guests: StoredGuestsSchema.parse(JSON.parse(row.guests)),
    offers: StoredOffersSchema.parse(JSON.parse(row.offers)),
    proof: FairProofSchema.parse(JSON.parse(row.proof)),
    lastDraft: row.last_draft,
    favorsSpent: row.favors_spent,
    perk:
      row.perk_id === null || row.perk_starts_at === null || row.perk_ends_at === null
        ? null
        : {
            id: SoireeFavorSchema.shape.id.parse(row.perk_id),
            startsAt: row.perk_starts_at,
            endsAt: row.perk_ends_at,
          },
    result: row.result === null ? null : StoredResultSchema.parse(JSON.parse(row.result)),
  };
}

function readRun(sql: SqlStorage, where: string, ...bindings: SqlStorageValue[]): SoireeRun | null {
  const row = sql
    .exec<RunRow>(`SELECT * FROM soiree_runs WHERE ${where}`, ...bindings)
    .toArray()[0];
  return row === undefined ? null : toRun(row);
}

/** The run the client names; another player's run is in another Durable Object, so it is not found. */
function namedRun(sql: SqlStorage, runId: SoireeRunId): SoireeRun {
  const run = readRun(sql, 'id = ?', runId);
  if (run === null) {
    throw new ApiFailure(
      'not_found',
      'No Soirée run with that ID belongs to this account. Start one with POST /v1/soiree/start.',
    );
  }
  return run;
}

function contractGuest(def: SoireeGuestDef, order: number): SoireeGuest {
  return SoireeGuestSchema.parse({
    id: def.id,
    order,
    request: def.request,
    favors: def.favors,
  });
}

function contractFavor(def: SoireeFavorDef): SoireeFavor {
  return SoireeFavorSchema.parse({
    id: def.id,
    stat: def.stat,
    magnitudeBp: def.magnitudeBp,
    durationMs: def.durationMs,
    cost: def.cost,
  });
}

export interface SoireeRoll {
  readonly seed: number;
  readonly guests: readonly SoireeGuest[];
  readonly offers: readonly (readonly SoireeFavor[])[];
}

/**
 * Everything a run is played on, drawn from one fair roll's stream in this order: the 32-bit
 * table seed, the seat plan, then the draft after every guest but the last. Anyone holding the
 * revealed server seed replays it from the proof.
 */
export function rollSoiree(rng: Rng): SoireeRoll {
  const seed = rng.nextUint32();
  const seated = seatSoireeGuests(rng);
  const guests = seated.map((def, i) => contractGuest(def, i + 1));
  const offers = guests.slice(1).map(() => drawSoireeOffer(rng).map(contractFavor));
  return { seed, guests, offers };
}

/** A crate's rarity on a Soirée odds table, one draw per crate. */
export function rollSoireeRarity(odds: OddsTable, rng: Rng): RarityId {
  let roll = rng.nextInt(oddsTotal(odds));
  for (const rarity of RARITY_IDS) {
    roll -= odds[rarity];
    if (roll < 0) return rarity;
  }
  throw new Error('rollSoireeRarity: the odds table fell through; its weights must be positive.');
}

export interface FrontFall {
  readonly tier: string;
  /** Server time the claim was accepted. */
  readonly at: number;
}

/**
 * Front-edge falls the server accepted through table claims in `[from, until)`, by the server
 * clock that settled them. Side falls go to the house as `lost` and fusions as `fused`, so only
 * a coin the player really pushed off the front is `claimed`.
 */
export function frontFalls(sql: SqlStorage, from: number, until: number): FrontFall[] {
  return sql
    .exec<{ tier: string; at: number }>(
      `SELECT tier, settled_at AS at FROM coins
       WHERE state = 'claimed' AND settled_at >= ? AND settled_at < ?
       ORDER BY settled_at, rowid`,
      from,
      until,
    )
    .toArray();
}

export type GuestStatus = 'waiting' | 'open' | 'fulfilled' | 'failed';

export interface GuestVerdict {
  readonly guest: SoireeGuest;
  readonly status: GuestStatus;
  /** When the window opens: the run's start, then the previous guest's resolution plus the interlude. */
  readonly opensAt: number;
  readonly resolvedAt: number | null;
  readonly progress: number;
}

/**
 * Judges every guest at `now` from the front falls alone. A window runs from `opensAt` for the
 * request's `windowMs`, cut at the run's end; the guest is fulfilled by the fall that reaches the
 * count and fails when the window closes short. Each fall counts for one guest at most, and a fall
 * in an interlude counts for nobody.
 */
export function judgeSoiree(
  run: Pick<SoireeRun, 'guests' | 'startedAt' | 'endsAt' | 'interludeMs'>,
  falls: readonly FrontFall[],
  now: number,
): GuestVerdict[] {
  const verdicts: GuestVerdict[] = [];
  let opensAt = run.startedAt;
  let cursor = 0;
  let blocked = false;
  for (const guest of run.guests) {
    if (blocked || opensAt > now) {
      verdicts.push({ guest, status: 'waiting', opensAt, resolvedAt: null, progress: 0 });
      blocked = true;
      continue;
    }
    const closesAt = Math.min(opensAt + guest.request.windowMs, run.endsAt);
    let progress = 0;
    let fulfilledAt: number | null = null;
    while (fulfilledAt === null && cursor < falls.length) {
      const fall = falls[cursor];
      if (fall === undefined || fall.at >= closesAt) break;
      cursor++;
      if (fall.at < opensAt || fall.tier !== guest.request.tier) continue;
      progress++;
      if (progress === guest.request.count) fulfilledAt = fall.at;
    }
    if (fulfilledAt !== null) {
      verdicts.push({ guest, status: 'fulfilled', opensAt, resolvedAt: fulfilledAt, progress });
      opensAt = fulfilledAt + run.interludeMs;
    } else if (now >= closesAt) {
      const resolvedAt = Math.max(opensAt, closesAt);
      verdicts.push({ guest, status: 'failed', opensAt, resolvedAt, progress });
      opensAt = resolvedAt + run.interludeMs;
    } else {
      verdicts.push({ guest, status: 'open', opensAt, resolvedAt: null, progress });
      blocked = true;
    }
  }
  return verdicts;
}

function judgeRun(sql: SqlStorage, run: SoireeRun, now: number): GuestVerdict[] {
  return judgeSoiree(run, frontFalls(sql, run.startedAt, Math.min(now + 1, run.endsAt)), now);
}

function isResolved(verdict: GuestVerdict): boolean {
  return verdict.status === 'fulfilled' || verdict.status === 'failed';
}

function favorsEarned(verdicts: readonly GuestVerdict[]): number {
  return verdicts.reduce((sum, v) => sum + (v.status === 'fulfilled' ? v.guest.favors : 0), 0);
}

function newRunId(): SoireeRunId {
  return SoireeRunIdSchema.parse(`${ENTITY_ID_PREFIXES.soireeRun}_${randomBase62(RUN_ID_LENGTH)}`);
}

/** Rewarded runs already started this UTC day by the server clock. */
function rewardedRunsToday(sql: SqlStorage, now: number): number {
  const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
  return sql
    .exec<{ n: number }>(
      'SELECT COUNT(*) AS n FROM soiree_runs WHERE rewarded = 1 AND started_at >= ?',
      dayStart,
    )
    .one().n;
}

const NO_REWARD: SoireeRewardTier = { crates: 0, perfectCrates: 0, keys: 0 };

/**
 * Settles a run inside the caller's storage transaction: judges every guest, rolls the crates'
 * rarities on a fresh fair roll (the plain crates first, then the perfect ones) and pays the
 * tier in one `soiree.reward` transaction. A run past the day's rewarded limit settles with no
 * payout.
 */
function settleRun(
  sql: SqlStorage,
  fair: FairSeeds,
  run: SoireeRun,
  context: CommitContext,
): StoredResult {
  const verdicts = judgeRun(sql, run, context.at);
  const results: SoireeGuestResult[] = verdicts.map((v) => ({
    guestId: v.guest.id,
    fulfilled: v.status === 'fulfilled',
    progress: v.progress,
  }));
  const guestsServed = results.filter((r) => r.fulfilled).length;
  const tier = run.rewarded ? soireeReward(guestsServed) : NO_REWARD;
  const roll = fair.roll('soiree.finish', run.id, context.at);
  const rarities = [
    ...Array.from({ length: tier.crates }, () =>
      rollSoireeRarity(soireeConfig.crateOdds, roll.rng),
    ),
    ...Array.from({ length: tier.perfectCrates }, () =>
      rollSoireeRarity(soireeConfig.perfectCrateOdds, roll.rng),
    ),
  ];

  const entities = new Entities(sql);
  const tx = new LedgerTx(SOIREE_REWARD_TX_KIND);
  const rewards: SoireeReward[] = [];
  const crates: { id: CrateId; rarity: RarityId }[] = [];
  for (const rarity of rarities) {
    const crate = entities.spawnCrate('vault', 0, context.at);
    entities.settleCrate(crate.id, 'claimed', context.at);
    tx.move('mint', 'inventory', 'crate', 1, crate.id);
    crates.push({ id: crate.id, rarity });
    rewards.push({ kind: 'crate', crateId: crate.id, rarity: RaritySchema.parse(rarity) });
  }
  if (tier.keys > 0) {
    tx.move('mint', 'wallet', 'keys', tier.keys, run.id);
    rewards.push({ kind: 'currency', currency: 'keys', amount: tier.keys });
  }
  commit(sql, tx, context);
  for (const crate of crates) {
    sql.exec(
      'INSERT INTO soiree_crates (crate_id, run_id, rarity) VALUES (?, ?, ?)',
      crate.id,
      run.id,
      crate.rarity,
    );
  }

  const result: StoredResult = {
    runId: run.id,
    guestsServed,
    favorsEarned: favorsEarned(verdicts),
    results,
    rewards,
    proof: { serverSeedHash: roll.serverSeedHash, clientSeed: roll.clientSeed, nonce: roll.nonce },
  };
  sql.exec(
    'UPDATE soiree_runs SET finished_at = ?, result = ? WHERE id = ?',
    context.at,
    JSON.stringify(result),
    run.id,
  );
  return result;
}

/**
 * Starts a run inside the caller's storage transaction. One run is open at a time: one still
 * inside its 8 minutes is refused with the time it has left, and one that ran out without a
 * finish is settled first, so a client that lost its run ID is never locked out. The seat plan,
 * table seed and every draft come from one fair roll; the clock is the server's.
 */
export function startSoireeRun(
  sql: SqlStorage,
  fair: FairSeeds,
  context: CommitContext,
): SoireeStartResponse {
  const open = readRun(sql, 'finished_at IS NULL');
  if (open !== null) {
    if (context.at < open.endsAt) {
      throw new ApiFailure(
        'conflict',
        'A Soirée is already running on this account. Finish it, or wait retryAfterMs for it to end.',
        { retryAfterMs: open.endsAt - context.at },
      );
    }
    settleRun(sql, fair, open, context);
  }

  const id = newRunId();
  const roll = fair.roll('soiree.start', id, context.at);
  const drawn = rollSoiree(roll.rng);
  const proof: FairProof = {
    serverSeedHash: roll.serverSeedHash,
    clientSeed: roll.clientSeed,
    nonce: roll.nonce,
  };
  const startedAt = context.at;
  const rewarded = rewardedRunsToday(sql, startedAt) < soireeConfig.rewardedRunsPerDay;
  sql.exec(
    `INSERT INTO soiree_runs
       (id, seed, started_at, ends_at, interlude_ms, rewarded, guests, offers, proof)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    drawn.seed,
    startedAt,
    soireeRunEndsAt(startedAt),
    soireeConfig.interludeMs,
    rewarded ? 1 : 0,
    JSON.stringify(drawn.guests),
    JSON.stringify(drawn.offers),
    JSON.stringify(proof),
  );
  const first = drawn.offers[0];
  if (first === undefined) throw new Error('A Soirée run seats one guest and has no draft.');
  return {
    runId: id,
    seed: drawn.seed,
    startedAt,
    durationMs: soireeConfig.durationMs,
    interludeMs: soireeConfig.interludeMs,
    guests: [...drawn.guests],
    offered: [...first],
    proof,
  };
}

/**
 * Takes or passes the draft that follows the latest resolved guest, during the interlude before
 * the next guest arrives. The client names only the run and one of the three perks the server
 * offered; the Favors it pays with are the ones the server counted from accepted claims.
 */
export function draftSoireeFavor(
  sql: SqlStorage,
  body: SoireeDraftRequest,
  context: CommitContext,
): SoireeDraftResponse {
  const run = namedRun(sql, body.runId);
  if (run.result !== null) {
    throw new ApiFailure('conflict', 'That Soirée is already finished, so its drafts are closed.');
  }
  if (context.at >= run.endsAt) {
    throw new ApiFailure('conflict', 'That Soirée is over. Finish it to collect the night.');
  }
  const verdicts = judgeRun(sql, run, context.at);
  const resolved = verdicts.findIndex((v) => !isResolved(v));
  const draft = resolved === -1 ? verdicts.length : resolved;
  if (draft === 0) {
    throw new ApiFailure(
      'not_ready',
      'The first draft opens once the first guest is served or leaves. Keep playing.',
    );
  }
  const offer = run.offers[draft - 1];
  if (offer === undefined) {
    throw new ApiFailure('conflict', 'The last guest has no draft after them. Finish the run.');
  }
  if (run.lastDraft >= draft) {
    throw new ApiFailure('conflict', `Draft ${draft} is already taken. Wait for the next guest.`);
  }
  if (verdicts[draft]?.status !== 'waiting') {
    throw new ApiFailure(
      'conflict',
      `Draft ${draft} closed when guest ${draft + 1} arrived. The next draft follows them.`,
    );
  }

  const balance = favorsEarned(verdicts) - run.favorsSpent;
  let picked: SoireeActiveFavor | null = null;
  let favorsLeft = balance;
  if (body.favorId !== null) {
    const favor = offer.find((f) => f.id === body.favorId);
    if (favor === undefined) {
      throw new ApiFailure(
        'bad_request',
        `Draft ${draft} offers ${offer.map((f) => f.id).join(', ')}; pick one of those or pass.`,
      );
    }
    if (favor.cost > balance) {
      throw new ApiFailure(
        'insufficient_funds',
        `${favor.id} costs ${favor.cost} Favors and ${balance} are left. Pick a cheaper perk or pass.`,
      );
    }
    favorsLeft = spendSoireeFavors(balance, favor);
    picked = {
      id: favor.id,
      startsAt: context.at,
      endsAt: Math.min(context.at + favor.durationMs, run.endsAt),
    };
  }

  sql.exec(
    `UPDATE soiree_runs SET last_draft = ?, favors_spent = ?,
       perk_id = COALESCE(?, perk_id), perk_starts_at = COALESCE(?, perk_starts_at),
       perk_ends_at = COALESCE(?, perk_ends_at)
     WHERE id = ?`,
    draft,
    run.favorsSpent + (balance - favorsLeft),
    picked?.id ?? null,
    picked?.startsAt ?? null,
    picked?.endsAt ?? null,
    run.id,
  );
  return {
    runId: run.id,
    draft,
    picked,
    favorsLeft,
    offered: [...(run.offers[draft] ?? [])],
  };
}

/**
 * Finishes a run inside the caller's storage transaction, once its 8 minutes are up or every
 * guest is resolved. A repeat for a finished run answers with the payout it already made.
 */
export function finishSoireeRun(
  sql: SqlStorage,
  fair: FairSeeds,
  body: SoireeFinishRequest,
  context: CommitContext,
): Omit<SoireeFinishResponse, 'wallet'> {
  const run = namedRun(sql, body.runId);
  if (run.result !== null) return run.result;
  if (context.at < run.endsAt && !judgeRun(sql, run, context.at).every(isResolved)) {
    throw new ApiFailure(
      'not_ready',
      'Guests are still waiting on this Soirée. Serve them, or finish after retryAfterMs.',
      { retryAfterMs: run.endsAt - context.at },
    );
  }
  return settleRun(sql, fair, run, context);
}

/** The rarity a Soirée paid this crate at, or null for any other crate. */
export function soireeCrateRarity(sql: SqlStorage, crateId: string): RarityId | null {
  const row = sql
    .exec<{ rarity: string }>('SELECT rarity FROM soiree_crates WHERE crate_id = ?', crateId)
    .toArray()[0];
  return row === undefined ? null : RaritySchema.parse(row.rarity);
}

export interface SoireeHost {
  startSoiree(command: Command<SoireeStartRequest>): Promise<DoResult<SoireeStartResponse>>;
  draftSoiree(command: Command<SoireeDraftRequest>): Promise<DoResult<SoireeDraftResponse>>;
  finishSoiree(command: Command<SoireeFinishRequest>): Promise<DoResult<SoireeFinishResponse>>;
}

export type SoireeHostResolver = (env: Env, playerId: PlayerId) => SoireeHost;

/** The client sends only the run it means and, for a draft, one offered perk or a pass. */
export function createSoireeRoutes(resolveHost: SoireeHostResolver): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const { soireeStart, soireeDraft, soireeFinish } = soireeEndpoints;

  routes.post(soireeStart.path, async (c) => {
    const request = await authenticate(c);
    const body = parseBody(soireeStart.body, request.rawBody);
    const result = await resolveHost(c.env, request.grant.playerId).startSoiree({
      idempotencyKey: requireIdempotencyKey(request),
      fingerprint: fingerprint(request),
      body,
    });
    return respond(c, soireeStart.response, result);
  });

  routes.post(soireeDraft.path, async (c) => {
    const request = await authenticate(c);
    const body = parseBody(soireeDraft.body, request.rawBody);
    const result = await resolveHost(c.env, request.grant.playerId).draftSoiree({
      idempotencyKey: requireIdempotencyKey(request),
      fingerprint: fingerprint(request),
      body,
    });
    return respond(c, soireeDraft.response, result);
  });

  routes.post(soireeFinish.path, async (c) => {
    const request = await authenticate(c);
    const body = parseBody(soireeFinish.body, request.rawBody);
    const result = await resolveHost(c.env, request.grant.playerId).finishSoiree({
      idempotencyKey: requireIdempotencyKey(request),
      fingerprint: fingerprint(request),
      body,
    });
    return respond(c, soireeFinish.response, result);
  });

  return routes;
}
