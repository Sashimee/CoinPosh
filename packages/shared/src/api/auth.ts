import { z } from 'zod';
import { PlayerIdSchema } from '../ids.ts';
import { DurationMsSchema, LocaleSchema } from '../primitives.ts';

const P256_COORDINATE = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, 'Expected a 32-byte P-256 coordinate as base64url.');

/**
 * The public half of the device's non-extractable WebCrypto ECDSA key, as
 * `crypto.subtle.exportKey('jwk', publicKey)` returns it. Strict, so a JWK carrying
 * the private scalar `d` is rejected rather than silently accepted.
 */
export const DevicePublicKeySchema = z.strictObject({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  x: P256_COORDINATE,
  y: P256_COORDINATE,
  ext: z.boolean().optional(),
  key_ops: z.array(z.literal('verify')).optional(),
});
export type DevicePublicKey = z.infer<typeof DevicePublicKeySchema>;

export const GuestAuthRequestSchema = z.strictObject({
  devicePublicKey: DevicePublicKeySchema,
  turnstileToken: z.string().min(1).max(2048),
  locale: LocaleSchema,
});
export type GuestAuthRequest = z.infer<typeof GuestAuthRequestSchema>;

export const AuthTokensSchema = z.object({
  playerId: PlayerIdSchema,
  accessToken: z.string().min(1).max(4096),
  accessTokenTtlMs: DurationMsSchema.positive(),
  refreshToken: z.string().min(32).max(512),
});
export type AuthTokens = z.infer<typeof AuthTokensSchema>;

export const GuestAuthResponseSchema = AuthTokensSchema;
export type GuestAuthResponse = z.infer<typeof GuestAuthResponseSchema>;

export const RefreshRequestSchema = z.strictObject({
  refreshToken: z.string().min(32).max(512),
});
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

/** Refresh tokens rotate: the response always carries a new one and the old one is revoked. */
export const RefreshResponseSchema = AuthTokensSchema;
export type RefreshResponse = z.infer<typeof RefreshResponseSchema>;
