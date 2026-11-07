import {
  DevicePublicKeySchema,
  PlayerIdSchema,
  type AuthTokens,
  type DevicePublicKey,
  type EpochMs,
  type PlayerId,
} from '@coinposh/shared';
import { sign, verify } from 'hono/jwt';
import { z } from 'zod';
import { base64UrlEncode, randomBytes, sha256Hex } from '../crypto.ts';
import { ApiFailure } from '../http/errors.ts';

export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const ISSUER = 'coinposh';
const MIN_SECRET_LENGTH = 32;

/** The access token binds the device key (`cnf.jwk`), so a stolen token alone cannot sign. */
const AccessClaimsSchema = z.object({
  iss: z.literal(ISSUER),
  typ: z.literal('access'),
  sub: PlayerIdSchema,
  iat: z.int().nonnegative(),
  exp: z.int().positive(),
  cnf: z.object({ jwk: DevicePublicKeySchema }),
});

export interface AccessGrant {
  readonly playerId: PlayerId;
  readonly deviceKey: DevicePublicKey;
}

export function authSecret(secret: string | undefined): string {
  if (secret === undefined || secret.length < MIN_SECRET_LENGTH) {
    throw new ApiFailure(
      'unavailable',
      `AUTH_SECRET is not configured: set a random secret of at least ${MIN_SECRET_LENGTH} characters with \`wrangler secret put AUTH_SECRET\`.`,
    );
  }
  return secret;
}

export async function issueAccessToken(
  secret: string,
  grant: AccessGrant,
  now: EpochMs,
): Promise<string> {
  const iat = Math.floor(now / 1000);
  return sign(
    {
      iss: ISSUER,
      typ: 'access',
      sub: grant.playerId,
      iat,
      exp: iat + ACCESS_TOKEN_TTL_MS / 1000,
      cnf: { jwk: grant.deviceKey },
    },
    secret,
    'HS256',
  );
}

export async function verifyAccessToken(
  secret: string,
  authorization: string | undefined,
  now: EpochMs,
): Promise<AccessGrant> {
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(
    authorization ?? '',
  );
  const token = match?.[1];
  if (token === undefined) {
    throw new ApiFailure('unauthorized', 'Send `Authorization: Bearer <accessToken>`.');
  }
  let payload: unknown;
  try {
    payload = await verify(token, secret, { alg: 'HS256', iss: ISSUER, exp: false, iat: false });
  } catch {
    throw new ApiFailure('unauthorized', 'The access token is invalid. Sign in again.');
  }
  const claims = AccessClaimsSchema.safeParse(payload);
  if (!claims.success) {
    throw new ApiFailure('unauthorized', 'The access token is not a CoinPosh access token.');
  }
  if (claims.data.exp * 1000 <= now) {
    throw new ApiFailure('token_expired', 'The access token expired. Refresh it and retry.');
  }
  return { playerId: claims.data.sub, deviceKey: claims.data.cnf.jwk };
}

export function newRefreshToken(): string {
  return `rt_${base64UrlEncode(randomBytes(32))}`;
}

export function hashRefreshToken(token: string): Promise<string> {
  return sha256Hex(token);
}

export async function tokenBundle(
  secret: string,
  grant: AccessGrant,
  refreshToken: string,
  now: EpochMs,
): Promise<AuthTokens> {
  return {
    playerId: grant.playerId,
    accessToken: await issueAccessToken(secret, grant, now),
    accessTokenTtlMs: ACCESS_TOKEN_TTL_MS,
    refreshToken,
  };
}
