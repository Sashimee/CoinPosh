import { IDENTITY_PROVIDERS, type IdentityProvider } from '@coinposh/shared';
import type { Env } from '../../env.ts';
import { ApiFailure } from '../../http/errors.ts';

export interface ProviderConfig {
  readonly id: IdentityProvider;
  readonly label: string;
  readonly issuers: readonly string[];
  readonly jwksUrl: string;
  /**
   * Native Sign in with Apple puts SHA-256(nonce) in the token while the JS SDK echoes it raw;
   * both derive from the server nonce, so either proves the token was minted for it.
   */
  readonly acceptsHashedNonce: boolean;
}

export const PROVIDERS: Readonly<Record<IdentityProvider, ProviderConfig>> = {
  google: {
    id: 'google',
    label: 'Google',
    issuers: ['https://accounts.google.com', 'accounts.google.com'],
    jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
    acceptsHashedNonce: false,
  },
  apple: {
    id: 'apple',
    label: 'Apple',
    issuers: ['https://appleid.apple.com'],
    jwksUrl: 'https://appleid.apple.com/auth/keys',
    acceptsHashedNonce: true,
  },
};

function secret(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/** The `aud` an ID token must carry, or null while the provider's secrets are missing. */
export function providerAudience(env: Env, provider: IdentityProvider): string | null {
  if (provider === 'google') return secret(env.GOOGLE_CLIENT_ID);
  const servicesId = secret(env.APPLE_SERVICES_ID);
  const complete =
    secret(env.APPLE_TEAM_ID) !== null &&
    secret(env.APPLE_KEY_ID) !== null &&
    secret(env.APPLE_PRIVATE_KEY) !== null;
  return complete ? servicesId : null;
}

export function availableProviders(env: Env): IdentityProvider[] {
  return IDENTITY_PROVIDERS.filter((provider) => providerAudience(env, provider) !== null);
}

export interface ReadyProvider {
  readonly config: ProviderConfig;
  readonly audience: string;
}

export function requireProvider(env: Env, provider: IdentityProvider): ReadyProvider {
  const audience = providerAudience(env, provider);
  const config = PROVIDERS[provider];
  if (audience === null) {
    throw new ApiFailure(
      'provider_unavailable',
      `${config.label} sign-in is not set up on this server yet. Keep playing as a guest; your progress is safe.`,
    );
  }
  return { config, audience };
}
