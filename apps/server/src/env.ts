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
}
