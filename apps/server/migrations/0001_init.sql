-- One account per device key: the key's RFC 7638 thumbprint is unique.
CREATE TABLE players (
  id           TEXT PRIMARY KEY,
  device_jkt   TEXT NOT NULL UNIQUE,
  device_jwk   TEXT NOT NULL,
  display_name TEXT NOT NULL,
  locale       TEXT NOT NULL CHECK (locale IN ('en', 'fr', 'de')),
  created_at   INTEGER NOT NULL
) STRICT;

-- Stored only as SHA-256 hashes. Presenting a rotated token again revokes its whole
-- family, since only a thief or a replay would still hold it.
CREATE TABLE refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  player_id  TEXT NOT NULL REFERENCES players (id),
  family_id  TEXT NOT NULL,
  issued_at  INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  rotated_at INTEGER,
  revoked_at INTEGER
) STRICT;
CREATE INDEX refresh_tokens_family ON refresh_tokens (family_id);

-- Auth idempotency keys are single-use so a captured signed auth request can never be
-- replayed for fresh tokens.
CREATE TABLE auth_requests (
  idempotency_key TEXT PRIMARY KEY,
  route           TEXT NOT NULL,
  at              INTEGER NOT NULL
) STRICT;

-- A mirror of each PlayerDO wallet as of `ledger_seq`; the PlayerDO stays authoritative.
CREATE TABLE wallets (
  player_id  TEXT PRIMARY KEY REFERENCES players (id),
  coins      INTEGER NOT NULL CHECK (coins >= 0),
  bullion    INTEGER NOT NULL CHECK (bullion >= 0),
  gold_bars  INTEGER NOT NULL CHECK (gold_bars >= 0),
  pearls     INTEGER NOT NULL CHECK (pearls >= 0),
  keys       INTEGER NOT NULL CHECK (keys >= 0),
  tickets    INTEGER NOT NULL CHECK (tickets >= 0),
  stars      INTEGER NOT NULL CHECK (stars >= 0),
  ledger_seq INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- Double-entry: the legs of each transaction sum to zero per unit, and the `mint`
-- account is the only source of new value.
CREATE TABLE ledger (
  player_id       TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  tx_id           TEXT NOT NULL,
  at              INTEGER NOT NULL,
  kind            TEXT NOT NULL,
  account         TEXT NOT NULL,
  unit            TEXT NOT NULL,
  delta           INTEGER NOT NULL,
  ref             TEXT,
  idempotency_key TEXT,
  PRIMARY KEY (player_id, seq)
) STRICT;
CREATE INDEX ledger_tx ON ledger (player_id, tx_id);

CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger
BEGIN
  SELECT RAISE(ABORT, 'ledger is append-only');
END;

CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger
BEGIN
  SELECT RAISE(ABORT, 'ledger is append-only');
END;
