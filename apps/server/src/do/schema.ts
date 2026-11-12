import { UPGRADE_LEVELS_SQL } from '../routes/upgrades.ts';

/** PlayerDO SQLite migrations, applied in order; `schema_version` records how many ran. */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE wallet (
    currency TEXT PRIMARY KEY,
    balance  INTEGER NOT NULL CHECK (balance >= 0)
  );

  CREATE TABLE coins (
    id           TEXT PRIMARY KEY,
    tier         TEXT NOT NULL,
    value        INTEGER NOT NULL CHECK (value >= 0),
    state        TEXT NOT NULL CHECK (state IN ('buffer', 'table', 'claimed', 'lost', 'fused')),
    dropped_tick INTEGER,
    minted_at    INTEGER NOT NULL,
    settled_at   INTEGER
  );
  CREATE INDEX coins_state ON coins (state);

  CREATE TABLE crates (
    id           TEXT PRIMARY KEY,
    kind         TEXT NOT NULL,
    state        TEXT NOT NULL CHECK (state IN ('table', 'claimed', 'lost')),
    spawned_tick INTEGER NOT NULL,
    spawned_at   INTEGER NOT NULL,
    settled_at   INTEGER
  );
  CREATE INDEX crates_state ON crates (state);

  CREATE TABLE ledger (
    seq             INTEGER PRIMARY KEY,
    tx_id           TEXT NOT NULL,
    at              INTEGER NOT NULL,
    kind            TEXT NOT NULL,
    account         TEXT NOT NULL,
    unit            TEXT NOT NULL,
    delta           INTEGER NOT NULL,
    ref             TEXT,
    idempotency_key TEXT
  );

  CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger
  BEGIN
    SELECT RAISE(ABORT, 'ledger is append-only');
  END;

  CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger
  BEGIN
    SELECT RAISE(ABORT, 'ledger is append-only');
  END;

  CREATE TABLE idempotency (
    key         TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    response    TEXT NOT NULL,
    at          INTEGER NOT NULL
  );
  CREATE INDEX idempotency_at ON idempotency (at);
  `,
  `
  ALTER TABLE coins ADD COLUMN paid INTEGER NOT NULL DEFAULT 0 CHECK (paid >= 0);
  `,
  `
  CREATE TABLE coins_v3 (
    id           TEXT PRIMARY KEY,
    tier         TEXT NOT NULL,
    value        INTEGER NOT NULL CHECK (value >= 0),
    state        TEXT NOT NULL
                 CHECK (state IN ('buffer', 'table', 'claimed', 'lost', 'fused', 'refunded')),
    dropped_tick INTEGER,
    minted_at    INTEGER NOT NULL,
    settled_at   INTEGER,
    paid         INTEGER NOT NULL DEFAULT 0 CHECK (paid >= 0)
  );
  INSERT INTO coins_v3 (rowid, id, tier, value, state, dropped_tick, minted_at, settled_at, paid)
    SELECT rowid, id, tier, value, state, dropped_tick, minted_at, settled_at, paid FROM coins;
  DROP TABLE coins;
  ALTER TABLE coins_v3 RENAME TO coins;
  CREATE INDEX coins_state ON coins (state);
  CREATE INDEX ledger_ref ON ledger (ref);
  `,
  UPGRADE_LEVELS_SQL,
  `
  INSERT INTO meta (key, value)
    SELECT 'heap_seeded', '1' WHERE EXISTS (SELECT 1 FROM ledger WHERE kind = 'grant.heap');
  `,
  `
  ALTER TABLE coins ADD COLUMN mint_micros INTEGER CHECK (mint_micros >= 0);
  INSERT INTO meta (key, value)
    SELECT 'mint_carry', '0' WHERE EXISTS (SELECT 1 FROM meta WHERE key = 'player_id');
  `,
  `
  INSERT INTO meta (key, value)
    SELECT 'cascade_carry', '0' WHERE EXISTS (SELECT 1 FROM meta WHERE key = 'player_id');
  `,
  // Every spawn index up to drop_count already fired, so the mark starts there. Earlier refunds
  // are not taken back off drop_count: their re-drops were already counted as fresh drops.
  `
  INSERT INTO meta (key, value)
    SELECT 'drop_high_water', value FROM meta WHERE key = 'drop_count';
  `,
  // Table persistence (92-table-persistence 3.1). The heap was minted in the order the client
  // lays it, so a coin's slot is its rowid rank within the latest heap grant.
  `
  CREATE TABLE table_snapshot (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    session     TEXT    NOT NULL,
    seq         INTEGER NOT NULL CHECK (seq >= 0),
    tick        INTEGER NOT NULL CHECK (tick >= 0),
    pusher_tick INTEGER NOT NULL CHECK (pusher_tick >= 0),
    poses       TEXT    NOT NULL,
    crate_poses TEXT    NOT NULL,
    coin_count  INTEGER NOT NULL CHECK (coin_count >= 0),
    received_at INTEGER NOT NULL
  );

  CREATE TABLE snapshot_flags (
    kind     TEXT PRIMARY KEY
             CHECK (kind IN ('snapshot.foreign', 'snapshot.teleport', 'snapshot.implausible')),
    count    INTEGER NOT NULL CHECK (count >= 1),
    first_at INTEGER NOT NULL,
    last_at  INTEGER NOT NULL
  );

  CREATE TRIGGER snapshot_flags_no_update BEFORE UPDATE ON snapshot_flags
  WHEN NEW.kind IS NOT OLD.kind
    OR NEW.first_at IS NOT OLD.first_at
    OR NEW.count <= OLD.count
    OR NEW.last_at < OLD.last_at
  BEGIN
    SELECT RAISE(ABORT, 'snapshot_flags only counts up');
  END;

  CREATE TRIGGER snapshot_flags_no_delete BEFORE DELETE ON snapshot_flags
  BEGIN
    SELECT RAISE(ABORT, 'snapshot_flags is append-only');
  END;

  ALTER TABLE coins ADD COLUMN heap_slot INTEGER CHECK (heap_slot >= 0);

  WITH heap_grant (id) AS (
    SELECT ref FROM ledger
    WHERE kind = 'grant.heap' AND account = 'table' AND tx_id = (
      SELECT tx_id FROM ledger WHERE kind = 'grant.heap' ORDER BY seq DESC LIMIT 1
    )
  )
  UPDATE coins SET heap_slot = (
    SELECT COUNT(*) FROM coins AS earlier
    WHERE earlier.rowid < coins.rowid AND earlier.id IN (SELECT id FROM heap_grant)
  )
  WHERE id IN (SELECT id FROM heap_grant);
  `,
];

export function migrate(sql: SqlStorage, transactionSync: <T>(run: () => T) => T): void {
  transactionSync(() => {
    sql.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    const row = sql.exec<{ version: number }>('SELECT version FROM schema_version').toArray()[0];
    const current = row?.version ?? 0;
    for (let version = current; version < MIGRATIONS.length; version++) {
      sql.exec(MIGRATIONS[version] ?? '');
    }
    if (row === undefined) {
      sql.exec('INSERT INTO schema_version (version) VALUES (?)', MIGRATIONS.length);
    } else if (current < MIGRATIONS.length) {
      sql.exec('UPDATE schema_version SET version = ?', MIGRATIONS.length);
    }
  });
}
