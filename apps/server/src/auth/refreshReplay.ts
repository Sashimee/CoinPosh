import {
  endpoints,
  ErrorCodeSchema,
  type AuthTokens,
  type EpochMs,
  type IdempotencyKey,
} from '@coinposh/shared';
import { z } from 'zod';
import { base64UrlDecode, base64UrlEncode, randomBytes, utf8 } from '../crypto.ts';
import type { AppContext } from '../http/context.ts';
import { IDEMPOTENT_REPLAYED_HEADER } from '../http/cors.ts';
import { ApiFailure } from '../http/errors.ts';
import type { SignedRequest } from '../http/signed.ts';
import { ACCESS_TOKEN_TTL_MS, authSecret, hashRefreshToken } from './tokens.ts';

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
    'SELECT expires_at, revoked_at FROM refresh_tokens WHERE token_hash = ?',
  )
    .bind(await hashRefreshToken(tokens.refreshToken))
    .first<{ expires_at: number; revoked_at: number | null }>();
  if (issued?.revoked_at !== null || issued.expires_at <= now) {
    throw new ApiFailure(
      'unauthorized',
      'The session this refresh issued was revoked since. Sign in again.',
    );
  }
  return { ...tokens, accessTokenTtlMs: ACCESS_TOKEN_TTL_MS - (now - row.at) };
}

/**
 * Runs `rotate` at most once per Idempotency-Key. A resend of the same signed request within
 * the window gets the first answer back rather than rotating the spent token again, which would
 * revoke the family. Handing the bundle out twice is safe: the caller has already checked the
 * device signature, and both tokens are useless without that device key.
 */
export async function refreshOnce(
  c: AppContext,
  request: SignedRequest,
  key: IdempotencyKey,
  now: EpochMs,
  rotate: () => Promise<AuthTokens>,
): Promise<Response> {
  const secret = authSecret(c.env.AUTH_SECRET);
  const fingerprint = request.bodySha256;
  const claimed = await c.env.DB.prepare(
    'INSERT OR IGNORE INTO auth_requests (idempotency_key, route, at, fingerprint) VALUES (?, ?, ?, ?)',
  )
    .bind(key, ROUTE, now, fingerprint)
    .run();
  if (claimed.meta.changes !== 1) {
    const tokens = await replay(c, secret, key, fingerprint, now);
    c.header(IDEMPOTENT_REPLAYED_HEADER, 'true');
    return c.json(endpoints.authRefresh.response.parse(tokens));
  }

  let tokens: AuthTokens;
  try {
    tokens = endpoints.authRefresh.response.parse(await rotate());
  } catch (error) {
    if (error instanceof ApiFailure) {
      await c.env.DB.prepare('UPDATE auth_requests SET error = ? WHERE idempotency_key = ?')
        .bind(JSON.stringify({ code: error.code, message: error.message }), key)
        .run();
    } else {
      // An unexpected failure may have stopped before rotating: free the key so a retry runs.
      await c.env.DB.prepare('DELETE FROM auth_requests WHERE idempotency_key = ?').bind(key).run();
    }
    throw error;
  }
  await c.env.DB.prepare('UPDATE auth_requests SET response = ? WHERE idempotency_key = ?')
    .bind(await seal(secret, key, fingerprint, tokens), key)
    .run();
  return c.json(tokens);
}
