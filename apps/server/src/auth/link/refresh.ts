import { DevicePublicKeySchema, endpoints, PlayerIdSchema } from '@coinposh/shared';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../../http/context.ts';
import { ApiFailure } from '../../http/errors.ts';
import {
  readSignedRequest,
  requireIdempotencyKey,
  verifySigned,
  type SignedRequest,
} from '../../http/signed.ts';
import {
  authSecret,
  hashRefreshToken,
  newRefreshToken,
  REFRESH_TOKEN_TTL_MS,
  tokenBundle,
} from '../tokens.ts';
import { refreshOnce } from '../refreshReplay.ts';

interface LinkedTokenRow {
  token_hash: string;
  player_id: string;
  family_id: string;
  expires_at: number;
  rotated_at: number | null;
  revoked_at: number | null;
  device_jkt: string;
  device_jwk: string | null;
  device_revoked_at: number | null;
}

async function peekSignedRequest(c: Parameters<MiddlewareHandler<AppEnv>>[0]) {
  const original = c.req.raw;
  c.req.raw = original.clone();
  try {
    return await readSignedRequest(c);
  } finally {
    c.req.raw = original;
  }
}

function parseRefreshToken(request: SignedRequest): string | null {
  try {
    const parsed = endpoints.authRefresh.body.safeParse(JSON.parse(request.rawBody));
    return parsed.success ? parsed.data.refreshToken : null;
  } catch {
    return null;
  }
}

/**
 * Refresh for devices that signed in to a save. Their tokens are bound to the key in
 * `player_devices` rather than the save's first key, so this answers them and hands every other
 * refresh token, untouched, to the guest refresh route behind it. Rotation and reuse rules are
 * the same: presenting a rotated token again revokes its family.
 */
export const linkedDeviceRefresh: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method !== 'POST') return next();
  const request = await peekSignedRequest(c);
  const presented = parseRefreshToken(request);
  if (presented === null) return next();
  const row = await c.env.DB.prepare(
    `SELECT t.token_hash, t.player_id, t.family_id, t.expires_at, t.rotated_at, t.revoked_at,
            t.device_jkt, d.device_jwk, d.revoked_at AS device_revoked_at
       FROM refresh_tokens t
       LEFT JOIN player_devices d ON d.player_id = t.player_id AND d.device_jkt = t.device_jkt
      WHERE t.token_hash = ? AND t.device_jkt IS NOT NULL`,
  )
    .bind(await hashRefreshToken(presented))
    .first<LinkedTokenRow>();
  if (row === null) return next();
  if (row.device_jwk === null) {
    throw new ApiFailure(
      'unauthorized',
      'This device is not registered on the save. Sign in again.',
    );
  }

  const secret = authSecret(c.env.AUTH_SECRET);
  const idempotencyKey = requireIdempotencyKey(request);
  const deviceKey = DevicePublicKeySchema.parse(JSON.parse(row.device_jwk));
  await verifySigned(c, request, deviceKey);
  const now = Date.now();

  return refreshOnce(c, request, idempotencyKey, now, async () => {
    if (row.device_revoked_at !== null) {
      throw new ApiFailure(
        'unauthorized',
        'This device was signed out when its sign-in was unlinked. Sign in again.',
      );
    }
    if (row.revoked_at !== null || row.expires_at <= now) {
      throw new ApiFailure('unauthorized', 'This refresh token is no longer valid. Sign in again.');
    }
    const rotated = await c.env.DB.prepare(
      'UPDATE refresh_tokens SET rotated_at = ? WHERE token_hash = ? AND rotated_at IS NULL AND revoked_at IS NULL',
    )
      .bind(now, row.token_hash)
      .run();
    if (row.rotated_at !== null || rotated.meta.changes !== 1) {
      await c.env.DB.prepare(
        'UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL',
      )
        .bind(now, row.family_id)
        .run();
      throw new ApiFailure(
        'unauthorized',
        'This refresh token was already used, so its session was revoked. Sign in again.',
      );
    }

    const playerId = PlayerIdSchema.parse(row.player_id);
    const refreshToken = newRefreshToken();
    await c.env.DB.prepare(
      `INSERT INTO refresh_tokens (token_hash, player_id, family_id, issued_at, expires_at, device_jkt)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        await hashRefreshToken(refreshToken),
        playerId,
        row.family_id,
        now,
        now + REFRESH_TOKEN_TTL_MS,
        row.device_jkt,
      )
      .run();
    return tokenBundle(secret, { playerId, deviceKey }, refreshToken, now);
  });
};
