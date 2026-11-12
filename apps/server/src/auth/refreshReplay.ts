import {
  endpoints,
  ErrorCodeSchema,
  PlayerIdSchema,
  type AuthTokens,
  type DevicePublicKey,
  type EpochMs,
  type IdempotencyKey,
} from '@coinposh/shared';
import { z } from 'zod';
import { base64UrlDecode, base64UrlEncode, randomBytes, utf8 } from '../crypto.ts';
import type { AppContext } from '../http/context.ts';
import { IDEMPOTENT_REPLAYED_HEADER } from '../http/cors.ts';
import { ApiFailure } from '../http/errors.ts';
import type { SignedRequest } from '../http/signed.ts';
import {
  ACCESS_TOKEN_TTL_MS,
  authSecret,
  hashRefreshToken,
  newRefreshToken,
  REFRESH_TOKEN_TTL_MS,
  tokenBundle,
} from './tokens.ts';

/**
 * Covers a stalled answer plus the client's retries, and stays under the access token's TTL so
 * a replayed access token still has minutes left when it arrives.
 */
export const REFRESH_REPLAY_WINDOW_MS = 10 * 60 * 1000;

const ROUTE = endpoints.authRefresh.path;
const IV_BYTES = 12;
const IN_PROGRESS_RETRY_MS = 1000;

const StoredErrorSchema = z.object({ code: ErrorCodeSchema, message: z.string().min(1) });

interface AuthRequestRow {
  route: string;
  at: number;
  fingerprint: string | null;
  response: string | null;
  error: string | null;
}

function reused(): ApiFailure {
  return new ApiFailure(
    'idempotency_key_reused',
    'This Idempotency-Key was already used for a different or expired auth request. Sign the request again with a new key.',
  );
}

async function sealingKey(secret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', utf8(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: utf8('coinposh/auth-refresh-replay/v1'),
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Bound to its row, so a sealed bundle copied onto another key or body fails to open. */
function sealParams(iv: Uint8Array<ArrayBuffer>, key: IdempotencyKey, fingerprint: string) {
  return { name: 'AES-GCM', iv, additionalData: utf8(`${ROUTE}\n${key}\n${fingerprint}`) };
}

async function seal(
  secret: string,
  key: IdempotencyKey,
  fingerprint: string,
  tokens: AuthTokens,
): Promise<string> {
  const iv = randomBytes(IV_BYTES);
  const sealed = await crypto.subtle.encrypt(
    sealParams(iv, key, fingerprint),
    await sealingKey(secret),
    utf8(JSON.stringify(tokens)),
  );
  const out = new Uint8Array(IV_BYTES + sealed.byteLength);
  out.set(iv);
  out.set(new Uint8Array(sealed), IV_BYTES);
  return base64UrlEncode(out);
}

async function open(
  secret: string,
  key: IdempotencyKey,
  fingerprint: string,
  sealed: string,
): Promise<AuthTokens> {
  const bytes = base64UrlDecode(sealed);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      sealParams(bytes.slice(0, IV_BYTES), key, fingerprint),
      await sealingKey(secret),
      bytes.slice(IV_BYTES),
    );
  } catch {
    throw new ApiFailure(
      'idempotency_key_reused',
      'The answer kept for this Idempotency-Key no longer opens (AUTH_SECRET changed?). Sign the request again with a new key.',
    );
  }
  return endpoints.authRefresh.response.parse(JSON.parse(new TextDecoder().decode(plain)));
}

async function replay(
  c: AppContext,
  secret: string,
  key: IdempotencyKey,
  fingerprint: string,
  now: EpochMs,
): Promise<AuthTokens> {
  const row = await c.env.DB.prepare(
    'SELECT route, at, fingerprint, response, error FROM auth_requests WHERE idempotency_key = ?',
  )
    .bind(key)
    .first<AuthRequestRow>();
  if (row === null) {
    throw new ApiFailure(
      'idempotency_in_progress',
      'The first refresh with this Idempotency-Key failed before finishing. Retry with the same key.',
      { retryAfterMs: IN_PROGRESS_RETRY_MS },
    );
  }
  if (row.route !== ROUTE || row.fingerprint !== fingerprint) throw reused();
  if (now - row.at > REFRESH_REPLAY_WINDOW_MS) throw reused();
  if (row.error !== null) {
    const first = StoredErrorSchema.parse(JSON.parse(row.error));
    throw new ApiFailure(first.code, first.message);
  }
  if (row.response === null) {
    throw new ApiFailure(
      'idempotency_in_progress',
      'A refresh with this Idempotency-Key is still running. Retry shortly with the same key.',
      { retryAfterMs: IN_PROGRESS_RETRY_MS },
    );
  }
  const tokens = await open(secret, key, fingerprint, row.response);
  const issued = await c.env.DB.prepare(
    'SELECT expires_at, rotated_at, revoked_at FROM refresh_tokens WHERE token_hash = ?',
  )
    .bind(await hashRefreshToken(tokens.refreshToken))
    .first<{ expires_at: number; rotated_at: number | null; revoked_at: number | null }>();
  if (issued?.revoked_at !== null || issued.expires_at <= now) {
    throw new ApiFailure(
      'unauthorized',
      'The session this refresh issued was revoked since. Sign in again.',
    );
  }
  if (issued.rotated_at !== null) {
    throw new ApiFailure(
      'idempotency_key_reused',
      'The refresh token this request issued was already refreshed again, so its answer is stale. Sign the request again with a new key.',
    );
  }
  return { ...tokens, accessTokenTtlMs: ACCESS_TOKEN_TTL_MS - (now - row.at) };
}

export interface PresentedRefreshToken {
  readonly token_hash: string;
  readonly player_id: string;
  readonly family_id: string;
  readonly expires_at: number;
  readonly rotated_at: number | null;
  readonly revoked_at: number | null;
  readonly device_jkt: string | null;
}

/** Only a copy of an already-rotated token gets here: treat the family as stolen. */
async function revokeFamily(c: AppContext, familyId: string, now: EpochMs): Promise<ApiFailure> {
  await c.env.DB.prepare(
    'UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL',
  )
    .bind(now, familyId)
    .run();
  return new ApiFailure(
    'unauthorized',
    'This refresh token was already used, so its session was revoked. Sign in again.',
  );
}

/**
 * Rotates `presented` at most once per Idempotency-Key. A resend of the same signed request
 * within the window gets the first answer back rather than rotating the spent token again, which
 * would revoke the family. Handing the bundle out twice is safe: the caller has already checked
 * the device signature, and both tokens are useless without that device key. The rotation, the
 * new token and the sealed answer commit in one batch, so a claim without an answer always means
 * nothing rotated. `refusal` is a caller's reason to refuse, kept on the claim like any other.
 */
export async function refreshOnce(
  c: AppContext,
  request: SignedRequest,
  key: IdempotencyKey,
  now: EpochMs,
  presented: PresentedRefreshToken,
  deviceKey: DevicePublicKey,
  refusal: ApiFailure | null = null,
): Promise<Response> {
  const secret = authSecret(c.env.AUTH_SECRET);
  const db = c.env.DB;
  const fingerprint = request.bodySha256;
  const claimed = await db
    .prepare(
      'INSERT OR IGNORE INTO auth_requests (idempotency_key, route, at, fingerprint) VALUES (?, ?, ?, ?)',
    )
    .bind(key, ROUTE, now, fingerprint)
    .run();
  if (claimed.meta.changes !== 1) {
    const tokens = await replay(c, secret, key, fingerprint, now);
    c.header(IDEMPOTENT_REPLAYED_HEADER, 'true');
    return c.json(endpoints.authRefresh.response.parse(tokens));
  }

  try {
    if (refusal !== null) throw refusal;
    if (presented.revoked_at !== null || presented.expires_at <= now) {
      throw new ApiFailure('unauthorized', 'This refresh token is no longer valid. Sign in again.');
    }
    if (presented.rotated_at !== null) throw await revokeFamily(c, presented.family_id, now);

    const playerId = PlayerIdSchema.parse(presented.player_id);
    const refreshToken = newRefreshToken();
    const tokens = endpoints.authRefresh.response.parse(
      await tokenBundle(secret, { playerId, deviceKey }, refreshToken, now),
    );
    const sealed = await seal(secret, key, fingerprint, tokens);
    const [rotated] = await db.batch([
      db
        .prepare(
          'UPDATE refresh_tokens SET rotated_at = ? WHERE token_hash = ? AND rotated_at IS NULL AND revoked_at IS NULL',
        )
        .bind(now, presented.token_hash),
      db
        .prepare(
          `INSERT INTO refresh_tokens
             (token_hash, player_id, family_id, issued_at, expires_at, device_jkt)
           SELECT ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
        )
        .bind(
          await hashRefreshToken(refreshToken),
          playerId,
          presented.family_id,
          now,
          now + REFRESH_TOKEN_TTL_MS,
          presented.device_jkt,
        ),
      db
        .prepare(
          'UPDATE auth_requests SET response = ? WHERE idempotency_key = ? AND changes() = 1',
        )
        .bind(sealed, key),
    ]);
    if (rotated?.meta.changes !== 1) throw await revokeFamily(c, presented.family_id, now);
    return c.json(tokens);
  } catch (error) {
    if (error instanceof ApiFailure) {
      await db
        .prepare('UPDATE auth_requests SET error = ? WHERE idempotency_key = ?')
        .bind(JSON.stringify({ code: error.code, message: error.message }), key)
        .run();
    } else {
      // Nothing rotated while the claim has no answer, so a retry can safely run afresh.
      await db
        .prepare('DELETE FROM auth_requests WHERE idempotency_key = ? AND response IS NULL')
        .bind(key)
        .run();
    }
    throw error;
  }
}
