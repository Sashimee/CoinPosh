import {
  DevicePublicKeySchema,
  endpoints,
  PlayerIdSchema,
  type DevicePublicKey,
  type EpochMs,
  type IdempotencyKey,
  type PlayerId,
} from '@coinposh/shared';
import { Hono } from 'hono';
import { deviceKeyThumbprint } from '../auth/device.ts';
import {
  authSecret,
  hashRefreshToken,
  newRefreshToken,
  REFRESH_TOKEN_TTL_MS,
  tokenBundle,
  type AccessGrant,
} from '../auth/tokens.ts';
import { verifyTurnstile } from '../auth/turnstile.ts';
import { randomBase62 } from '../crypto.ts';
import type { AppContext, AppEnv } from '../http/context.ts';
import { ApiFailure } from '../http/errors.ts';
import {
  parseBody,
  readSignedRequest,
  requireIdempotencyKey,
  verifySigned,
} from '../http/signed.ts';

export const authRoutes = new Hono<AppEnv>();

const GUEST_TAG_LENGTH = 4;

/** Burns the key; a captured, validly signed auth request can therefore be used only once. */
async function consumeAuthKey(c: AppContext, key: IdempotencyKey, route: string): Promise<void> {
  const result = await c.env.DB.prepare(
    'INSERT OR IGNORE INTO auth_requests (idempotency_key, route, at) VALUES (?, ?, ?)',
  )
    .bind(key, route, Date.now())
    .run();
  if (result.meta.changes !== 1) {
    throw new ApiFailure(
      'idempotency_key_reused',
      'This Idempotency-Key was already used to sign in. Sign the request again with a new key.',
    );
  }
}

async function issueRefreshToken(
  c: AppContext,
  playerId: PlayerId,
  familyId: string,
  now: EpochMs,
): Promise<string> {
  const token = newRefreshToken();
  await c.env.DB.prepare(
    `INSERT INTO refresh_tokens (token_hash, player_id, family_id, issued_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(await hashRefreshToken(token), playerId, familyId, now, now + REFRESH_TOKEN_TTL_MS)
    .run();
  return token;
}

async function findOrCreatePlayer(
  c: AppContext,
  deviceKey: DevicePublicKey,
  locale: string,
  now: EpochMs,
): Promise<{ playerId: PlayerId; displayName: string; createdAt: EpochMs }> {
  const jkt = await deviceKeyThumbprint(deviceKey);
  const candidate = {
    playerId: PlayerIdSchema.parse(crypto.randomUUID()),
    // A locale-neutral tag: the client renders it as t('player.guestName', { tag }).
    displayName: randomBase62(GUEST_TAG_LENGTH).toUpperCase(),
    createdAt: now,
  };
  await c.env.DB.prepare(
    `INSERT INTO players (id, device_jkt, device_jwk, display_name, locale, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (device_jkt) DO NOTHING`,
  )
    .bind(
      candidate.playerId,
      jkt,
      JSON.stringify({ kty: deviceKey.kty, crv: deviceKey.crv, x: deviceKey.x, y: deviceKey.y }),
      candidate.displayName,
      locale,
      now,
    )
    .run();
  const row = await c.env.DB.prepare(
    'SELECT id, display_name, created_at FROM players WHERE device_jkt = ?',
  )
    .bind(jkt)
    .first<{ id: string; display_name: string; created_at: number }>();
  if (row === null) throw new Error('Player row vanished right after it was written.');
  return {
    playerId: PlayerIdSchema.parse(row.id),
    displayName: row.display_name,
    createdAt: row.created_at,
  };
}

authRoutes.post(endpoints.authGuest.path, async (c) => {
  const secret = authSecret(c.env.AUTH_SECRET);
  const request = await readSignedRequest(c);
  const idempotencyKey = requireIdempotencyKey(request);
  const body = parseBody(endpoints.authGuest.body, request.rawBody);
  await verifySigned(c, request, body.devicePublicKey);
  await verifyTurnstile(
    c.env.TURNSTILE_MODE,
    c.env.TURNSTILE_SECRET_KEY,
    body.turnstileToken,
    c.req.header('CF-Connecting-IP'),
    idempotencyKey,
  );
  await consumeAuthKey(c, idempotencyKey, endpoints.authGuest.path);

  const now = Date.now();
  const player = await findOrCreatePlayer(c, body.devicePublicKey, body.locale, now);
  const stub = c.env.PLAYER.get(c.env.PLAYER.idFromName(player.playerId));
  await stub.init({
    playerId: player.playerId,
    displayName: player.displayName,
    locale: body.locale,
    createdAt: player.createdAt,
  });
  const refreshToken = await issueRefreshToken(c, player.playerId, crypto.randomUUID(), now);
  const grant: AccessGrant = { playerId: player.playerId, deviceKey: body.devicePublicKey };
  return c.json(
    endpoints.authGuest.response.parse(await tokenBundle(secret, grant, refreshToken, now)),
  );
});

authRoutes.post(endpoints.authRefresh.path, async (c) => {
  const secret = authSecret(c.env.AUTH_SECRET);
  const request = await readSignedRequest(c);
  const idempotencyKey = requireIdempotencyKey(request);
  const body = parseBody(endpoints.authRefresh.body, request.rawBody);
  const now = Date.now();

  const row = await c.env.DB.prepare(
    `SELECT t.token_hash, t.player_id, t.family_id, t.expires_at, t.rotated_at, t.revoked_at,
            p.device_jwk
       FROM refresh_tokens t JOIN players p ON p.id = t.player_id
      WHERE t.token_hash = ?`,
  )
    .bind(await hashRefreshToken(body.refreshToken))
    .first<{
      token_hash: string;
      player_id: string;
      family_id: string;
      expires_at: number;
      rotated_at: number | null;
      revoked_at: number | null;
      device_jwk: string;
    }>();
  if (row === null) {
    throw new ApiFailure('unauthorized', 'Unknown refresh token. Sign in again as a guest.');
  }
  const deviceKey = DevicePublicKeySchema.parse(JSON.parse(row.device_jwk));
  await verifySigned(c, request, deviceKey);
  await consumeAuthKey(c, idempotencyKey, endpoints.authRefresh.path);

  if (row.revoked_at !== null || row.expires_at <= now) {
    throw new ApiFailure('unauthorized', 'This refresh token is no longer valid. Sign in again.');
  }
  const rotated = await c.env.DB.prepare(
    'UPDATE refresh_tokens SET rotated_at = ? WHERE token_hash = ? AND rotated_at IS NULL AND revoked_at IS NULL',
  )
    .bind(now, row.token_hash)
    .run();
  if (row.rotated_at !== null || rotated.meta.changes !== 1) {
    // Only a copy of an already-rotated token gets here: treat the family as stolen.
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
  const refreshToken = await issueRefreshToken(c, playerId, row.family_id, now);
  return c.json(
    endpoints.authRefresh.response.parse(
      await tokenBundle(secret, { playerId, deviceKey }, refreshToken, now),
    ),
  );
});
