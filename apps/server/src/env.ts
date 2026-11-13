import type { PlayerDO } from './do/PlayerDO.ts';

export interface Env {
  readonly DB: D1Database;
  readonly PLAYER: DurableObjectNamespace<PlayerDO>;
  /** HMAC key for access tokens, set with `wrangler secret put AUTH_SECRET` (≥ 32 chars). */
  readonly AUTH_SECRET?: string;
  /** Cloudflare Turnstile secret, set with `wrangler secret put TURNSTILE_SECRET_KEY`. */
  readonly TURNSTILE_SECRET_KEY?: string;
  /** `off` skips Turnstile (local dev and tests only); unset or `enforce` requires it. */
  readonly TURNSTILE_MODE?: string;
  /** Google OAuth web client ID (H-10.01); unset answers Google sign-in with `provider_unavailable`. */
  readonly GOOGLE_CLIENT_ID?: string;
  /**
   * Sign in with Apple (H-10.02). The Services ID is the ID token audience; the team, key ID and
   * `.p8` private key sign the client secret Apple's revoke endpoint needs. Apple stays
   * `provider_unavailable` until all four are set, so no save is ever linked to an Apple
   * account the server could not later revoke.
   */
  readonly APPLE_SERVICES_ID?: string;
  readonly APPLE_TEAM_ID?: string;
  readonly APPLE_KEY_ID?: string;
  readonly APPLE_PRIVATE_KEY?: string;
}
