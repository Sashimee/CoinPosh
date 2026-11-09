import type { EpochMs, IdentityProvider } from '@coinposh/shared';
import { z } from 'zod';
import { base64UrlDecode, sha256Hex, utf8 } from '../../crypto.ts';
import { ApiFailure } from '../../http/errors.ts';
import type { JwksCache } from './jwks.ts';
import type { ReadyProvider } from './providers.ts';

/** How far ahead of the server clock a token's `iat` may sit before it reads as forged. */
export const ID_TOKEN_IAT_LEEWAY_MS = 60 * 1000;

const HeaderSchema = z.object({
  alg: z.string(),
  kid: z.string().min(1).max(256),
});

const ClaimsSchema = z.object({
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string()).min(1).max(8)]),
  azp: z.string().optional(),
  sub: z.string().min(1).max(255),
  exp: z.number().int().positive(),
  iat: z.number().int().nonnegative(),
  nonce: z.string().max(256).optional(),
  email: z.string().max(320).optional(),
  email_verified: z.union([z.boolean(), z.enum(['true', 'false'])]).optional(),
});

export interface VerifiedIdToken {
  readonly provider: IdentityProvider;
  readonly subject: string;
  readonly nonce: string | null;
  /** `l•••@gmail.com`; only for a provider-verified address, and never stored in full. */
  readonly emailHint: string | null;
}

function invalid(message: string): ApiFailure {
  return new ApiFailure('invalid_id_token', message);
}

function decodeJson(segment: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlDecode(segment)));
  } catch {
    return undefined;
  }
}

export function maskEmail(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return null;
  const hint = `${email.slice(0, 1)}•••${email.slice(at)}`;
  return hint.length <= 128 ? hint : null;
}

/**
 * Verifies an OpenID Connect ID token against the provider's published keys: RS256 only (no
 * `none`, no HMAC with a public key as secret), then `iss`, `aud` (and `azp` when several
 * audiences are named), `exp` and `iat` against the server clock.
 */
export async function verifyIdToken(
  idToken: string,
  provider: ReadyProvider,
  jwks: JwksCache,
  now: EpochMs,
): Promise<VerifiedIdToken> {
  const { config, audience } = provider;
  const segments = idToken.split('.');
  const [headerPart, payloadPart, signaturePart] = segments;
  if (
    segments.length !== 3 ||
    headerPart === undefined ||
    payloadPart === undefined ||
    signaturePart === undefined
  ) {
    throw invalid('The ID token is not a compact JWS.');
  }
  const header = HeaderSchema.safeParse(decodeJson(headerPart));
  if (!header.success) throw invalid('The ID token header is unreadable or names no `kid`.');
  if (header.data.alg !== 'RS256') {
    throw invalid(`${config.label} ID tokens are RS256-signed; \`${header.data.alg}\` is refused.`);
  }
  const key = await jwks.key(config.jwksUrl, header.data.kid, config.label);
  if (key === null) {
    throw invalid(`The ID token is signed with a key ${config.label} does not publish.`);
  }
  const genuine = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    base64UrlDecode(signaturePart),
    utf8(`${headerPart}.${payloadPart}`),
  );
  if (!genuine) throw invalid(`The ID token signature does not verify against ${config.label}.`);

  const claims = ClaimsSchema.safeParse(decodeJson(payloadPart));
  if (!claims.success) throw invalid('The ID token is missing required OpenID Connect claims.');
  const { iss, aud, azp, sub, exp, iat, nonce, email, email_verified } = claims.data;
  if (!config.issuers.includes(iss)) {
    throw invalid(`The ID token was not issued by ${config.label}.`);
  }
  const audiences = typeof aud === 'string' ? [aud] : aud;
  if (!audiences.includes(audience) || (audiences.length > 1 && azp !== audience)) {
    throw invalid(`The ID token was issued for another app, not CoinPosh.`);
  }
  if (exp * 1000 <= now) {
    throw invalid(`The ${config.label} sign-in expired. Sign in again.`);
  }
  if (iat * 1000 > now + ID_TOKEN_IAT_LEEWAY_MS) {
    throw invalid('The ID token claims to be issued in the future.');
  }
  const verified = email_verified === true || email_verified === 'true';
  return {
    provider: config.id,
    subject: sub,
    nonce: nonce ?? null,
    emailHint: email !== undefined && verified ? maskEmail(email) : null,
  };
}

/** True when the token was minted for exactly the nonce the client presents. */
export async function nonceMatches(
  provider: ReadyProvider,
  token: VerifiedIdToken,
  nonce: string,
): Promise<boolean> {
  if (token.nonce === null) return false;
  if (token.nonce === nonce) return true;
  return provider.config.acceptsHashedNonce && token.nonce === (await sha256Hex(nonce));
}
