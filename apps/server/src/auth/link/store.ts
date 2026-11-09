import { upgradeLines, upgradeStat } from '@coinposh/economy';
import {
  AccountSchema,
  PlayerIdSchema,
  SaveSummarySchema,
  type Account,
  type DevicePublicKey,
  type EpochMs,
  type IdempotencyKey,
  type IdentityProvider,
  type PlayerId,
  type SaveSummary,
} from '@coinposh/shared';
import type { Env } from '../../env.ts';
import { ApiFailure } from '../../http/errors.ts';
import { hashRefreshToken, newRefreshToken, REFRESH_TOKEN_TTL_MS } from '../tokens.ts';
import { availableProviders } from './providers.ts';

/** Ledger kinds a save writes before its player has done anything. */
const UNTOUCHED_SAVE_KINDS = ['grant.starting', 'grant.heap', 'buffer.prepay'] as const;

/** Same single-use rule as the guest and refresh routes: a captured signed request works once. */
export async function burnAuthKey(
  db: D1Database,
  key: IdempotencyKey,
  route: string,
  now: EpochMs,
) {
  const result = await db
    .prepare('INSERT OR IGNORE INTO auth_requests (idempotency_key, route, at) VALUES (?, ?, ?)')
    .bind(key, route, now)
    .run();
  if (result.meta.changes !== 1) {
    throw new ApiFailure(
      'idempotency_key_reused',
      'This Idempotency-Key was already used to sign in. Sign the request again with a new key.',
    );
  }
}

export function storedJwk(key: DevicePublicKey): string {
  return JSON.stringify({ kty: key.kty, crv: key.crv, x: key.x, y: key.y });
}

export async function readAccount(env: Env, playerId: PlayerId): Promise<Account> {
  const rows = await env.DB.prepare(
    'SELECT provider, linked_at, email_hint FROM identities WHERE player_id = ? ORDER BY linked_at, provider',
  )
    .bind(playerId)
    .all<{ provider: string; linked_at: number; email_hint: string | null }>();
  return AccountSchema.parse({
    playerId,
    identities: rows.results.map((row) => ({
      provider: row.provider,
      linkedAt: row.linked_at,
      ...(row.email_hint === null ? {} : { emailHint: row.email_hint }),
    })),
    available: availableProviders(env),
  });
}

export async function identityOwner(
  db: D1Database,
  provider: IdentityProvider,
  subject: string,
): Promise<PlayerId | null> {
  const row = await db
    .prepare('SELECT player_id FROM identities WHERE provider = ? AND subject = ?')
    .bind(provider, subject)
    .first<{ player_id: string }>();
  return row === null ? null : PlayerIdSchema.parse(row.player_id);
}

function identityInUse(label: string): ApiFailure {
  return new ApiFailure(
    'identity_in_use',
    `This ${label} account already keeps another CoinPosh save. Sign in with it instead, or link a different ${label} account.`,
  );
}

/** Links once; linking the same identity to the same save again is a no-op. */
export async function linkIdentity(
  db: D1Database,
  input: {
    playerId: PlayerId;
    provider: IdentityProvider;
    label: string;
    subject: string;
    emailHint: string | null;
    deviceJkt: string;
    now: EpochMs;
  },
): Promise<void> {
  const { playerId, provider, label, subject, emailHint, deviceJkt, now } = input;
  const owner = await identityOwner(db, provider, subject);
  if (owner === playerId) return;
  if (owner !== null) throw identityInUse(label);
  const current = await db
    .prepare('SELECT subject FROM identities WHERE player_id = ? AND provider = ?')
    .bind(playerId, provider)
    .first<{ subject: string }>();
  if (current !== null) {
    throw new ApiFailure(
      'identity_in_use',
      `This save is already linked to a different ${label} account. Unlink it first to switch.`,
    );
  }
  const [inserted] = await db.batch([
    db
      .prepare(
        `INSERT INTO identities (provider, subject, player_id, email_hint, linked_at)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      )
      .bind(provider, subject, playerId, emailHint, now),
    db
      .prepare(
        `INSERT INTO account_events (player_id, kind, provider, device_jkt, at)
         SELECT ?, 'link', ?, ?, ? WHERE changes() = 1`,
      )
      .bind(playerId, provider, deviceJkt, now),
  ]);
  if (inserted?.meta.changes !== 1) {
    // Lost a race: another request linked this identity or this provider in between.
    if ((await identityOwner(db, provider, subject)) === playerId) return;
    throw identityInUse(label);
  }
}

/**
 * Removes the link and revokes every device that reached the save through it, except the one
 * asking. The save's first device and devices from other providers keep working.
 */
export async function unlinkIdentity(
  db: D1Database,
  input: { playerId: PlayerId; provider: IdentityProvider; deviceJkt: string; now: EpochMs },
): Promise<void> {
  const { playerId, provider, deviceJkt, now } = input;
  const linked = await db
    .prepare('SELECT 1 AS linked FROM identities WHERE player_id = ? AND provider = ?')
    .bind(playerId, provider)
    .first<{ linked: number }>();
  if (linked === null) return;
  await db.batch([
    db
      .prepare(
        `UPDATE refresh_tokens SET revoked_at = ?
          WHERE player_id = ? AND revoked_at IS NULL AND device_jkt IN (
            SELECT device_jkt FROM player_devices
             WHERE player_id = ? AND provider = ? AND device_jkt <> ? AND revoked_at IS NULL)`,
      )
      .bind(now, playerId, playerId, provider, deviceJkt),
    db
      .prepare(
        `UPDATE player_devices SET revoked_at = ?
          WHERE player_id = ? AND provider = ? AND device_jkt <> ? AND revoked_at IS NULL`,
      )
      .bind(now, playerId, provider, deviceJkt),
    db
      .prepare('DELETE FROM identities WHERE player_id = ? AND provider = ?')
      .bind(playerId, provider),
    db
      .prepare(
        `INSERT INTO account_events (player_id, kind, provider, device_jkt, at)
         VALUES (?, 'unlink', ?, ?, ?)`,
      )
      .bind(playerId, provider, deviceJkt, now),
  ]);
}

/** The save this device key created as a guest, if any. */
export async function deviceGuest(db: D1Database, deviceJkt: string): Promise<PlayerId | null> {
  const row = await db
    .prepare('SELECT id FROM players WHERE device_jkt = ?')
    .bind(deviceJkt)
    .first<{ id: string }>();
  return row === null ? null : PlayerIdSchema.parse(row.id);
}

/**
 * Registers the key on the save and issues a refresh token bound to it. The save's own first
 * device needs no registration: its key already lives in `players`.
 */
export async function admitDevice(
  db: D1Database,
  input: {
    playerId: PlayerId;
    provider: IdentityProvider;
    deviceKey: DevicePublicKey;
    deviceJkt: string;
    firstDevice: boolean;
    now: EpochMs;
  },
): Promise<string> {
  const { playerId, provider, deviceKey, deviceJkt, firstDevice, now } = input;
  const refreshToken = newRefreshToken();
  const statements = [
    db
      .prepare(
        `INSERT INTO refresh_tokens
           (token_hash, player_id, family_id, issued_at, expires_at, device_jkt)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        await hashRefreshToken(refreshToken),
        playerId,
        crypto.randomUUID(),
        now,
        now + REFRESH_TOKEN_TTL_MS,
        firstDevice ? null : deviceJkt,
      ),
    db
      .prepare(
        `INSERT INTO account_events (player_id, kind, provider, device_jkt, at)
         VALUES (?, 'signin', ?, ?, ?)`,
      )
      .bind(playerId, provider, deviceJkt, now),
  ];
  if (!firstDevice) {
    statements.unshift(
      db
        .prepare(
          `INSERT INTO player_devices (player_id, device_jkt, device_jwk, provider, added_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (player_id, device_jkt)
           DO UPDATE SET provider = excluded.provider, added_at = excluded.added_at, revoked_at = NULL`,
        )
        .bind(playerId, deviceJkt, storedJwk(deviceKey), provider, now),
    );
  }
  await db.batch(statements);
  return refreshToken;
}

export async function isLinked(db: D1Database, playerId: PlayerId): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS linked FROM identities WHERE player_id = ? LIMIT 1')
    .bind(playerId)
    .first<{ linked: number }>();
  return row !== null;
}

function startingCoins(): number {
  const line = upgradeLines.find((candidate) => candidate.effect.stat === 'startingCoins');
  if (line === undefined) throw new Error('Economy config has no startingCoins upgrade line.');
  return upgradeStat(line, 0);
}

export interface SaveReport {
  readonly summary: SaveSummary;
  readonly hasProgress: boolean;
}

/**
 * Reads a save from its PlayerDO (authoritative) and the flushed D1 ledger. A save counts as
 * played once its ledger holds anything beyond the starting setup, or its Vault, Gold Bars or
 * upgrades differ from a fresh one, which also covers play not yet flushed to D1.
 */
export async function readSave(env: Env, playerId: PlayerId): Promise<SaveReport> {
  const result = await env.PLAYER.get(env.PLAYER.idFromName(playerId)).state({});
  if (!result.ok) {
    throw new Error(
      `Could not read save ${playerId}: ${result.error.code} ${result.error.message}`,
    );
  }
  const state = result.body;
  const placeholders = UNTOUCHED_SAVE_KINDS.map(() => '?').join(', ');
  const ledger = await env.DB.prepare(
    `SELECT MAX(at) AS last_at,
            COALESCE(SUM(CASE WHEN kind NOT IN (${placeholders}) THEN 1 ELSE 0 END), 0) AS played
       FROM ledger WHERE player_id = ?`,
  )
    .bind(...UNTOUCHED_SAVE_KINDS, playerId)
    .first<{ last_at: number | null; played: number }>();
  const vault =
    state.wallet.coins + state.table.buffer.reduce((total, coin) => total + coin.value, 0);
  const upgraded = Object.values(state.venue.upgrades).some((level) => level > 0);
  const hasProgress =
    (ledger?.played ?? 0) > 0 || state.wallet.goldBars > 0 || upgraded || vault !== startingCoins();
  return {
    summary: SaveSummarySchema.parse({
      playerId,
      venue: state.venue.id,
      goldBars: state.wallet.goldBars,
      coins: vault,
      lastPlayedAt: Math.max(ledger?.last_at ?? 0, state.player.createdAt),
    }),
    hasProgress,
  };
}
