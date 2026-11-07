import {
  IdempotencyKeySchema,
  RefreshRequestSchema,
  type AuthTokens,
  type IdempotencyKey,
  type Locale,
  type PlayerId,
} from '@coinposh/shared';
import { z } from 'zod';
import type { Monotonic } from './clock.ts';
import type { DeviceKey } from './device.ts';
import { ApiRequestError } from './errors.ts';
import { newIdempotencyKey, readResponse, signRequest } from './request.ts';
import type { KeyValueStore } from './store.ts';
import type { Transport } from './wire.ts';

/** Refresh this long before the access token's TTL runs out, so in-flight calls never race it. */
const REFRESH_MARGIN_MS = 30_000;
const STORE_KEY = 'session';

/**
 * What survives a reload. `pendingKey` is the Idempotency-Key of a refresh that may have
 * reached the server without us seeing the answer: resending under it replays the server's
 * response instead of rotating the refresh token twice (which would orphan the account).
 */
const PersistedSessionSchema = z.object({
  refreshToken: RefreshRequestSchema.shape.refreshToken.nullable(),
  pendingKey: IdempotencyKeySchema.nullable(),
});
type PersistedSession = z.infer<typeof PersistedSessionSchema>;

export interface SessionDeps {
  readonly transport: Transport;
  readonly device: DeviceKey;
  readonly store: KeyValueStore;
  readonly monotonic: Monotonic;
  readonly locale: () => Locale;
  /** Resolves a fresh Cloudflare Turnstile token for guest account creation. */
  readonly turnstileToken: () => Promise<string>;
  /** Told when a stored session is unreadable, since falling back to guest sign-in starts a new account. */
  readonly onError: (error: Error) => void;
}

const REVOKED: ReadonlySet<string> = new Set([
  'unauthorized',
  'invalid_signature',
  'token_expired',
]);

export class Session {
  readonly #deps: SessionDeps;
  #access: { token: string; expiresAt: number } | null = null;
  #playerId: PlayerId | null = null;
  #inFlight: Promise<string> | null = null;

  constructor(deps: SessionDeps) {
    this.#deps = deps;
  }

  get playerId(): PlayerId | null {
    return this.#playerId;
  }

  /** A valid bearer token, signing in or refreshing first when needed. Concurrent callers share one auth call. */
  accessToken(): Promise<string> {
    const access = this.#access;
    if (access !== null && this.#deps.monotonic() < access.expiresAt) {
      return Promise.resolve(access.token);
    }
    this.#inFlight ??= this.#authenticate().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  /** The server rejected the current access token; the next call re-authenticates. */
  expireAccessToken(): void {
    this.#access = null;
  }

  async #load(): Promise<PersistedSession> {
    const raw = await this.#deps.store.get(STORE_KEY);
    if (raw === undefined) return { refreshToken: null, pendingKey: null };
    const parsed = PersistedSessionSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    this.#deps.onError(
      new Error(
        `CoinPosh net: discarded an unreadable stored session, signing in as a new guest (${parsed.error.message}).`,
      ),
    );
    return { refreshToken: null, pendingKey: null };
  }

  async #save(session: PersistedSession): Promise<void> {
    await this.#deps.store.set(STORE_KEY, session);
  }

  async #authenticate(): Promise<string> {
    const persisted = await this.#load();
    if (persisted.refreshToken !== null) {
      try {
        return await this.#refresh(persisted.refreshToken, persisted.pendingKey);
      } catch (error) {
        if (!(error instanceof ApiRequestError && REVOKED.has(error.code))) throw error;
        await this.#save({ refreshToken: null, pendingKey: null });
        return this.#guest();
      }
    }
    return this.#guest();
  }

  async #refresh(refreshToken: string, pendingKey: IdempotencyKey | null): Promise<string> {
    const key = pendingKey ?? newIdempotencyKey();
    await this.#save({ refreshToken, pendingKey: key });
    const request = await signRequest(
      'authRefresh',
      { body: { refreshToken } },
      { idempotencyKey: key, accessToken: null },
      this.#deps.device,
    );
    return this.#accept(readResponse('authRefresh', await this.#deps.transport(request)));
  }

  /** Turnstile tokens are single-use, so a retried sign-up is a new request with a new key. */
  async #guest(): Promise<string> {
    const request = await signRequest(
      'authGuest',
      {
        body: {
          devicePublicKey: this.#deps.device.publicKey,
          turnstileToken: await this.#deps.turnstileToken(),
          locale: this.#deps.locale(),
        },
      },
      { idempotencyKey: newIdempotencyKey(), accessToken: null },
      this.#deps.device,
    );
    return this.#accept(readResponse('authGuest', await this.#deps.transport(request)));
  }

  async #accept(tokens: AuthTokens): Promise<string> {
    await this.#save({ refreshToken: tokens.refreshToken, pendingKey: null });
    this.#playerId = tokens.playerId;
    this.#access = {
      token: tokens.accessToken,
      expiresAt: this.#deps.monotonic() + Math.max(0, tokens.accessTokenTtlMs - REFRESH_MARGIN_MS),
    };
    return tokens.accessToken;
  }
}
