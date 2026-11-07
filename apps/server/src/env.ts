import type { PlayerDO } from './do/PlayerDO.ts';

export interface Env {
  readonly DB: D1Database;
  readonly PLAYER: DurableObjectNamespace<PlayerDO>;
  /** HMAC key for access tokens, set with `wrangler secret put AUTH_SECRET` (≥ 32 chars). */
  readonly AUTH_SECRET?: string;
  /** Cloudflare Turnstile secret. Until it is provisioned, guest sign-up skips the check. */
  readonly TURNSTILE_SECRET_KEY?: string;
}
