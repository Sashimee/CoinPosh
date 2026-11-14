import {
  crateIncomeCoins,
  crateRewards,
  dropTables,
  initialPityState,
  offlineRate,
  pity,
  rollDrop,
  safeTimerReady,
  safeTypeDef,
  safeUnlocksAt,
  type DropTableDef,
  type PityState,
  type RarityId,
  type SafeTypeDef,
} from '@coinposh/economy';
import {
  endpoints,
  RARITY_IDS,
  SafeIdSchema,
  SafeTypeIdSchema,
  type Currency,
  type DropSourceId,
  type EpochMs,
  type PityCounters,
  type PlayerId,
  type Reward,
  type Roll,
  type Safe,
  type SafeId,
  type SafeOpenMethod,
  type SafeOpenRequest,
  type SafeOpenResponse,
} from '@coinposh/shared';
import { Hono } from 'hono';
import { newSafeId } from '../do/entities.ts';
import type { Command, DoResult } from '../do/PlayerDO.ts';
import { commit, LedgerTx, readWallet, type CommitContext, type TxKind } from '../do/ledger.ts';
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
import { measuredActiveRate } from './offline.ts';

/**
 * PlayerDO tables for key-locked safes. A safe is granted `locked` with `unlocks_at` stamped
 * from the server clock and opens exactly once: the trigger refuses any other change, so a bug
 * elsewhere cannot re-lock a safe, move its timer or open it twice. `pity_counters` holds the
 * misses since the last result at or above each pitied rarity, per drop source.
 */
export const SAFES_SQL = `
  CREATE TABLE IF NOT EXISTS safes (
    id         TEXT PRIMARY KEY,
    type       TEXT NOT NULL,
    state      TEXT NOT NULL CHECK (state IN ('locked', 'opened')),
    source     TEXT NOT NULL,
    granted_at INTEGER NOT NULL CHECK (granted_at >= 0),
    unlocks_at INTEGER NOT NULL CHECK (unlocks_at >= granted_at),
    opened_at  INTEGER,
    opened_by  TEXT CHECK (opened_by IN ('key', 'timer')),
    rarity     TEXT,
    CHECK ((state = 'locked') = (opened_at IS NULL AND opened_by IS NULL AND rarity IS NULL))
  );
  CREATE INDEX IF NOT EXISTS safes_state ON safes (state, unlocks_at);

  CREATE TRIGGER IF NOT EXISTS safes_open_once BEFORE UPDATE ON safes
  WHEN OLD.state IS NOT 'locked'
    OR NEW.state IS NOT 'opened'
    OR NEW.id IS NOT OLD.id
    OR NEW.type IS NOT OLD.type
    OR NEW.source IS NOT OLD.source
    OR NEW.granted_at IS NOT OLD.granted_at
    OR NEW.unlocks_at IS NOT OLD.unlocks_at
  BEGIN
    SELECT RAISE(ABORT, 'a safe opens once and its grant is fixed');
  END;

  CREATE TRIGGER IF NOT EXISTS safes_no_delete BEFORE DELETE ON safes
  BEGIN
    SELECT RAISE(ABORT, 'safes is append-only');
  END;

  CREATE TABLE IF NOT EXISTS pity_counters (
    source TEXT NOT NULL,
    rarity TEXT NOT NULL,
    misses INTEGER NOT NULL CHECK (misses >= 0),
    PRIMARY KEY (source, rarity)
  );
`;

/** A safe enters the inventory as new value: one `safe` unit moves mint → inventory. */
export const SAFE_GRANT_TX_KIND = 'safe.grant' satisfies TxKind;
/** Opening by Key: `keysPerSafe` Keys move wallet → house and are never refunded. */
export const SAFE_KEY_TX_KIND = 'safe.key' satisfies TxKind;
/** The safe leaves the inventory for the house and the mint pays its contents to the wallet. */
export const SAFE_OPEN_TX_KIND = 'safe.open' satisfies TxKind;

type SafeState = 'locked' | 'opened';

interface SafeRow extends Record<string, SqlStorageValue> {
  readonly id: string;
  readonly type: string;
  readonly state: SafeState;
  readonly unlocks_at: number;
}

export interface SafeGrant {
  readonly type: string;
  /** What granted it, e.g. `crate:<id>` or `quest:<id>`; kept for audit, never shown. */
  readonly source: string;
}

function publicSafe(row: SafeRow): Safe {
  return {
    id: SafeIdSchema.parse(row.id),
    type: SafeTypeIdSchema.parse(row.type),
    unlocksAt: row.unlocks_at,
  };
}

/**
 * Grants one safe inside the caller's storage transaction. `unlocksAt` comes from economy config
 * and `context.at`, the Durable Object's clock, so no client time ever sets a timer.
 */
export function grantSafe(sql: SqlStorage, grant: SafeGrant, context: CommitContext): Safe {
  const def = safeTypeDef(grant.type);
  const id = newSafeId();
  const unlocksAt = safeUnlocksAt(def.id, context.at);
  sql.exec(
    `INSERT INTO safes (id, type, state, source, granted_at, unlocks_at)
     VALUES (?, ?, 'locked', ?, ?, ?)`,
    id,
    def.id,
    grant.source,
    context.at,
    unlocksAt,
  );
  commit(sql, new LedgerTx(SAFE_GRANT_TX_KIND).move('mint', 'inventory', 'safe', 1, id), context);
  return { id, type: SafeTypeIdSchema.parse(def.id), unlocksAt };
}

/** The safes the player holds unopened, soonest timer first, as `GET /v1/state` lists them. */
export function readSafes(sql: SqlStorage): Safe[] {
  return sql
    .exec<SafeRow>(
      "SELECT id, type, state, unlocks_at FROM safes WHERE state = 'locked' ORDER BY unlocks_at, rowid",
    )
    .toArray()
    .map(publicSafe);
}

export function countLockedSafes(sql: SqlStorage): number {
  return sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM safes WHERE state = 'locked'").one().n;
}

function pitiedRarities(): RarityId[] {
  return pity.rules.map((rule) => rule.rarity);
}

export function readPity(sql: SqlStorage, source: DropSourceId): PityState {
  const state: Partial<Record<RarityId, number>> = { ...initialPityState(pity) };
  for (const row of sql.exec<{ rarity: string; misses: number }>(
    'SELECT rarity, misses FROM pity_counters WHERE source = ?',
    source,
  )) {
    const rarity = RARITY_IDS.find((id) => id === row.rarity);
    if (rarity !== undefined && rarity in state) state[rarity] = row.misses;
  }
  return state;
}

function writePity(sql: SqlStorage, source: DropSourceId, state: PityState): void {
  for (const rarity of pitiedRarities()) {
    sql.exec(
      `INSERT INTO pity_counters (source, rarity, misses) VALUES (?, ?, ?)
       ON CONFLICT (source, rarity) DO UPDATE SET misses = excluded.misses`,
      source,
      rarity,
      state[rarity] ?? 0,
    );
  }
}

function pityCounters(state: PityState): PityCounters {
  return {
    rare: state.rare ?? 0,
    exquisite: state.exquisite ?? 0,
    legendary: state.legendary ?? 0,
  };
}

function dropTable(source: DropSourceId): DropTableDef {
  const table = dropTables.find((candidate) => candidate.source === source);
  if (table === undefined) throw new Error(`Economy config has no "${source}" drop table.`);
  return table;
}

function lockedSafe(sql: SqlStorage, safeId: SafeId): SafeRow {
  const row = sql
    .exec<SafeRow>('SELECT id, type, state, unlocks_at FROM safes WHERE id = ?', safeId)
    .toArray()[0];
  if (row === undefined) {
    throw new ApiFailure('not_found', 'No safe with that ID belongs to this account.');
  }
  if (row.state !== 'locked') {
    throw new ApiFailure('conflict', 'That safe is already open. Refresh state.');
  }
  return row;
}

/**
 * How the safe opens: a timer only once the server clock reaches `unlocksAt`, a Key at any time.
 * A safe whose timer already ran out opens free even when a Key was asked for, so a stale tap
 * never burns a Key the player did not need.
 */
function openingMethod(
  def: SafeTypeDef,
  row: SafeRow,
  requested: SafeOpenMethod,
  keys: number,
  now: EpochMs,
): SafeOpenMethod {
  if (safeTimerReady(row.unlocks_at, now)) return 'timer';
  if (requested === 'timer') {
    const retryAfterMs = row.unlocks_at - now;
    throw new ApiFailure(
      'not_ready',
      `That safe's timer ends in ${Math.ceil(retryAfterMs / 1000)} s. Open it with ${def.keysPerSafe} Key or wait.`,
      { retryAfterMs },
    );
  }
  if (keys < def.keysPerSafe) {
    throw new ApiFailure(
      'insufficient_funds',
      `Opening that safe now costs ${def.keysPerSafe} Key; the wallet holds ${keys}.`,
    );
  }
  return 'key';
}

/**
 * Opens one safe inside the caller's storage transaction. The client names only the safe and
 * how to open it: the timer is judged on the server clock, the Key price comes from economy
 * config, and the contents are a provably fair roll on the safe type's drop table with its pity
 * counters, paid out as that rarity's `crateRewards` currencies. A safe never holds a safe.
 */
export function openSafe(
  sql: SqlStorage,
  fair: FairSeeds,
  body: SafeOpenRequest,
  context: CommitContext,
): SafeOpenResponse {
  const row = lockedSafe(sql, body.safeId);
  const def = safeTypeDef(row.type);
  const method = openingMethod(def, row, body.method, readWallet(sql).keys, context.at);
  if (method === 'key') {
    commit(
      sql,
      new LedgerTx(SAFE_KEY_TX_KIND).move('wallet', 'house', 'keys', def.keysPerSafe, row.id),
      context,
    );
  }

  const source = def.dropSource;
  const roll = fair.roll(`safe.${source}`, row.id, context.at);
  const drawn = rollDrop(dropTable(source), pity, readPity(sql, source), roll.rng);
  writePity(sql, source, drawn.state);

  const reward = crateRewards[drawn.rarity];
  const payout: [Currency, number][] = [
    ['coins', crateIncomeCoins(reward.incomeSeconds, measuredActiveRate(sql), offlineRate)],
    ['pearls', reward.pearls],
    ['keys', reward.keys],
    ['tickets', reward.tickets],
  ];
  const tx = new LedgerTx(SAFE_OPEN_TX_KIND).move('inventory', 'house', 'safe', 1, row.id);
  const rewards: Reward[] = [];
  for (const [currency, amount] of payout) {
    if (amount <= 0) continue;
    tx.move('mint', 'wallet', currency, amount, row.id);
    rewards.push({ kind: 'currency', currency, amount });
  }

  sql.exec(
    "UPDATE safes SET state = 'opened', opened_at = ?, opened_by = ?, rarity = ? WHERE id = ?",
    context.at,
    method,
    drawn.rarity,
    row.id,
  );
  commit(sql, tx, context);

  const result: Roll = {
    rarity: drawn.rarity,
    rewards,
    proof: { serverSeedHash: roll.serverSeedHash, clientSeed: roll.clientSeed, nonce: roll.nonce },
    pity: pityCounters(drawn.state),
  };
  return { safeId: SafeIdSchema.parse(row.id), roll: result, wallet: readWallet(sql) };
}

export interface SafeHost {
  openSafe(command: Command<SafeOpenRequest>): Promise<DoResult<SafeOpenResponse>>;
}

export type SafeHostResolver = (env: Env, playerId: PlayerId) => SafeHost;

/** The client sends only the safe, `key` or `timer`, and an Idempotency-Key. */
export function createSafeRoutes(resolveHost: SafeHostResolver): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.post(endpoints.safesOpen.path, async (c) => {
    const request = await authenticate(c);
    const body = parseBody(endpoints.safesOpen.body, request.rawBody);
    const result = await resolveHost(c.env, request.grant.playerId).openSafe({
      idempotencyKey: requireIdempotencyKey(request),
      fingerprint: fingerprint(request),
      body,
    });
    return respond(c, endpoints.safesOpen.response, result);
  });
  return routes;
}
