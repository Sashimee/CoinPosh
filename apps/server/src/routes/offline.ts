import {
  measuredActiveRatePerHour,
  offline,
  offlineRate,
  offlineVaultCoins,
  playWindowStart,
} from '@coinposh/economy';
import type { EpochMs, OfflineSettlement } from '@coinposh/shared';
import type { TxKind } from '../do/ledger.ts';

/** The ledger kind for a Velvet Vault payout: new value, so it moves mint → wallet. */
export const OFFLINE_TX_KIND = 'offline.vault';

/** Shorter absences are a tab switch, not a return; GET /v1/state then settles nothing. */
export const OFFLINE_MIN_AWAY_MS = 5 * 60_000;
const HOUR_MS = 3_600_000;
const PLAY_KINDS = ['drop.mint', 'drop.buffer', 'claim.fall'] as const satisfies readonly TxKind[];
const PLAY_KIND_PLACEHOLDERS = PLAY_KINDS.map(() => '?').join(', ');

export const OFFLINE_SETTLEMENTS_SQL = `
  CREATE TABLE IF NOT EXISTS offline_settlements (
    at          INTEGER PRIMARY KEY,
    away_ms     INTEGER NOT NULL CHECK (away_ms >= 0),
    credited_ms INTEGER NOT NULL CHECK (credited_ms >= 0 AND credited_ms <= away_ms),
    coins       INTEGER NOT NULL CHECK (coins > 0)
  );
`;

function maxAt(sql: SqlStorage, query: string, ...bindings: string[]): number | null {
  return sql.exec<{ at: number | null }>(query, ...bindings).one().at;
}

/** The last moment the player's value moved, or the last time the vault paid out. */
function settledThrough(sql: SqlStorage): number | null {
  const ledger = maxAt(sql, 'SELECT MAX(at) AS at FROM ledger');
  const vault = maxAt(sql, 'SELECT MAX(at) AS at FROM offline_settlements');
  if (ledger === null) return vault;
  return vault === null ? ledger : Math.max(ledger, vault);
}

/**
 * Net coins per hour the wallet gained from play (falls won minus drops paid) during the
 * last stretch of play (`offlineRate.windowMs`), matching the balancing sim's net rate and
 * the Demo mock. Vault payouts, crate loot and allowances are not play, so they never
 * compound into the rate.
 */
export function measuredActiveRate(sql: SqlStorage): number {
  const end = maxAt(
    sql,
    `SELECT MAX(at) AS at FROM ledger WHERE kind IN (${PLAY_KIND_PLACEHOLDERS})`,
    ...PLAY_KINDS,
  );
  if (end === null) return 0;
  const windowStart = playWindowStart(end, offlineRate);
  const row = sql
    .exec<{ first: number | null; won: number | null }>(
      `SELECT
         (SELECT MIN(at) FROM ledger WHERE at >= ? AND kind IN (${PLAY_KIND_PLACEHOLDERS})) AS first,
         (SELECT SUM(delta) FROM ledger
           WHERE at >= ? AND at <= ? AND kind IN (${PLAY_KIND_PLACEHOLDERS})
             AND account = 'wallet' AND unit = 'coins') AS won`,
      windowStart,
      ...PLAY_KINDS,
      windowStart,
      end,
      ...PLAY_KINDS,
    )
    .one();
  return measuredActiveRatePerHour(
    { netCoins: row.won ?? 0, firstAt: row.first ?? end, lastAt: end },
    offlineRate,
  );
}

/**
 * What the Velvet Vault owes on return, from server time only: `now` is the DO's clock,
 * never a client timestamp. A measured rate below `offlineRate.starterRatePerHour` (a fresh
 * profile, or play that lost coins) pays on that starter floor instead. Returns null when
 * nothing is owed, so repeated state reads during play stay free; once recorded, a
 * settlement marks everything before it as paid.
 */
export function quoteOffline(
  sql: SqlStorage,
  now: EpochMs,
  capHours: number,
): OfflineSettlement | null {
  const since = settledThrough(sql);
  if (since === null) return null;
  const awayMs = now - since;
  if (awayMs < OFFLINE_MIN_AWAY_MS) return null;
  const cap = Math.min(Math.max(capHours, offline.baseCapHours), offline.maxCapHours);
  const creditedMs = Math.min(awayMs, cap * HOUR_MS);
  const coins = offlineVaultCoins(
    awayMs / HOUR_MS,
    cap,
    measuredActiveRate(sql),
    offlineRate,
    offline,
  );
  if (coins < 1) return null;
  return { awayMs, creditedMs, coins };
}

/** Call in the same storage transaction as the mint → wallet ledger credit. */
export function recordOffline(sql: SqlStorage, now: EpochMs, settlement: OfflineSettlement): void {
  sql.exec(
    'INSERT INTO offline_settlements (at, away_ms, credited_ms, coins) VALUES (?, ?, ?, ?)',
    now,
    settlement.awayMs,
    settlement.creditedMs,
    settlement.coins,
  );
}
