import { z } from 'zod';
import { PlayerIdSchema, VenueIdSchema } from '../ids.ts';
import { AmountSchema, EpochMsSchema } from '../primitives.ts';
import { AuthTokensSchema, DevicePublicKeySchema } from './auth.ts';

export const IDENTITY_PROVIDERS = ['google', 'apple'] as const;
export const IdentityProviderSchema = z.enum(IDENTITY_PROVIDERS);
export type IdentityProvider = z.infer<typeof IdentityProviderSchema>;

/** A compact-serialized JWS as Google Identity Services and Sign in with Apple JS return it. */
export const IdTokenSchema = z
  .string()
  .max(8192)
  .regex(
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
    'Expected an OpenID Connect ID token: three base64url segments joined by dots.',
  );
export type IdToken = z.infer<typeof IdTokenSchema>;

/** Server-issued, single-use and short-lived; the provider echoes it in the ID token's `nonce` claim. */
export const AccountNonceSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9_-]{32,128}$/,
    'Expected a server-issued nonce: 32 to 128 base64url characters.',
  );
export type AccountNonce = z.infer<typeof AccountNonceSchema>;

/** A nonce minted for linking cannot be spent on a sign-in, and the other way round. */
export const NONCE_PURPOSES = ['link', 'signin'] as const;
export const NoncePurposeSchema = z.enum(NONCE_PURPOSES);
export type NoncePurpose = z.infer<typeof NoncePurposeSchema>;

export const AccountNonceRequestSchema = z.strictObject({
  provider: IdentityProviderSchema,
  purpose: NoncePurposeSchema,
});
export type AccountNonceRequest = z.infer<typeof AccountNonceRequestSchema>;

export const AccountNonceResponseSchema = z.object({
  nonce: AccountNonceSchema,
  expiresAt: EpochMsSchema,
});
export type AccountNonceResponse = z.infer<typeof AccountNonceResponseSchema>;

export const LinkedIdentitySchema = z.object({
  provider: IdentityProviderSchema,
  linkedAt: EpochMsSchema,
  /** Masked by the server (`l•••@gmail.com`); absent when the provider shares no email. */
  emailHint: z.string().min(1).max(128).optional(),
});
export type LinkedIdentity = z.infer<typeof LinkedIdentitySchema>;

export const AccountSchema = z.object({
  playerId: PlayerIdSchema,
  identities: z
    .array(LinkedIdentitySchema)
    .max(IDENTITY_PROVIDERS.length)
    .refine(
      (identities) =>
        new Set(identities.map((identity) => identity.provider)).size === identities.length,
      'A player links each provider at most once.',
    ),
  /** Providers the server can verify right now; the others answer `provider_unavailable`. */
  available: z.array(IdentityProviderSchema).max(IDENTITY_PROVIDERS.length),
});
export type Account = z.infer<typeof AccountSchema>;

export const AccountResponseSchema = AccountSchema;
export type AccountResponse = z.infer<typeof AccountResponseSchema>;

export const AccountLinkRequestSchema = z.strictObject({
  provider: IdentityProviderSchema,
  idToken: IdTokenSchema,
  nonce: AccountNonceSchema,
});
export type AccountLinkRequest = z.infer<typeof AccountLinkRequestSchema>;

export const AccountLinkResponseSchema = AccountSchema;
export type AccountLinkResponse = z.infer<typeof AccountLinkResponseSchema>;

export const AccountUnlinkRequestSchema = z.strictObject({
  provider: IdentityProviderSchema,
});
export type AccountUnlinkRequest = z.infer<typeof AccountUnlinkRequestSchema>;

export const AccountUnlinkResponseSchema = AccountSchema;
export type AccountUnlinkResponse = z.infer<typeof AccountUnlinkResponseSchema>;

/** What the progress-choice sheet compares; read from server state, never from the client. */
export const SaveSummarySchema = z.object({
  playerId: PlayerIdSchema,
  venue: VenueIdSchema,
  goldBars: AmountSchema,
  coins: AmountSchema,
  lastPlayedAt: EpochMsSchema,
});
export type SaveSummary = z.infer<typeof SaveSummarySchema>;

/**
 * Present when the signing-in device already holds a different, unlinked guest with progress.
 * The saves are never merged: the client either keeps the returned session (`account`) or
 * discards it and plays on as `guest`.
 */
export const ProgressChoiceSchema = z
  .object({
    guest: SaveSummarySchema,
    account: SaveSummarySchema,
  })
  .refine(
    (choice) => choice.guest.playerId !== choice.account.playerId,
    'A progress choice compares two different players.',
  );
export type ProgressChoice = z.infer<typeof ProgressChoiceSchema>;

/** Device-signed with the key in the body, like a guest sign-up; it registers that key on the account. */
export const SignInRequestSchema = z.strictObject({
  provider: IdentityProviderSchema,
  idToken: IdTokenSchema,
  nonce: AccountNonceSchema,
  devicePublicKey: DevicePublicKeySchema,
});
export type SignInRequest = z.infer<typeof SignInRequestSchema>;

export const SignInResponseSchema = AuthTokensSchema.extend({
  account: AccountSchema,
  choice: ProgressChoiceSchema.optional(),
}).refine(
  (response) =>
    response.account.playerId === response.playerId &&
    (response.choice === undefined || response.choice.account.playerId === response.playerId),
  'The account and its side of the choice must belong to the signed-in player.',
);
export type SignInResponse = z.infer<typeof SignInResponseSchema>;
