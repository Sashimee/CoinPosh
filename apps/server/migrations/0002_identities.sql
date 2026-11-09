-- A provider account keeps exactly one save, and a save links each provider at most once.
CREATE TABLE identities (
  provider   TEXT NOT NULL CHECK (provider IN ('google', 'apple')),
  subject    TEXT NOT NULL,
  player_id  TEXT NOT NULL REFERENCES players (id),
  email_hint TEXT,
  linked_at  INTEGER NOT NULL,
  PRIMARY KEY (provider, subject),
  UNIQUE (player_id, provider)
) STRICT;

-- Single-use and bound to the device key that asked, the provider and the purpose, so a nonce
-- lifted from one flow cannot be spent in another. The consumer is kept to answer a retry of
-- the exact same link idempotently. `client_ip` is an HMAC of CF-Connecting-IP (never the
-- address itself) and caps how many open nonces one network can hold, since a bot can mint a
-- fresh device key for every request.
CREATE TABLE account_nonces (
  nonce                TEXT PRIMARY KEY,
  provider             TEXT NOT NULL CHECK (provider IN ('google', 'apple')),
  purpose              TEXT NOT NULL CHECK (purpose IN ('link', 'signin')),
  device_jkt           TEXT NOT NULL,
  client_ip            TEXT NOT NULL,
  issued_at            INTEGER NOT NULL,
  expires_at           INTEGER NOT NULL,
  consumed_at          INTEGER,
  consumed_key         TEXT,
  consumed_fingerprint TEXT,
  consumed_player      TEXT
) STRICT;
CREATE INDEX account_nonces_device ON account_nonces (device_jkt, expires_at);
CREATE INDEX account_nonces_client_ip ON account_nonces (client_ip, expires_at);
CREATE INDEX account_nonces_expiry ON account_nonces (expires_at);

-- Extra device keys that reached a save by signing in; the key in `players` stays its first
-- device. Unlinking the provider revokes the devices that came in through it.
CREATE TABLE player_devices (
  player_id  TEXT NOT NULL REFERENCES players (id),
  device_jkt TEXT NOT NULL,
  device_jwk TEXT NOT NULL,
  provider   TEXT NOT NULL CHECK (provider IN ('google', 'apple')),
  added_at   INTEGER NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY (player_id, device_jkt)
) STRICT;

-- NULL for the save's first device; otherwise the `player_devices` key the token is bound to.
ALTER TABLE refresh_tokens ADD COLUMN device_jkt TEXT;

CREATE TABLE account_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id  TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('link', 'unlink', 'signin')),
  provider   TEXT NOT NULL CHECK (provider IN ('google', 'apple')),
  device_jkt TEXT NOT NULL,
  at         INTEGER NOT NULL
) STRICT;
CREATE INDEX account_events_player ON account_events (player_id, at);

CREATE TRIGGER account_events_no_update BEFORE UPDATE ON account_events
BEGIN
  SELECT RAISE(ABORT, 'account_events is append-only');
END;

CREATE TRIGGER account_events_no_delete BEFORE DELETE ON account_events
BEGIN
  SELECT RAISE(ABORT, 'account_events is append-only');
END;
