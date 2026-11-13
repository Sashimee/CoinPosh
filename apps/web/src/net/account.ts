import {
  EMPTY_BODY_SHA256,
  ErrorEnvelopeSchema,
  HEADERS,
  IDENTITY_PROVIDERS,
  IdTokenSchema,
  accountEndpoints,
  canonicalRequest,
  requiresIdempotencyKey,
  type Account,
  type AccountEndpointName,
  type AccountEndpoints,
  type AccountNonce,
  type ApiError,
  type ErrorCode,
  type ErrorIssue,
  type IdToken,
  type IdempotencyKey,
  type IdentityProvider,
  type NoncePurpose,
  type PlayerId,
  type ProgressChoice,
  type SignInResponse,
  type StateResponse,
} from '@coinposh/shared';
import type { z } from 'zod';
import { DEFAULT_RETRY, backoffDelay, type ApiClient, type RetryPolicy } from './client.ts';
import type { DeviceKey } from './device.ts';
import { sha256Hex } from './encoding.ts';
import { NetworkError } from './errors.ts';
import type { MockIdentityProvider } from './mock/account.ts';
import { ContractViolationError, newIdempotencyKey } from './request.ts';
import type { Session } from './session.ts';
import type { KeyValueStore } from './store.ts';
import type { TableSync } from './tableSync.ts';
import type { Transport, WireRequest, WireResponse } from './wire.ts';

type AccountBody<N extends AccountEndpointName> = AccountEndpoints[N]['body'] extends z.ZodType
  ? z.input<AccountEndpoints[N]['body']>
  : null;
type AccountResult<N extends AccountEndpointName> = z.output<AccountEndpoints[N]['response']>;

/** An account call the server refused, with the envelope's code (`identity_in_use`, …). */
export class AccountRequestError extends Error {
  readonly operation: AccountEndpointName;
  readonly status: number;
  readonly code: ErrorCode;
  readonly retryAfterMs: number | null;
  readonly requestId: string | null;
  readonly issues: readonly ErrorIssue[];

  constructor(operation: AccountEndpointName, status: number, error: ApiError) {
    super(`${operation} failed with ${error.code} (${status}): ${error.message}`);
    this.name = 'AccountRequestError';
    this.operation = operation;
    this.status = status;
    this.code = error.code;
    this.retryAfterMs = error.retryAfterMs ?? null;
    this.requestId = error.requestId ?? null;
    this.issues = error.issues ?? [];
  }
}

export type IdentityProviderFailure = 'unconfigured' | 'load_failed' | 'failed';

/**
 * The provider could not be used on this client: no client ID in this build, its script did not
 * load, or it answered without a usable ID token. Same code as the server's 503, so a caller
 * handles both one way: offer guest play and hide the button.
 */
export class IdentityProviderError extends Error {
  readonly provider: IdentityProvider;
  readonly reason: IdentityProviderFailure;
  readonly code = 'provider_unavailable';

  constructor(
    provider: IdentityProvider,
    reason: IdentityProviderFailure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'IdentityProviderError';
    this.provider = provider;
    this.reason = reason;
  }
}

/** The person closed the provider's sheet. Nothing was sent; guest play goes on as it was. */
export class SignInCancelledError extends Error {
  readonly provider: IdentityProvider;

  constructor(provider: IdentityProvider) {
    super(`The ${provider} sign-in was cancelled.`);
    this.name = 'SignInCancelledError';
    this.provider = provider;
  }
}

export type SessionSwapStage = 'drain' | 'session' | 'boot';

/**
 * The sign-in went through but this tab has not finished moving onto the account's save.
 * `retry()` picks up from the failed stage with the tokens already in hand.
 */
export class SessionSwapError extends Error {
  readonly stage: SessionSwapStage;
  readonly retry: () => Promise<SessionSwap>;

  constructor(stage: SessionSwapStage, retry: () => Promise<SessionSwap>, cause: unknown) {
    super(`CoinPosh net: switching to the signed-in save stopped at ${stage}. Retry it.`, {
      cause,
    });
    this.name = 'SessionSwapError';
    this.stage = stage;
    this.retry = retry;
  }
}

export interface IdTokenRequest {
  readonly nonce: AccountNonce;
  /** Where a provider that needs its own button (Google) draws it. */
  readonly host?: HTMLElement;
  readonly signal?: AbortSignal;
}

/** One way to get a provider ID token in this client. Its script loads on tap, never at boot. */
export interface IdentityDriver {
  readonly provider: IdentityProvider;
  /** True for the Demo Mode provider, whose tokens only the in-browser server accepts. */
  readonly demo: boolean;
  /** Why this provider cannot be offered here, or `null` when it can. */
  readonly unavailable: string | null;
  load(): Promise<void>;
  idToken(request: IdTokenRequest): Promise<IdToken>;
}

export type IdentityDrivers = Readonly<Record<IdentityProvider, IdentityDriver>>;

export interface ProviderOffer {
  readonly provider: IdentityProvider;
  readonly available: boolean;
  readonly demo: boolean;
}

export interface CompleteOptions {
  readonly host?: HTMLElement;
  readonly signal?: AbortSignal;
}

/**
 * A provider flow made ready on the first tap: script loaded and a server nonce in hand.
 * `complete()` runs inside the second tap, so Apple's popup opens within a user gesture.
 */
export interface PreparedFlow<T> {
  readonly provider: IdentityProvider;
  readonly demo: boolean;
  /** Server time after which the nonce is refused and the flow must be prepared again. */
  readonly expiresAt: number;
  complete(options?: CompleteOptions): Promise<T>;
}

export interface SessionSwap {
  readonly from: PlayerId | null;
  readonly to: PlayerId;
  readonly account: Account;
  /** The `hydrate=boot` state the table was re-laid from. */
  readonly state: StateResponse;
}

export type SignInOutcome =
  | {
      readonly kind: 'signedIn';
      readonly account: Account;
      /** `null` when the device was already playing this save. */
      readonly swap: SessionSwap | null;
    }
  | {
      /**
       * This device holds unlinked guest progress and the account keeps another save. Saves are
       * never merged: the person picks one, once.
       */
      readonly kind: 'choice';
      readonly account: Account;
      readonly choice: ProgressChoice;
      keepAccount(): Promise<SessionSwap>;
      keepGuest(): void;
    };

export interface AccountClientDeps {
  readonly transport: Transport;
  readonly device: DeviceKey;
  readonly session: Session;
  /** The store `session` keeps its refresh token in, so a sign-in can hand it the new one. */
  readonly store: KeyValueStore;
  readonly client: Pick<ApiClient, 'call'>;
  readonly table: Pick<TableSync, 'drainBeforeBoot' | 'hydrate'>;
  readonly drivers: IdentityDrivers;
  readonly onError: (error: unknown) => void;
  readonly retry?: RetryPolicy;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Uniform [0, 1) for retry jitter. */
  readonly jitter?: () => number;
}

/** Same record `Session` persists under this key; see `PersistedSessionSchema` in session.ts. */
const SESSION_STORE_KEY = 'session';

const RETRYABLE: ReadonlySet<ErrorCode> = new Set([
  'unavailable',
  'internal',
  'idempotency_in_progress',
]);
const AUTH_EXPIRED: ReadonlySet<ErrorCode> = new Set(['token_expired', 'unauthorized']);

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

function isRetryable(error: unknown): boolean {
  if (error instanceof NetworkError) return true;
  return error instanceof AccountRequestError && RETRYABLE.has(error.code);
}

function fallbackError(status: number): ApiError {
  if (status === 503) {
    return { code: 'unavailable', message: 'Service unavailable (no error body).' };
  }
  if (status >= 500)
    return { code: 'internal', message: `Server error ${status} (no error body).` };
  return { code: 'bad_request', message: `HTTP ${status} without an error envelope.` };
}

interface Handoff {
  /** The sign-in's refresh token is in the store; from then on only `Session` sends it. */
  written: boolean;
  /** Wait for a refresh under way before writing; off when the sign-in revoked its token. */
  readonly settle: boolean;
}

interface CallPlan {
  /** Send the session's bearer token, also on a `none` route such as a link nonce. */
  readonly bearer: boolean;
  readonly retries: number;
  /**
   * The server burns this route's key on first sight, so a resend needs a new one; the others
   * replay their answer under the same key.
   */
  readonly freshKeyPerAttempt: boolean;
}

/**
 * Optional Google and Apple sign-in for a guest save (T-10.03). Nothing here sends a value:
 * a link maps a provider identity to the save the server already holds, and a sign-in only
 * swaps this tab's session onto the save that identity keeps, then re-boots the table from it.
 */
export class AccountClient {
  readonly #deps: AccountClientDeps;
  readonly #retry: RetryPolicy;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #jitter: () => number;
  readonly #swapListeners = new Set<(swap: SessionSwap) => void>();

  constructor(deps: AccountClientDeps) {
    this.#deps = deps;
    this.#retry = deps.retry ?? DEFAULT_RETRY;
    this.#sleep = deps.sleep ?? realSleep;
    this.#jitter = deps.jitter ?? Math.random;
  }

  /** Which buttons to show. Reads only build config: no script loads, no request is sent. */
  offers(): readonly ProviderOffer[] {
    return IDENTITY_PROVIDERS.map((provider) => {
      const driver = this.#deps.drivers[provider];
      return { provider, available: driver.unavailable === null, demo: driver.demo };
    });
  }

  get(): Promise<Account> {
    return this.#call('account', null, {
      bearer: true,
      retries: this.#retry.retries,
      freshKeyPerAttempt: false,
    });
  }

  prepareLink(provider: IdentityProvider): Promise<PreparedFlow<Account>> {
    return this.#prepare(provider, 'link', (idToken, nonce) =>
      this.#call(
        'accountLink',
        { provider, idToken, nonce },
        { bearer: true, retries: this.#retry.retries, freshKeyPerAttempt: false },
      ),
    );
  }

  prepareSignIn(provider: IdentityProvider): Promise<PreparedFlow<SignInOutcome>> {
    return this.#prepare(provider, 'signin', async (idToken, nonce) => {
      // The sign-in rotates this device's refresh token when it lands on the save this device
      // plays, so a refresh still under way would then send a revoked token and read as a leak.
      if (this.#deps.session.playerId !== null) await this.#deps.session.accessToken();
      // A lost answer cannot be replayed: the server burned the key and spent the nonce.
      const response = await this.#call(
        'authSignIn',
        { provider, idToken, nonce, devicePublicKey: this.#deps.device.publicKey },
        { bearer: false, retries: 0, freshKeyPerAttempt: true },
      );
      return this.#outcome(response);
    });
  }

  async link(provider: IdentityProvider, options?: CompleteOptions): Promise<Account> {
    return (await this.prepareLink(provider)).complete(options);
  }

  async signIn(provider: IdentityProvider, options?: CompleteOptions): Promise<SignInOutcome> {
    return (await this.prepareSignIn(provider)).complete(options);
  }

  unlink(provider: IdentityProvider): Promise<Account> {
    return this.#call(
      'accountUnlink',
      { provider },
      { bearer: true, retries: this.#retry.retries, freshKeyPerAttempt: false },
    );
  }

  /** Told after a sign-in moved this tab onto another save and its table was re-booted. */
  onSwap(listener: (swap: SessionSwap) => void): () => void {
    this.#swapListeners.add(listener);
    return () => {
      this.#swapListeners.delete(listener);
    };
  }

  #driver(provider: IdentityProvider): IdentityDriver {
    const driver = this.#deps.drivers[provider];
    if (driver.unavailable !== null) {
      throw new IdentityProviderError(provider, 'unconfigured', driver.unavailable);
    }
    return driver;
  }

  async #prepare<T>(
    provider: IdentityProvider,
    purpose: NoncePurpose,
    finish: (idToken: IdToken, nonce: AccountNonce) => Promise<T>,
  ): Promise<PreparedFlow<T>> {
    const driver = this.#driver(provider);
    const [issued] = await Promise.all([
      this.#call(
        'accountNonce',
        { provider, purpose, devicePublicKey: this.#deps.device.publicKey },
        { bearer: purpose === 'link', retries: this.#retry.retries, freshKeyPerAttempt: true },
      ),
      driver.load().catch((error: unknown) => {
        throw error instanceof IdentityProviderError
          ? error
          : new IdentityProviderError(
              provider,
              'load_failed',
              `CoinPosh net: the ${provider} sign-in script did not load. Check the connection and try again.`,
              { cause: error },
            );
      }),
    ]);
    let used = false;
    return {
      provider,
      demo: driver.demo,
      expiresAt: issued.expiresAt,
      async complete(options = {}) {
        if (used) {
          throw new Error(
            `CoinPosh net: this ${provider} ${purpose} was already completed. Prepare a new one.`,
          );
        }
        used = true;
        const idToken = await driver.idToken({ nonce: issued.nonce, ...options });
        return finish(idToken, issued.nonce);
      },
    };
  }

  async #outcome(response: SignInResponse): Promise<SignInOutcome> {
    const { account, choice } = response;
    if (choice !== undefined) {
      let decided = false;
      const decide = () => {
        if (decided) throw new Error('CoinPosh net: this progress choice was already made.');
        decided = true;
      };
      return {
        kind: 'choice',
        account,
        choice,
        keepAccount: async () => {
          decide();
          return this.#swap(response);
        },
        keepGuest: decide,
      };
    }
    if (response.playerId === this.#deps.session.playerId) {
      // The sign-in rotated this device's refresh token for the same save; keep the new one.
      await this.#adopt(response, { written: false, settle: false });
      return { kind: 'signedIn', account, swap: null };
    }
    return { kind: 'signedIn', account, swap: await this.#swap(response) };
  }

  async #swap(response: SignInResponse): Promise<SessionSwap> {
    const from = this.#deps.session.playerId;
    const handoff: Handoff = { written: false, settle: true };
    const run = async (stage: SessionSwapStage): Promise<SessionSwap> => {
      let current = stage;
      try {
        if (current === 'drain') {
          // Play queued by the guest save goes out under the guest session before it is dropped.
          await this.#deps.table.drainBeforeBoot();
          current = 'session';
        }
        if (current === 'session') {
          await this.#adopt(response, handoff);
          current = 'boot';
        }
        const state = await this.#deps.client.call('state', { query: { hydrate: 'boot' } });
        if (state.player.id !== response.playerId) {
          throw new ContractViolationError(
            `CoinPosh net: the boot state is for ${state.player.id}, not the signed-in ${response.playerId}.`,
          );
        }
        this.#deps.table.hydrate(state);
        const swap: SessionSwap = { from, to: response.playerId, account: response.account, state };
        for (const listener of this.#swapListeners) {
          try {
            listener(swap);
          } catch (error) {
            this.#deps.onError(
              new Error('CoinPosh net: a session swap listener threw.', { cause: error }),
            );
          }
        }
        return swap;
      } catch (error) {
        throw new SessionSwapError(current, () => run(current), error);
      }
    };
    return run('drain');
  }

  /**
   * Hands `Session` the new refresh token, once, and has it refresh onto the signed-in save.
   * Once written, the token belongs to `Session`: a retry only asks it for an access token, so
   * it resends a refresh whose answer was lost under its saved key instead of rotating twice.
   */
  async #adopt(tokens: SignInResponse, handoff: Handoff): Promise<void> {
    const session = this.#deps.session;
    if (!handoff.written) {
      // A refresh under way saves its own token when it lands, so it must land first. The
      // guest's refresh token is still good; on the same save the sign-in just revoked it.
      if (handoff.settle && session.playerId !== null) await session.accessToken();
      await this.#deps.store.set(SESSION_STORE_KEY, {
        refreshToken: tokens.refreshToken,
        pendingKey: null,
      });
      handoff.written = true;
      session.expireAccessToken();
    }
    await session.accessToken();
    if (session.playerId !== tokens.playerId) {
      throw new ContractViolationError(
        `CoinPosh net: the session refreshed onto ${String(session.playerId)}, not the signed-in ${tokens.playerId}.`,
      );
    }
  }

  async #call<N extends AccountEndpointName>(
    name: N,
    body: AccountBody<N>,
    plan: CallPlan,
  ): Promise<AccountResult<N>> {
    const endpoint = accountEndpoints[name];
    let key = requiresIdempotencyKey(endpoint) ? newIdempotencyKey() : null;
    let reauthenticated = false;
    for (let attempt = 0; ;) {
      const accessToken = plan.bearer ? await this.#deps.session.accessToken() : null;
      try {
        const request = await this.#sign(name, body, key, accessToken);
        return this.#read(name, await this.#deps.transport(request));
      } catch (error) {
        const expired = error instanceof AccountRequestError && AUTH_EXPIRED.has(error.code);
        if (plan.bearer && expired && !reauthenticated) {
          reauthenticated = true;
          this.#deps.session.expireAccessToken();
        } else {
          if (attempt >= plan.retries || !isRetryable(error)) throw error;
          const retryAfterMs = error instanceof AccountRequestError ? error.retryAfterMs : null;
          await this.#sleep(backoffDelay(attempt, this.#retry, this.#jitter(), retryAfterMs));
          attempt += 1;
        }
        if (plan.freshKeyPerAttempt && key !== null) key = newIdempotencyKey();
      }
    }
  }

  async #sign<N extends AccountEndpointName>(
    name: N,
    input: AccountBody<N>,
    idempotencyKey: IdempotencyKey | null,
    accessToken: string | null,
  ): Promise<WireRequest> {
    const endpoint = accountEndpoints[name];
    let body: string | null = null;
    if (endpoint.body !== null) {
      const parsed = endpoint.body.safeParse(input);
      if (!parsed.success) {
        throw new ContractViolationError(
          `Refusing to send an invalid ${name} body: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
          { cause: parsed.error },
        );
      }
      body = JSON.stringify(parsed.data);
    }
    const signature = await this.#deps.device.sign(
      canonicalRequest({
        method: endpoint.method,
        pathWithQuery: endpoint.path,
        idempotencyKey,
        bodySha256: body === null ? EMPTY_BODY_SHA256 : await sha256Hex(body),
      }),
    );
    const headers: Record<string, string> = { [HEADERS.deviceSignature]: signature };
    if (idempotencyKey !== null) headers[HEADERS.idempotencyKey] = idempotencyKey;
    if (accessToken !== null) headers[HEADERS.authorization] = `Bearer ${accessToken}`;
    return { method: endpoint.method, path: endpoint.path, headers, body };
  }

  #read<N extends AccountEndpointName>(name: N, response: WireResponse): AccountResult<N> {
    if (response.status >= 200 && response.status < 300) {
      const parsed = accountEndpoints[name].response.safeParse(response.body);
      if (!parsed.success) {
        throw new ContractViolationError(
          `${name} answered ${response.status} with a body outside its contract: ${parsed.error.message}`,
          { cause: parsed.error },
        );
      }
      return parsed.data as AccountResult<N>;
    }
    const envelope = ErrorEnvelopeSchema.safeParse(response.body);
    throw new AccountRequestError(
      name,
      response.status,
      envelope.success ? envelope.data.error : fallbackError(response.status),
    );
  }
}

/** Loads one `<script>` per URL, once; a failed load can be tried again. */
export type ScriptLoader = (src: string) => Promise<void>;

export function domScriptLoader(
  document: () => Document = () => globalThis.document,
): ScriptLoader {
  const loading = new Map<string, Promise<void>>();
  return (src) => {
    const known = loading.get(src);
    if (known !== undefined) return known;
    const pending = new Promise<void>((resolve, reject) => {
      const doc = document();
      const script = doc.createElement('script');
      script.src = src;
      script.async = true;
      script.addEventListener(
        'load',
        () => {
          resolve();
        },
        { once: true },
      );
      script.addEventListener(
        'error',
        () => {
          script.remove();
          loading.delete(src);
          reject(new Error(`CoinPosh net: ${src} did not load.`));
        },
        { once: true },
      );
      doc.head.append(script);
    });
    loading.set(src, pending);
    return pending;
  };
}

export const GOOGLE_GIS_SCRIPT = 'https://accounts.google.com/gsi/client';
export const APPLE_JS_SCRIPT =
  'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js';

interface GoogleCredentialResponse {
  readonly credential?: string;
}

interface GooglePromptMoment {
  isSkippedMoment(): boolean;
  isDismissedMoment(): boolean;
  getDismissedReason?(): string;
}

/** The part of Google Identity Services' `google.accounts.id` this client calls. */
export interface GoogleIdApi {
  initialize(config: {
    readonly client_id: string;
    readonly nonce: string;
    readonly callback: (response: GoogleCredentialResponse) => void;
    readonly auto_select: boolean;
    readonly cancel_on_tap_outside: boolean;
    readonly use_fedcm_for_prompt: boolean;
    readonly context: 'signin' | 'use';
  }): void;
  renderButton(
    parent: HTMLElement,
    options: { readonly type: 'standard'; readonly theme: string; readonly size: string },
  ): void;
  prompt(listener?: (moment: GooglePromptMoment) => void): void;
  cancel(): void;
}

interface AppleSignInResponse {
  readonly authorization?: { readonly id_token?: string; readonly state?: string };
}

/** The part of Sign in with Apple JS' `AppleID.auth` this client calls. */
export interface AppleAuthApi {
  init(config: {
    readonly clientId: string;
    readonly scope: string;
    readonly redirectURI: string;
    readonly state: string;
    readonly nonce: string;
    readonly usePopup: boolean;
  }): void;
  signIn(): Promise<AppleSignInResponse>;
}

export interface IdentityConfig {
  readonly googleClientId: string | undefined;
  readonly appleServicesId: string | undefined;
  /** The return URL registered for the Apple Services ID; the popup flow still sends it. */
  readonly appleRedirectUri: string | undefined;
}

export interface LiveDriverOptions {
  readonly loadScript?: ScriptLoader;
  readonly google?: () => GoogleIdApi | undefined;
  readonly apple?: () => AppleAuthApi | undefined;
}

const GOOGLE_CLIENT_ID = /^[\w-]+\.apps\.googleusercontent\.com$/;
const APPLE_SERVICES_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

function configError(
  provider: IdentityProvider,
  name: string,
  value: string | undefined,
  pattern: RegExp,
): string | null {
  if (value === undefined || value.trim() === '') {
    return `CoinPosh net: ${name} is not set in this build, so ${provider} sign-in is unavailable. Guest play is unaffected.`;
  }
  if (!pattern.test(value.trim())) {
    return `CoinPosh net: ${name} "${value}" is not a ${provider} client ID. Rebuild with the ID from the provider console, or leave it unset.`;
  }
  return null;
}

function readEnv(name: string): string | undefined {
  const raw: unknown = import.meta.env[name];
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
}

export function currentIdentityConfig(): IdentityConfig {
  const base: unknown = import.meta.env.BASE_URL;
  return {
    googleClientId: readEnv('VITE_GOOGLE_CLIENT_ID'),
    appleServicesId: readEnv('VITE_APPLE_SERVICES_ID'),
    appleRedirectUri:
      typeof location === 'undefined' || typeof base !== 'string'
        ? undefined
        : new URL(base, location.origin).href,
  };
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function abortable<T>(
  provider: IdentityProvider,
  signal: AbortSignal | undefined,
  run: (resolve: (value: T) => void, reject: (error: unknown) => void) => () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new SignInCancelledError(provider));
      return;
    }
    const onAbort = () => {
      cancel();
      reject(new SignInCancelledError(provider));
    };
    const settle =
      <A>(fn: (arg: A) => void) =>
      (arg: A) => {
        signal?.removeEventListener('abort', onAbort);
        fn(arg);
      };
    const cancel = run(settle(resolve), settle(reject));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function parsedIdToken(provider: IdentityProvider, raw: unknown): IdToken {
  const token = IdTokenSchema.safeParse(raw);
  if (!token.success) {
    throw new IdentityProviderError(
      provider,
      'failed',
      `CoinPosh net: ${provider} answered without a usable ID token. Try again.`,
    );
  }
  return token.data;
}

function googleDriver(
  config: IdentityConfig,
  options: Required<LiveDriverOptions>,
): IdentityDriver {
  const provider = 'google';
  const unavailable = configError(
    provider,
    'VITE_GOOGLE_CLIENT_ID',
    config.googleClientId,
    GOOGLE_CLIENT_ID,
  );
  const api = (): GoogleIdApi => {
    const google = options.google();
    if (google === undefined) {
      throw new IdentityProviderError(
        provider,
        'load_failed',
        'CoinPosh net: Google Identity Services loaded without google.accounts.id.',
      );
    }
    return google;
  };
  return {
    provider,
    demo: false,
    unavailable,
    async load() {
      await options.loadScript(GOOGLE_GIS_SCRIPT);
      api();
    },
    idToken({ nonce, host, signal }) {
      const clientId = config.googleClientId;
      if (unavailable !== null || clientId === undefined) {
        return Promise.reject(
          new IdentityProviderError(provider, 'unconfigured', unavailable ?? ''),
        );
      }
      return abortable<IdToken>(provider, signal, (resolve, reject) => {
        const google = api();
        google.initialize({
          client_id: clientId,
          nonce,
          auto_select: false,
          cancel_on_tap_outside: true,
          use_fedcm_for_prompt: true,
          context: 'signin',
          callback: (response) => {
            try {
              resolve(parsedIdToken(provider, response.credential));
            } catch (error) {
              reject(error);
            }
          },
        });
        if (host === undefined) {
          google.prompt((moment) => {
            // GIS also reports a successful pick as a dismissed moment, in either order with
            // the credential callback.
            const dismissed =
              moment.isDismissedMoment() && moment.getDismissedReason?.() !== 'credential_returned';
            if (moment.isSkippedMoment() || dismissed) reject(new SignInCancelledError(provider));
          });
        } else {
          google.renderButton(host, { type: 'standard', theme: 'filled_black', size: 'large' });
        }
        return () => {
          google.cancel();
        };
      });
    },
  };
}

function appleDriver(config: IdentityConfig, options: Required<LiveDriverOptions>): IdentityDriver {
  const provider = 'apple';
  const unavailable =
    configError(provider, 'VITE_APPLE_SERVICES_ID', config.appleServicesId, APPLE_SERVICES_ID) ??
    (config.appleRedirectUri === undefined
      ? 'CoinPosh net: Sign in with Apple needs a page origin for its return URL.'
      : null);
  const api = (): AppleAuthApi => {
    const apple = options.apple();
    if (apple === undefined) {
      throw new IdentityProviderError(
        provider,
        'load_failed',
        'CoinPosh net: Sign in with Apple JS loaded without AppleID.auth.',
      );
    }
    return apple;
  };
  return {
    provider,
    demo: false,
    unavailable,
    async load() {
      await options.loadScript(APPLE_JS_SCRIPT);
      api();
    },
    async idToken({ nonce, signal }) {
      const clientId = config.appleServicesId;
      const redirectURI = config.appleRedirectUri;
      if (unavailable !== null || clientId === undefined || redirectURI === undefined) {
        throw new IdentityProviderError(provider, 'unconfigured', unavailable ?? '');
      }
      if (aborted(signal)) throw new SignInCancelledError(provider);
      const apple = api();
      const state = crypto.randomUUID();
      apple.init({ clientId, scope: 'email', redirectURI, state, nonce, usePopup: true });
      let response: AppleSignInResponse;
      try {
        // Called before any other await, so the popup opens inside the tap that asked for it.
        response = await apple.signIn();
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'error' in error ? error.error : undefined;
        if (code === 'popup_closed_by_user' || code === 'user_cancelled_authorize') {
          throw new SignInCancelledError(provider);
        }
        throw new IdentityProviderError(
          provider,
          'failed',
          'CoinPosh net: Sign in with Apple failed. Try again.',
          { cause: error },
        );
      }
      if (aborted(signal)) throw new SignInCancelledError(provider);
      if (response.authorization?.state !== state) {
        throw new IdentityProviderError(
          provider,
          'failed',
          'CoinPosh net: Sign in with Apple answered for another request. Try again.',
        );
      }
      return parsedIdToken(provider, response.authorization.id_token);
    },
  };
}

interface IdentityGlobals {
  readonly google?: { readonly accounts?: { readonly id?: GoogleIdApi } };
  readonly AppleID?: { readonly auth?: AppleAuthApi };
}

/** Google and Apple as this build is configured: an unset ID makes that provider unavailable. */
export function liveIdentityDrivers(
  config: IdentityConfig,
  options: LiveDriverOptions = {},
): IdentityDrivers {
  const globals = globalThis as IdentityGlobals;
  const resolved: Required<LiveDriverOptions> = {
    loadScript: options.loadScript ?? domScriptLoader(),
    google: options.google ?? (() => globals.google?.accounts?.id),
    apple: options.apple ?? (() => globals.AppleID?.auth),
  };
  return { google: googleDriver(config, resolved), apple: appleDriver(config, resolved) };
}

export interface DemoDriverOptions {
  /** Which fake person signs in; tests use it to stand for two people. */
  readonly persona?: () => string;
}

/**
 * Demo Mode's providers: no script, no Google or Apple, just the in-browser fake whose tokens
 * name a `.invalid` issuer. The UI labels them as demo sign-ins.
 */
export function demoIdentityDrivers(
  identity: MockIdentityProvider,
  options: DemoDriverOptions = {},
): IdentityDrivers {
  const driver = (provider: IdentityProvider): IdentityDriver => ({
    provider,
    demo: true,
    unavailable: null,
    load: () => Promise.resolve(),
    async idToken({ nonce, signal }) {
      if (aborted(signal)) throw new SignInCancelledError(provider);
      return identity.issue(provider, nonce, { persona: options.persona?.() ?? 'demo' });
    },
  });
  return { google: driver('google'), apple: driver('apple') };
}
