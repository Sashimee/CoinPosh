import {
  AccountNonceSchema,
  type AccountNonce,
  type EpochMs,
  type IdentityProvider,
  type NoncePurpose,
  type PlayerId,
} from '@coinposh/shared';
import { base64UrlEncode, randomBytes } from '../../crypto.ts';
import { ApiFailure } from '../../http/errors.ts';

export const ACCOUNT_NONCE_TTL_MS = 10 * 60 * 1000;
/** Unspent nonces one device may hold at once; a real sign-in sheet needs one or two. */
export const MAX_OPEN_NONCES_PER_DEVICE = 6;

export interface IssuedNonce {
  readonly nonce: AccountNonce;
  readonly expiresAt: EpochMs;
}

export async function issueNonce(
  db: D1Database,
  input: { provider: IdentityProvider; purpose: NoncePurpose; deviceJkt: string; now: EpochMs },
): Promise<IssuedNonce> {
  const { provider, purpose, deviceJkt, now } = input;
  await db.prepare('DELETE FROM account_nonces WHERE expires_at <= ?').bind(now).run();
  const open = await db
    .prepare(
      `SELECT COUNT(*) AS open, MIN(expires_at) AS first_expiry FROM account_nonces
        WHERE device_jkt = ? AND consumed_at IS NULL AND expires_at > ?`,
    )
    .bind(deviceJkt, now)
    .first<{ open: number; first_expiry: number | null }>();
  if (open !== null && open.open >= MAX_OPEN_NONCES_PER_DEVICE) {
    throw new ApiFailure(
      'rate_limited',
      'Too many sign-in attempts from this device. Finish or wait for one to expire.',
      { retryAfterMs: Math.max(1000, (open.first_expiry ?? now) - now) },
    );
  }
  const nonce = AccountNonceSchema.parse(base64UrlEncode(randomBytes(32)));
  const expiresAt = now + ACCOUNT_NONCE_TTL_MS;
  await db
    .prepare(
      `INSERT INTO account_nonces (nonce, provider, purpose, device_jkt, issued_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(nonce, provider, purpose, deviceJkt, now, expiresAt)
    .run();
  return { nonce, expiresAt };
}

export interface NonceSpend {
  readonly nonce: AccountNonce;
  readonly provider: IdentityProvider;
  readonly purpose: NoncePurpose;
  readonly deviceJkt: string;
  readonly now: EpochMs;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly playerId: PlayerId | null;
}

interface NonceRow {
  provider: string;
  purpose: string;
  device_jkt: string;
  expires_at: number;
  consumed_at: number | null;
  consumed_key: string | null;
  consumed_fingerprint: string | null;
  consumed_player: string | null;
}

function rejected(message: string): ApiFailure {
  return new ApiFailure('invalid_id_token', message);
}

/**
 * Spends the nonce in one conditional write, so two concurrent requests can never both succeed.
 * Returns `replay` only for a retry of the exact request that spent it (same key, same bytes,
 * same player); every other second use is refused.
 */
export async function spendNonce(db: D1Database, spend: NonceSpend): Promise<'spent' | 'replay'> {
  const result = await db
    .prepare(
      `UPDATE account_nonces
          SET consumed_at = ?, consumed_key = ?, consumed_fingerprint = ?, consumed_player = ?
        WHERE nonce = ? AND provider = ? AND purpose = ? AND device_jkt = ?
          AND consumed_at IS NULL AND expires_at > ?`,
    )
    .bind(
      spend.now,
      spend.idempotencyKey,
      spend.fingerprint,
      spend.playerId,
      spend.nonce,
      spend.provider,
      spend.purpose,
      spend.deviceJkt,
      spend.now,
    )
    .run();
  if (result.meta.changes === 1) return 'spent';

  const row = await db
    .prepare(
      `SELECT provider, purpose, device_jkt, expires_at, consumed_at, consumed_key,
              consumed_fingerprint, consumed_player
         FROM account_nonces WHERE nonce = ?`,
    )
    .bind(spend.nonce)
    .first<NonceRow>();
  if (row === null) {
    throw rejected('This sign-in nonce is unknown or expired. Request a new one and retry.');
  }
  if (row.provider !== spend.provider || row.purpose !== spend.purpose) {
    throw rejected(`This nonce was issued for a different sign-in. Request a new one.`);
  }
  if (row.device_jkt !== spend.deviceJkt) {
    throw rejected('This nonce was issued to another device.');
  }
  if (row.consumed_at !== null && row.consumed_key === spend.idempotencyKey) {
    if (row.consumed_fingerprint !== spend.fingerprint || row.consumed_player !== spend.playerId) {
      throw new ApiFailure(
        'idempotency_key_reused',
        'This Idempotency-Key already sent a different request. Use a new key.',
      );
    }
    return 'replay';
  }
  if (row.consumed_at !== null) {
    throw rejected('This sign-in was already used. Request a new nonce and sign in again.');
  }
  throw rejected('This sign-in nonce expired. Request a new one and retry.');
}
