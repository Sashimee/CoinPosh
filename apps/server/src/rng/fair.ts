import { createRng, type Rng } from '@coinposh/economy';
import {
  ActiveSeedSchema,
  fairRollMessage,
  RevealedSeedSchema,
  type ActiveSeed,
  type ClientSeed,
  type EpochMs,
  type FairRotateRequest,
  type FairRotateResponse,
  type FairSeedsResponse,
  type Nonce,
  type RevealedSeed,
  type Sha256Hex,
} from '@coinposh/shared';
import { randomBase62, randomBytes, utf8 } from '../crypto.ts';
import { ApiFailure } from '../http/errors.ts';
import { hmacSha256, sha256, toHex } from './hmac.ts';

/** How many revealed seeds `GET /v1/fair/seeds` lists, newest first. */
export const REVEALED_SEED_HISTORY = 20;
/**
 * Every rotation appends a seed row that can never be deleted, so rotation is throttled
 * per active seed: a client minting fresh Idempotency-Keys cannot grow storage faster.
 */
export const MIN_ROTATION_INTERVAL_MS = 60_000;
const SERVER_SEED_BYTES = 32;
const DEFAULT_CLIENT_SEED_LENGTH = 16;

/**
 * Seeds and rolls are append-only in spirit: a committed seed's secret, hash and client
 * seed never change, a nonce only moves forward, a reveal is final, and one seed is
 * active at a time. The triggers make SQLite refuse anything else, so a bug elsewhere in
 * the Durable Object cannot quietly swap a seed the player was already shown.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS fair_seeds (
    id               INTEGER PRIMARY KEY,
    server_seed      TEXT NOT NULL UNIQUE,
    server_seed_hash TEXT NOT NULL UNIQUE,
    client_seed      TEXT NOT NULL,
    nonce            INTEGER NOT NULL CHECK (nonce >= 0),
    committed_at     INTEGER NOT NULL,
    revealed_at      INTEGER,
    revealed_by      TEXT UNIQUE
  );
  CREATE UNIQUE INDEX IF NOT EXISTS fair_seeds_one_active
    ON fair_seeds (revealed_at IS NULL) WHERE revealed_at IS NULL;

  CREATE TRIGGER IF NOT EXISTS fair_seeds_no_delete BEFORE DELETE ON fair_seeds
  BEGIN
    SELECT RAISE(ABORT, 'fair_seeds is append-only');
  END;

  CREATE TRIGGER IF NOT EXISTS fair_seeds_commitment_fixed BEFORE UPDATE ON fair_seeds
  WHEN NEW.id IS NOT OLD.id
    OR NEW.server_seed IS NOT OLD.server_seed
    OR NEW.server_seed_hash IS NOT OLD.server_seed_hash
    OR NEW.client_seed IS NOT OLD.client_seed
    OR NEW.committed_at IS NOT OLD.committed_at
    OR NEW.nonce < OLD.nonce
    OR OLD.revealed_at IS NOT NULL
    OR (NEW.revealed_at IS NULL AND NEW.revealed_by IS NOT OLD.revealed_by)
  BEGIN
    SELECT RAISE(ABORT, 'a committed fair seed cannot be altered or un-revealed');
  END;

  CREATE TABLE IF NOT EXISTS fair_rolls (
    seed_id INTEGER NOT NULL REFERENCES fair_seeds (id),
    nonce   INTEGER NOT NULL,
    at      INTEGER NOT NULL,
    purpose TEXT NOT NULL,
    ref     TEXT,
    digest  TEXT NOT NULL,
    PRIMARY KEY (seed_id, nonce)
  );

  CREATE TRIGGER IF NOT EXISTS fair_rolls_no_update BEFORE UPDATE ON fair_rolls
  BEGIN
    SELECT RAISE(ABORT, 'fair_rolls is append-only');
  END;

  CREATE TRIGGER IF NOT EXISTS fair_rolls_no_delete BEFORE DELETE ON fair_rolls
  BEGIN
    SELECT RAISE(ABORT, 'fair_rolls is append-only');
  END;
`;

interface SeedRow extends Record<string, SqlStorageValue> {
  readonly id: number;
  readonly server_seed: string;
  readonly server_seed_hash: string;
  readonly client_seed: string;
  readonly nonce: number;
  readonly committed_at: number;
  readonly revealed_at: number | null;
  readonly revealed_by: string | null;
}

export interface FairRoll {
  readonly serverSeedHash: Sha256Hex;
  readonly clientSeed: ClientSeed;
  readonly nonce: Nonce;
  /** `HMAC_SHA256(serverSeed, clientSeed:nonce)` as lowercase hex. */
  readonly digest: Sha256Hex;
  /** Deterministic stream for economy rolls (drop tables, pity), seeded from the digest. */
  readonly rng: Rng;
}

export interface FairContext {
  readonly at: EpochMs;
  readonly idempotencyKey: string | null;
}

/** The commitment players are shown: `sha256` of the server seed's UTF-8 hex text. */
export function commitmentOf(serverSeed: string): Sha256Hex {
  return toHex(sha256(utf8(serverSeed)));
}

/** The HMAC key is the server seed's UTF-8 hex text, so any off-the-shelf HMAC tool verifies. */
export function fairDigest(serverSeed: string, clientSeed: ClientSeed, nonce: Nonce): Sha256Hex {
  return toHex(hmacSha256(utf8(serverSeed), utf8(fairRollMessage(clientSeed, nonce))));
}

/** Seeds economy's sfc32 from the digest's first four bytes, read big-endian. */
export function fairRngFromDigest(digest: Sha256Hex): Rng {
  return createRng(Number.parseInt(digest.slice(0, 8), 16));
}

/** True when a revealed seed matches the hash that was committed before any roll. */
export function verifyRevealedSeed(revealed: RevealedSeed): boolean {
  return commitmentOf(revealed.serverSeed) === revealed.serverSeedHash;
}

function newServerSeed(): string {
  return toHex(randomBytes(SERVER_SEED_BYTES));
}

function activeSeedOf(row: SeedRow, nonce = row.nonce): ActiveSeed {
  return ActiveSeedSchema.parse({
    serverSeedHash: row.server_seed_hash,
    clientSeed: row.client_seed,
    nonce,
  });
}

function revealedSeedOf(row: SeedRow): RevealedSeed {
  return RevealedSeedSchema.parse({
    serverSeed: row.server_seed,
    serverSeedHash: row.server_seed_hash,
    clientSeed: row.client_seed,
    finalNonce: row.nonce,
    revealedAt: row.revealed_at,
  });
}

/** One player's provably fair seed chain, stored in their Durable Object's SQLite. */
export class FairSeeds {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(SCHEMA);
  }

  /**
   * Starts the chain from a commitment the player was already shown (the PlayerDO's
   * original meta seed), so moving storage never swaps a seed out from under a roll.
   * Does nothing once a chain exists.
   */
  adopt(
    legacy: {
      readonly serverSeed: string;
      readonly serverSeedHash: string;
      readonly clientSeed: string;
      readonly nonce: number;
    },
    at: EpochMs,
  ): void {
    if (this.hasChain()) return;
    if (commitmentOf(legacy.serverSeed) !== legacy.serverSeedHash) {
      throw new Error('FairSeeds.adopt: the legacy server seed does not match its commitment.');
    }
    const active = ActiveSeedSchema.parse({
      serverSeedHash: legacy.serverSeedHash,
      clientSeed: legacy.clientSeed,
      nonce: legacy.nonce,
    });
    this.insertSeed(legacy.serverSeed, active.clientSeed, active.nonce, at);
  }

  /** Commits the first seed for a new player. Does nothing once a chain exists. */
  open(at: EpochMs): void {
    if (this.hasChain()) return;
    this.insertSeed(newServerSeed(), randomBase62(DEFAULT_CLIENT_SEED_LENGTH), 0, at);
  }

  active(): ActiveSeed {
    return activeSeedOf(this.activeRow());
  }

  seeds(): FairSeedsResponse {
    const revealed = this.sql
      .exec<SeedRow>(
        'SELECT * FROM fair_seeds WHERE revealed_at IS NOT NULL ORDER BY id DESC LIMIT ?',
        REVEALED_SEED_HISTORY,
      )
      .toArray()
      .map(revealedSeedOf);
    return { active: this.active(), revealed };
  }

  /** Consumes the active seed's next nonce and logs the roll for later verification. */
  roll(purpose: string, ref: string | null, at: EpochMs): FairRoll {
    const row = this.activeRow();
    const clientSeed = row.client_seed;
    const digest = fairDigest(row.server_seed, clientSeed, row.nonce);
    this.sql.exec('UPDATE fair_seeds SET nonce = nonce + 1 WHERE id = ?', row.id);
    this.sql.exec(
      'INSERT INTO fair_rolls (seed_id, nonce, at, purpose, ref, digest) VALUES (?, ?, ?, ?, ?, ?)',
      row.id,
      row.nonce,
      at,
      purpose,
      ref,
      digest,
    );
    return {
      serverSeedHash: row.server_seed_hash,
      clientSeed,
      nonce: row.nonce,
      digest,
      rng: fairRngFromDigest(digest),
    };
  }

  /**
   * Reveals the active seed and commits a fresh one. Replaying the same idempotency key
   * answers with the original rotation instead of revealing a second seed. A new
   * rotation sooner than `MIN_ROTATION_INTERVAL_MS` after the active commitment is refused.
   */
  rotate(request: FairRotateRequest, context: FairContext): FairRotateResponse {
    if (context.idempotencyKey !== null) {
      const replay = this.replayedRotation(request, context.idempotencyKey);
      if (replay !== null) return replay;
    }
    const current = this.activeRow();
    const retryAfterMs = current.committed_at + MIN_ROTATION_INTERVAL_MS - context.at;
    if (retryAfterMs > 0) {
      throw new ApiFailure(
        'rate_limited',
        `Seeds can be rotated at most once every ${MIN_ROTATION_INTERVAL_MS / 1000} s. Wait retryAfterMs, then rotate with a new Idempotency-Key.`,
        { retryAfterMs },
      );
    }
    this.sql.exec(
      'UPDATE fair_seeds SET revealed_at = ?, revealed_by = ? WHERE id = ?',
      context.at,
      context.idempotencyKey,
      current.id,
    );
    const next = this.insertSeed(
      newServerSeed(),
      request.clientSeed ?? current.client_seed,
      0,
      context.at,
    );
    return { active: activeSeedOf(next), revealed: revealedSeedOf(this.row(current.id)) };
  }

  private replayedRotation(
    request: FairRotateRequest,
    idempotencyKey: string,
  ): FairRotateResponse | null {
    const revealed = this.sql
      .exec<SeedRow>('SELECT * FROM fair_seeds WHERE revealed_by = ?', idempotencyKey)
      .toArray()[0];
    if (revealed === undefined) return null;
    const successor = this.sql
      .exec<SeedRow>('SELECT * FROM fair_seeds WHERE id > ? ORDER BY id LIMIT 1', revealed.id)
      .one();
    if (request.clientSeed !== undefined && request.clientSeed !== successor.client_seed) {
      throw new ApiFailure(
        'idempotency_key_reused',
        'This Idempotency-Key already rotated with a different client seed. Use a new key per request.',
      );
    }
    return { active: activeSeedOf(successor, 0), revealed: revealedSeedOf(revealed) };
  }

  private hasChain(): boolean {
    return this.sql.exec('SELECT 1 FROM fair_seeds LIMIT 1').toArray().length > 0;
  }

  private activeRow(): SeedRow {
    const row = this.sql
      .exec<SeedRow>('SELECT * FROM fair_seeds WHERE revealed_at IS NULL')
      .toArray()[0];
    if (row === undefined) {
      throw new Error(
        'FairSeeds: no active seed. Call open() or adopt() when the player is created.',
      );
    }
    return row;
  }

  private row(id: number): SeedRow {
    return this.sql.exec<SeedRow>('SELECT * FROM fair_seeds WHERE id = ?', id).one();
  }

  private insertSeed(serverSeed: string, clientSeed: string, nonce: number, at: EpochMs): SeedRow {
    const row = this.sql
      .exec<{ id: number }>(
        `INSERT INTO fair_seeds (server_seed, server_seed_hash, client_seed, nonce, committed_at)
         VALUES (?, ?, ?, ?, ?) RETURNING id`,
        serverSeed,
        commitmentOf(serverSeed),
        clientSeed,
        nonce,
        at,
      )
      .one();
    return this.row(row.id);
  }
}
