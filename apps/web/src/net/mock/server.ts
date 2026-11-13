import {
  ACCOUNT_ENDPOINT_NAMES,
  DevicePublicKeySchema,
  DeviceSignatureSchema,
  EMPTY_BODY_SHA256,
  ENDPOINT_NAMES,
  HEADERS,
  IdempotencyKeySchema,
  PlayerIdSchema,
  accountEndpoints,
  canonicalRequest,
  endpoints,
  errorEnvelope,
  errorStatus,
  requiresIdempotencyKey,
  tableSnapshotEndpoint,
  validationErrorEnvelope,
  type AccountEndpointName,
  type AccountLinkRequest,
  type AccountNonceRequest,
  type AccountUnlinkRequest,
  type DevicePublicKey,
  type Endpoint,
  type ErrorCode,
  type ErrorEnvelope,
  type IdempotencyKey,
  type IdentityProvider,
  type PlayerId,
  type Sha256Hex,
  type SignInRequest,
  type StateQuery,
  type TableSnapshotRequest,
} from '@coinposh/shared';
import { fromBase64Url, randomBase62, sha256Hex, utf8Bytes } from '../encoding.ts';
import { NetworkError, type ApiOperation } from '../errors.ts';
import type { Transport, WireRequest, WireResponse } from '../wire.ts';
import type { MockAccounts, MockIdentityProvider } from './account.ts';
import {
  DEMO_STORAGE_KEY,
  browserSessionStorage,
  consoleWarn,
  decodeDemoBlob,
  encodeDemoBlob,
  type MockStorage,
  type PersistWarn,
} from './persist.ts';
import { MOCK_RULES } from './rules.ts';
import {
  MockFailure,
  MockWorld,
  RestoreError,
  deviceThumbprint,
  type LedgerEntry,
  type MockPlayer,
} from './world.ts';

/** `down` refuses every request; `dropResponses` runs it but loses the answer, like a cut connection. */
export type MockNetwork = 'up' | 'down' | 'dropResponses';

export interface MockServerOptions {
  /** Server time. Every rule reads this clock, never a timestamp the client sent. */
  readonly now?: () => number;
  /**
   * Where the world survives a reload of this tab. Defaults to the browser's sessionStorage
   * (none outside a browser); `null` keeps the world in memory only.
   */
  readonly storage?: MockStorage | null;
  /** How a storage problem is reported; the world then plays on from memory. */
  readonly onPersistWarning?: PersistWarn;
  /** How long after the last request the world is written; every request in a burst restarts it. */
  readonly persistDelayMs?: number;
  /**
   * The longest a changed world waits for its write while requests keep coming, which is also
   * the most a mid-request pagehide can lose. Defaults to four times `persistDelayMs`.
   */
  readonly persistMaxWaitMs?: number;
  /** Whose `pagehide` and `visibilitychange` flush the world at once. Defaults to `window`. */
  readonly lifecycle?: EventTarget | null;
}

/** The sessionStorage key the Demo account links live under, next to the world they point into. */
export const DEMO_ACCOUNT_STORAGE_KEY = 'coinposh.demo.account';

export interface MockServer {
  readonly transport: Transport;
  readonly world: MockWorld;
  /**
   * Google and Apple links in this Demo world, kept and checked as the server keeps them. They
   * load with the first account request, so guest play never downloads them.
   */
  accounts(): Promise<MockAccounts>;
  /** The clearly fake provider whose tokens the Demo sign-in buttons hand back. */
  identity(): Promise<MockIdentityProvider>;
  ledger(): readonly LedgerEntry[];
  /** Responses currently held for replay, to show the store stays bounded. */
  retainedReplays(): number;
  /** Single-use sign-in and nonce keys still remembered, to show that set stays bounded too. */
  retainedBurnedKeys(): number;
  setNetwork(network: MockNetwork): void;
  /** Whether this server picked up a world an earlier page in this tab left in storage. */
  readonly restored: boolean;
  /**
   * Writes the world now. Mid-request it retries the last encoded state if its write failed,
   * then stores the newer one right after the running request finishes.
   */
  flush(): void;
}

const DEFAULT_PERSIST_DELAY_MS = 250;

interface DemoAccounts {
  readonly accounts: MockAccounts;
  readonly identity: MockIdentityProvider;
  /** The blob storage now holds for these links, so an unchanged set is not rewritten. */
  readonly stored: string;
  readonly encode: () => string;
}

interface Persistence {
  readonly world: MockWorld;
  readonly accounts: () => Promise<DemoAccounts>;
  readonly restored: boolean;
  /**
   * Encodes the world as it stands; called between requests only, so it never catches a
   * handler between two awaits.
   */
  readonly capture: () => void;
  /** Writes the last captured blob if it is not stored yet, without touching the live world. */
  readonly writeCaptured: () => void;
}

/**
 * Picks up the world this tab left behind, or starts a fresh one. Anything wrong with the
 * stored world, from a blocked storage to a blob that does not add up, is warned about and
 * dropped: Demo Mode must always boot.
 */
function openPersistence(
  storage: MockStorage | null,
  warn: PersistWarn,
  now: () => number,
): Persistence {
  if (storage === null) {
    const world = new MockWorld();
    const noop = () => undefined;
    return {
      world,
      accounts: once(() => loadAccounts(null, warn, world, now, { restore: null, held: null })),
      restored: false,
      capture: noop,
      writeCaptured: noop,
    };
  }
  let world: MockWorld | null = null;
  let raw: string | null = null;
  let storageFailed = false;
  try {
    raw = storage.getItem(DEMO_STORAGE_KEY);
  } catch (error) {
    storageFailed = true;
    warn('CoinPosh demo: the saved session could not be read, so this one starts fresh.', error);
  }
  if (raw !== null) {
    const decoded = decodeDemoBlob(raw);
    if (decoded.ok) {
      try {
        world = MockWorld.restore(decoded.world);
      } catch (error) {
        if (!(error instanceof RestoreError)) throw error;
        warn(`CoinPosh demo: the saved session was dropped for a fresh one. ${error.message}`);
      }
    } else {
      warn(`CoinPosh demo: the saved session was dropped for a fresh one: ${decoded.reason}.`);
    }
    if (world === null) {
      try {
        storage.removeItem(DEMO_STORAGE_KEY);
      } catch (error) {
        storageFailed = true;
        warn('CoinPosh demo: the dropped session could not be cleared from storage.', error);
      }
    }
  }
  const restored = world !== null;
  const live = world ?? new MockWorld();
  const held = storedAccounts(storage, warn, restored, storageFailed);
  let loaded: DemoAccounts | null = null;
  let accountsWritten = '';
  const accounts = once(async () => {
    const opened = await loadAccounts(storage, warn, live, now, held);
    loaded = opened;
    accountsWritten = opened.stored;
    return opened;
  });
  let failing = false;
  let captured: string | null = null;
  let unwritten = false;
  let capturedAccounts: string | null = null;
  const capture = (): void => {
    captured = encodeDemoBlob(live.serialize());
    unwritten = true;
    if (loaded !== null) capturedAccounts = loaded.encode();
  };
  const writeCaptured = (): void => {
    const accountsDue = capturedAccounts === accountsWritten ? null : capturedAccounts;
    if (captured === null || (!unwritten && accountsDue === null)) return;
    try {
      if (unwritten) storage.setItem(DEMO_STORAGE_KEY, captured);
      unwritten = false;
      if (accountsDue !== null) {
        storage.setItem(DEMO_ACCOUNT_STORAGE_KEY, accountsDue);
        accountsWritten = accountsDue;
      }
      failing = false;
    } catch (error) {
      // One warning per run of failures: a full quota fails every write until space frees up.
      if (!failing) {
        warn('CoinPosh demo: this session could not be saved, so a reload may lose it.', error);
      }
      failing = true;
    }
  };
  return { world: live, accounts, restored, capture, writeCaptured };
}

/** One shared load; a failed one is tried again by the next caller. */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= load().catch((error: unknown) => {
      pending = null;
      throw error;
    });
    return pending;
  };
}

interface HeldAccounts {
  /** The stored links to restore into the world once the account code loads. */
  readonly restore: string | null;
  /** What storage still holds after links that could not be kept failed to clear. */
  readonly held: string | null;
}

/**
 * Links only mean something in the world they were made in, so they load with it or not at all.
 * Only the blob is read here; it is decoded and checked when the account code loads.
 */
function storedAccounts(
  storage: MockStorage,
  warn: PersistWarn,
  restored: boolean,
  storageFailed: boolean,
): HeldAccounts {
  // Storage already refused this page and said so; the links of a dropped world are left for
  // the next restore to refuse against the world that replaces it.
  if (storageFailed) return { restore: null, held: null };
  let raw: string | null;
  try {
    raw = storage.getItem(DEMO_ACCOUNT_STORAGE_KEY);
  } catch (error) {
    warn(
      'CoinPosh demo: the saved account links could not be read, so this session starts unlinked.',
      error,
    );
    return { restore: null, held: null };
  }
  if (raw === null) return { restore: null, held: null };
  if (restored) return { restore: raw, held: null };
  return { restore: null, held: dropAccounts(storage, warn, raw) };
}

/** Clears stored links; returns what storage still holds when that failed. */
function dropAccounts(storage: MockStorage, warn: PersistWarn, raw: string): string | null {
  try {
    storage.removeItem(DEMO_ACCOUNT_STORAGE_KEY);
    return null;
  } catch (error) {
    warn('CoinPosh demo: the dropped account links could not be cleared from storage.', error);
    return raw;
  }
}

async function loadAccounts(
  storage: MockStorage | null,
  warn: PersistWarn,
  world: MockWorld,
  now: () => number,
  stored: HeldAccounts,
): Promise<DemoAccounts> {
  const { MockAccounts, MockIdentityProvider, decodeAccountsBlob, encodeAccountsBlob } =
    await import('./account.ts');
  const identity = new MockIdentityProvider(now);
  const opened = (accounts: MockAccounts, blob: string | null): DemoAccounts => {
    const encode = () => encodeAccountsBlob(accounts.serialize());
    return { accounts, identity, stored: blob ?? encode(), encode };
  };
  const raw = stored.restore;
  if (raw === null || storage === null)
    return opened(new MockAccounts(world, identity), stored.held);
  const decoded = decodeAccountsBlob(raw);
  if (decoded.ok) {
    try {
      return opened(MockAccounts.restore(decoded.accounts, world, identity), raw);
    } catch (error) {
      if (!(error instanceof RestoreError)) throw error;
      warn(`CoinPosh demo: the saved account links were dropped. ${error.message}`);
    }
  } else {
    warn(`CoinPosh demo: the saved account links were dropped: ${decoded.reason}.`);
  }
  return opened(new MockAccounts(world, identity), dropAccounts(storage, warn, raw));
}

interface StoredResponse {
  readonly fingerprint: string;
  readonly response: WireResponse;
  readonly at: number;
}

type MockOperation = ApiOperation | AccountEndpointName;

const ACCOUNT_OPERATIONS: ReadonlySet<MockOperation> = new Set(ACCOUNT_ENDPOINT_NAMES);

function isAccountOperation(name: MockOperation): name is AccountEndpointName {
  return ACCOUNT_OPERATIONS.has(name);
}

/** Endpoints whose bodies carry sim ticks, so any replay past `claimExpiryMs` is refused anyway. */
const TICK_GATED: ReadonlySet<MockOperation> = new Set([
  'tableDrop',
  'tableClaims',
  'tableNudge',
  'tableInputs',
  'tableSnapshot',
]);

/**
 * Operations whose refusals are not kept for replay, as on the server: a snapshot refused as
 * rate limited or stale may be sent again under its key once the reason is gone.
 */
const REPLAYS_SUCCESS_ONLY: ReadonlySet<MockOperation> = new Set(['tableSnapshot']);

/**
 * Keys that work once, as `burnAuthKey` makes them on the server: a captured signed sign-in or
 * nonce request is refused when sent again rather than answered with its tokens or nonce.
 */
const BURNS_KEY: ReadonlySet<MockOperation> = new Set(['accountNonce', 'authSignIn']);

const ROUTES: readonly (readonly [MockOperation, Endpoint])[] = [
  ...ENDPOINT_NAMES.map((name) => [name, endpoints[name]] as const),
  ['tableSnapshot', tableSnapshotEndpoint],
  ...ACCOUNT_ENDPOINT_NAMES.map((name) => [name, accountEndpoints[name]] as const),
];

/**
 * Responses kept for replay, oldest first. Server time only moves forward, so the front of the
 * map is always the next to expire.
 */
class ReplayStore {
  readonly #entries = new Map<string, StoredResponse>();
  readonly #ttlMs: number;
  readonly #cap: number;

  constructor(ttlMs: number, cap: number) {
    this.#ttlMs = ttlMs;
    this.#cap = cap;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: string): StoredResponse | undefined {
    return this.#entries.get(key);
  }

  set(key: string, stored: StoredResponse): void {
    this.#entries.set(key, stored);
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size <= this.#cap) break;
      this.#entries.delete(oldest);
    }
  }

  prune(now: number): void {
    for (const [key, stored] of this.#entries) {
      if (stored.at > now - this.#ttlMs) return;
      this.#entries.delete(key);
    }
  }
}

/**
 * Single-use keys, oldest first. A key is forgotten `idempotencyTtlMs` after it was burned: by
 * then the nonce and ID token it carried expired long ago (`nonceTtlMs`, `idTokenTtlMs`), so a
 * replay is still refused, and the set stays bounded by the request envelope.
 */
class BurnedKeys {
  readonly #burnedAt = new Map<IdempotencyKey, number>();
  readonly #ttlMs: number;

  constructor(ttlMs: number) {
    this.#ttlMs = ttlMs;
  }

  get size(): number {
    return this.#burnedAt.size;
  }

  /** Burns the key; false when it was already burned and is still remembered. */
  burn(key: IdempotencyKey, now: number): boolean {
    for (const [burned, at] of this.#burnedAt) {
      if (at > now - this.#ttlMs) break;
      this.#burnedAt.delete(burned);
    }
    if (this.#burnedAt.has(key)) return false;
    this.#burnedAt.set(key, now);
    return true;
  }
}

/** A session handed to one device key: tokens are bound to the key they were issued to. */
interface DeviceGrant {
  readonly playerId: PlayerId;
  readonly key: CryptoKey;
  readonly device: string;
  /** The provider whose sign-in admitted this device; `null` for the device that made the save. */
  readonly via: IdentityProvider | null;
}

interface RefreshRecord extends DeviceGrant {
  revoked: boolean;
}

interface AccessRecord extends DeviceGrant {
  readonly expiresAt: number;
}

interface Authenticated {
  readonly scope: string;
  readonly player: MockPlayer | null;
  readonly devicePublicKey: DevicePublicKey | null;
  readonly key: CryptoKey;
  readonly device: string;
  readonly refresh?: RefreshRecord;
}

interface Route {
  readonly name: MockOperation;
  readonly endpoint: Endpoint;
  readonly params: Record<string, string> | null;
}

const VERIFY_ALGORITHM = { name: 'ECDSA', hash: 'SHA-256' } as const;
const RATE_WINDOW_MS = 1_000;

function fail(
  code: ErrorCode,
  message: string,
  extra: Omit<ErrorEnvelope['error'], 'code' | 'message'> = {},
): WireResponse {
  return { status: errorStatus(code), body: errorEnvelope(code, message, extra) };
}

class Refusal extends Error {
  readonly response: WireResponse;

  constructor(response: WireResponse) {
    super('Mock request refused.');
    this.response = response;
  }
}

function refuse(
  code: ErrorCode,
  message: string,
  extra?: Omit<ErrorEnvelope['error'], 'code' | 'message'>,
): never {
  throw new Refusal(fail(code, message, extra));
}

function header(request: WireRequest, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(request.headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return null;
}

function route(method: string, pathWithQuery: string): Route | null {
  const [path = ''] = pathWithQuery.split('?');
  for (const [name, endpoint] of ROUTES) {
    if (endpoint.method !== method) continue;
    const keys: string[] = [];
    const pattern = endpoint.path.replace(/:([A-Za-z]+)/g, (_segment, key: string) => {
      keys.push(key);
      return '([^/]+)';
    });
    const match = new RegExp(`^${pattern}$`).exec(path);
    if (match === null) continue;
    if (keys.length === 0) return { name, endpoint, params: null };
    const params: Record<string, string> = {};
    try {
      keys.forEach((key, i) => {
        params[key] = decodeURIComponent(match[i + 1] ?? '');
      });
    } catch {
      refuse('bad_request', 'A path parameter is not valid percent-encoding.');
    }
    return { name, endpoint, params };
  }
  return null;
}

async function importVerifyKey(jwk: DevicePublicKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
}

/**
 * The in-browser stand-in for the Workers API (T-1.07). It speaks the same `@coinposh/shared`
 * contracts and runs the same pipeline: route, size cap, signature, auth, rate envelope,
 * idempotency, strict body validation, then the authoritative rules in {@link MockWorld}.
 * Requests run one at a time, the way a player's Durable Object serialises them.
 */
export function createMockServer(options: MockServerOptions = {}): MockServer {
  const now = options.now ?? (() => Date.now());
  const warn = options.onPersistWarning ?? consoleWarn;
  const storage = options.storage === undefined ? browserSessionStorage(warn) : options.storage;
  const persistence = openPersistence(storage, warn, now);
  const world = persistence.world;
  const accessTokens = new Map<string, AccessRecord>();
  const refreshTokens = new Map<string, RefreshRecord>();
  const burnedKeys = new BurnedKeys(MOCK_RULES.idempotencyTtlMs);
  const tableReplays = new ReplayStore(MOCK_RULES.claimExpiryMs, Infinity);
  const otherReplays = new ReplayStore(MOCK_RULES.idempotencyTtlMs, MOCK_RULES.idempotencyRetained);
  const usedTurnstile = new Set<string>();
  const recentRequests = new Map<string, number[]>();
  let network: MockNetwork = 'up';
  let queue: Promise<unknown> = Promise.resolve();

  /** Rotation is per device: one device signing in never signs another out. */
  function issueTokens(grant: DeviceGrant) {
    for (const record of refreshTokens.values()) {
      if (record.playerId === grant.playerId && record.device === grant.device) {
        record.revoked = true;
      }
    }
    const accessToken = `at_${randomBase62(40)}`;
    const refreshToken = `rt_${randomBase62(48)}`;
    accessTokens.set(accessToken, { ...grant, expiresAt: now() + MOCK_RULES.accessTokenTtlMs });
    refreshTokens.set(refreshToken, { ...grant, revoked: false });
    return {
      playerId: grant.playerId,
      accessToken,
      accessTokenTtlMs: MOCK_RULES.accessTokenTtlMs,
      refreshToken,
    };
  }

  function revokeAll(playerId: PlayerId): void {
    for (const record of refreshTokens.values())
      if (record.playerId === playerId) record.revoked = true;
    for (const [token, record] of accessTokens)
      if (record.playerId === playerId) accessTokens.delete(token);
  }

  /** Unlinking a provider signs out every other device that reached the save through it. */
  function revokeAdmitted(playerId: PlayerId, provider: IdentityProvider, keep: string): void {
    const admitted = (grant: DeviceGrant) =>
      grant.playerId === playerId && grant.via === provider && grant.device !== keep;
    for (const record of refreshTokens.values()) if (admitted(record)) record.revoked = true;
    for (const [token, record] of accessTokens) if (admitted(record)) accessTokens.delete(token);
  }

  async function verify(
    key: CryptoKey,
    request: WireRequest,
    idempotencyKey: IdempotencyKey | null,
    bodySha256: Sha256Hex,
  ) {
    const signature = DeviceSignatureSchema.safeParse(header(request, HEADERS.deviceSignature));
    if (!signature.success) refuse('invalid_signature', 'Missing or malformed device signature.');
    const message = canonicalRequest({
      method: request.method,
      pathWithQuery: request.path,
      idempotencyKey,
      bodySha256,
    });
    const valid = await crypto.subtle.verify(
      VERIFY_ALGORITHM,
      key,
      fromBase64Url(signature.data),
      utf8Bytes(message),
    );
    if (!valid) refuse('invalid_signature', 'The device signature does not match this request.');
  }

  function enforceEnvelope(scope: string, at: number): void {
    const window = (recentRequests.get(scope) ?? []).filter((seen) => seen > at - RATE_WINDOW_MS);
    if (window.length >= MOCK_RULES.maxRequestsPerSecond) {
      const oldest = window[0] ?? at;
      recentRequests.set(scope, window);
      refuse('rate_limited', 'Too many requests for one player.', {
        retryAfterMs: Math.max(1, oldest + RATE_WINDOW_MS - at),
      });
    }
    window.push(at);
    recentRequests.set(scope, window);
  }

  function parseBody(found: Route, raw: unknown) {
    if (found.endpoint.body === null) return undefined;
    const parsed = found.endpoint.body.safeParse(raw);
    if (!parsed.success) {
      throw new Refusal({
        status: errorStatus('validation_failed'),
        body: validationErrorEnvelope(parsed.error),
      });
    }
    return parsed.data;
  }

  function bearer(request: WireRequest, at: number): { access: AccessRecord; player: MockPlayer } {
    const authorization = header(request, HEADERS.authorization);
    const token =
      authorization?.startsWith('Bearer ') === true ? authorization.slice('Bearer '.length) : null;
    const access = token === null ? undefined : accessTokens.get(token);
    const player = access === undefined ? undefined : world.player(access.playerId);
    if (access === undefined || player === undefined)
      refuse('unauthorized', 'Missing or unknown access token.');
    if (at >= access.expiresAt)
      refuse('token_expired', 'The access token has expired; refresh it.');
    return { access, player };
  }

  async function authenticate(
    found: Route,
    request: WireRequest,
    body: unknown,
    idempotencyKey: IdempotencyKey | null,
    bodySha256: Sha256Hex,
    at: number,
  ): Promise<Authenticated> {
    if (found.name === 'authRefresh') {
      const { refreshToken } = body as { refreshToken: string };
      const record = refreshTokens.get(refreshToken);
      const player = record === undefined ? undefined : world.player(record.playerId);
      if (record === undefined || player === undefined)
        refuse('unauthorized', 'Unknown refresh token.');
      await verify(record.key, request, idempotencyKey, bodySha256);
      return {
        scope: `player:${player.id}`,
        player,
        devicePublicKey: null,
        key: record.key,
        device: record.device,
        refresh: record,
      };
    }
    if (found.endpoint.auth === 'none') {
      const devicePublicKey = DevicePublicKeySchema.parse(
        (body as { devicePublicKey: unknown }).devicePublicKey,
      );
      const key = await importVerifyKey(devicePublicKey);
      await verify(key, request, idempotencyKey, bodySha256);
      const device = deviceThumbprint(devicePublicKey);
      if (found.name === 'accountNonce' && (body as AccountNonceRequest).purpose === 'link') {
        if (bearer(request, at).access.device !== device) {
          refuse(
            'unauthorized',
            'This access token belongs to another device key. Sign the request with the key it was issued to.',
          );
        }
      }
      return { scope: `device:${device}`, player: null, devicePublicKey, key, device };
    }
    const { access, player } = bearer(request, at);
    await verify(access.key, request, idempotencyKey, bodySha256);
    return {
      scope: `player:${player.id}`,
      player,
      devicePublicKey: null,
      key: access.key,
      device: access.device,
    };
  }

  async function runAuth(
    name: 'authGuest' | 'authRefresh',
    auth: Authenticated,
    body: unknown,
    at: number,
  ) {
    if (name === 'authGuest') {
      const { turnstileToken, locale } = body as {
        turnstileToken: string;
        locale: MockPlayer['locale'];
      };
      if (usedTurnstile.has(turnstileToken))
        throw new MockFailure('forbidden', 'That Turnstile token was already used.');
      usedTurnstile.add(turnstileToken);
      const devicePublicKey = auth.devicePublicKey;
      if (devicePublicKey === null) throw new Error('Mock: guest sign-up lost its device key.');
      const player =
        world.bindDevice(devicePublicKey, auth.key) ??
        (await world.createPlayer(
          PlayerIdSchema.parse(crypto.randomUUID()),
          devicePublicKey,
          auth.key,
          locale,
          at,
        ));
      return issueTokens({ playerId: player.id, key: auth.key, device: auth.device, via: null });
    }
    const player = auth.player;
    const record = auth.refresh;
    if (player === null || record === undefined)
      throw new Error('Mock: refresh lost its token record.');
    if (record.revoked) {
      // A revoked token coming back means it leaked: cut off every session of this player.
      revokeAll(player.id);
      throw new MockFailure(
        'unauthorized',
        'That refresh token was already rotated; sign in again.',
      );
    }
    return issueTokens(record);
  }

  function signedInPlayer(auth: Authenticated, name: AccountEndpointName): MockPlayer {
    if (auth.player === null)
      throw new Error(`Mock: ${name} reached its handler without a player.`);
    return auth.player;
  }

  /** No account request carries a value: links map identities, sign-ins hand out sessions. */
  async function runAccount(
    name: AccountEndpointName,
    auth: Authenticated,
    body: unknown,
    at: number,
  ): Promise<unknown> {
    const { accounts } = await persistence.accounts();
    switch (name) {
      case 'accountNonce': {
        const { provider, purpose } = body as AccountNonceRequest;
        return accounts.issueNonce({ provider, purpose, device: auth.device, now: at });
      }
      case 'authSignIn': {
        const request = body as SignInRequest;
        const signIn = await accounts.signIn(request, auth.device, at);
        const tokens = issueTokens({
          playerId: signIn.owner.id,
          key: auth.key,
          device: auth.device,
          via: signIn.firstDevice ? null : request.provider,
        });
        return {
          ...tokens,
          account: signIn.account,
          ...(signIn.choice === undefined ? {} : { choice: signIn.choice }),
        };
      }
      case 'accountLink':
        return accounts.link(
          signedInPlayer(auth, name),
          body as AccountLinkRequest,
          auth.device,
          at,
        );
      case 'accountUnlink': {
        const player = signedInPlayer(auth, name);
        const { provider } = body as AccountUnlinkRequest;
        const account = accounts.unlink(player, provider, auth.device, at);
        revokeAdmitted(player.id, provider, auth.device);
        return account;
      }
      case 'account':
        return accounts.account(signedInPlayer(auth, name).id);
    }
  }

  /** Mirrors the server: replay only inside the window, never a bundle whose session was revoked since. */
  function replayRefresh(stored: StoredResponse, at: number): WireResponse {
    const age = at - stored.at;
    if (age > MOCK_RULES.authRefreshReplayWindowMs) {
      return fail(
        'idempotency_key_reused',
        'This Idempotency-Key was already used for an auth request that expired.',
      );
    }
    if (stored.response.status !== 200) return stored.response;
    const tokens = endpoints.authRefresh.response.parse(stored.response.body);
    if (refreshTokens.get(tokens.refreshToken)?.revoked !== false) {
      return fail('unauthorized', 'The session this refresh issued was revoked since.');
    }
    return { status: 200, body: { ...tokens, accessTokenTtlMs: tokens.accessTokenTtlMs - age } };
  }

  async function process(request: WireRequest): Promise<WireResponse> {
    const at = now();
    const found = route(request.method, request.path);
    if (found === null) return fail('not_found', `No endpoint ${request.method} ${request.path}.`);
    if (request.body !== null && utf8Bytes(request.body).byteLength > MOCK_RULES.maxBodyBytes) {
      return fail('payload_too_large', `Bodies are capped at ${MOCK_RULES.maxBodyBytes} bytes.`);
    }
    if ((found.endpoint.body === null) !== (request.body === null)) {
      return fail(
        'bad_request',
        `${found.name} ${found.endpoint.body === null ? 'takes no' : 'needs a JSON'} body.`,
      );
    }
    let raw: unknown;
    try {
      raw = request.body === null ? undefined : JSON.parse(request.body);
    } catch {
      return fail('bad_request', 'The body is not valid JSON.');
    }
    let idempotencyKey: IdempotencyKey | null = null;
    if (requiresIdempotencyKey(found.endpoint)) {
      const parsedKey = IdempotencyKeySchema.safeParse(header(request, HEADERS.idempotencyKey));
      if (!parsedKey.success)
        return fail('idempotency_key_missing', 'POST requests need a UUID Idempotency-Key.');
      idempotencyKey = parsedKey.data;
    }
    const bodySha256 = request.body === null ? EMPTY_BODY_SHA256 : await sha256Hex(request.body);
    const body = parseBody(found, raw);
    const auth = await authenticate(found, request, body, idempotencyKey, bodySha256, at);
    enforceEnvelope(auth.scope, at);

    const burnsKey = BURNS_KEY.has(found.name);
    if (burnsKey && idempotencyKey !== null && !burnedKeys.burn(idempotencyKey, at)) {
      return fail(
        'idempotency_key_reused',
        'This Idempotency-Key was already used to sign in. Sign the request again with a new key.',
      );
    }

    tableReplays.prune(at);
    otherReplays.prune(at);
    const replays = TICK_GATED.has(found.name) ? tableReplays : otherReplays;
    const fingerprint = `${request.method} ${request.path} ${bodySha256}`;
    const storeKey = idempotencyKey === null || burnsKey ? null : `${auth.scope}:${idempotencyKey}`;
    const stored =
      storeKey === null ? undefined : (tableReplays.get(storeKey) ?? otherReplays.get(storeKey));
    if (stored !== undefined) {
      if (stored.fingerprint !== fingerprint) {
        return fail(
          'idempotency_key_reused',
          'This Idempotency-Key was already used for a different request.',
        );
      }
      return found.name === 'authRefresh' ? replayRefresh(stored, at) : stored.response;
    }

    let response: WireResponse;
    try {
      let result: unknown;
      if (isAccountOperation(found.name)) {
        result = await runAccount(found.name, auth, body, at);
      } else if (found.name === 'authGuest' || found.name === 'authRefresh') {
        result = await runAuth(found.name, auth, body, at);
      } else {
        const player = auth.player;
        if (player === null)
          throw new Error(`Mock: ${found.name} reached a handler without a player.`);
        const params =
          found.endpoint.params === null
            ? undefined
            : found.endpoint.params.safeParse(found.params);
        if (params !== undefined && !params.success) {
          return {
            status: errorStatus('validation_failed'),
            body: validationErrorEnvelope(params.error, 'Path parameters are invalid.'),
          };
        }
        let query: StateQuery = {};
        if (found.endpoint.query !== undefined) {
          const [, search = ''] = request.path.split('?');
          const parsed = found.endpoint.query.safeParse(
            Object.fromEntries(new URLSearchParams(search)),
          );
          if (!parsed.success) {
            return {
              status: errorStatus('validation_failed'),
              body: validationErrorEnvelope(parsed.error, 'Query parameters are invalid.'),
            };
          }
          query = parsed.data as StateQuery;
        }
        result =
          found.name === 'tableSnapshot'
            ? world.snapshot(player, body as TableSnapshotRequest, at)
            : await world.handle(
                player,
                found.name,
                body as never,
                params?.data as never,
                at,
                query,
              );
        world.touch(player, at);
      }
      const checked = found.endpoint.response.safeParse(result);
      if (!checked.success) {
        return fail(
          'internal',
          `Mock ${found.name} broke its own response contract: ${checked.error.message}`,
        );
      }
      response = { status: 200, body: JSON.parse(JSON.stringify(checked.data)) as unknown };
    } catch (error) {
      if (!(error instanceof MockFailure)) throw error;
      response = fail(
        error.code,
        error.message,
        error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs },
      );
    }
    const replayable = response.status === 200 || !REPLAYS_SUCCESS_ONLY.has(found.name);
    if (storeKey !== null && replayable) replays.set(storeKey, { fingerprint, response, at });
    return response;
  }

  /*
   * Encoding the whole world costs real main-thread time once the ledger is full, so it runs
   * only when a write is due: debounced after a burst, or every `persistMaxWaitMs` while play
   * keeps the queue busy, and only ever between requests. Tokens, replay stores, Turnstile
   * tokens and rate windows are deliberately not stored: the client's tokens and outbox live in
   * page memory and die with the reload, and a seeded page would replay the same idempotency
   * keys. Every guard against spending a coin or crate twice lives in the world, which is stored.
   */
  const persistDelayMs = options.persistDelayMs ?? DEFAULT_PERSIST_DELAY_MS;
  const persistMaxWaitMs = options.persistMaxWaitMs ?? persistDelayMs * 4;
  let inFlight = 0;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  let saveWhenIdle = false;
  let unsaved = false;

  function saveNow(): void {
    if (saveTimer !== null) clearTimeout(saveTimer);
    if (maxWaitTimer !== null) clearTimeout(maxWaitTimer);
    saveTimer = null;
    maxWaitTimer = null;
    if (inFlight > 0) {
      // A hidden page may never run again, and the running handler may sit between two awaits.
      persistence.writeCaptured();
      saveWhenIdle = true;
      return;
    }
    saveWhenIdle = false;
    if (unsaved) persistence.capture();
    unsaved = false;
    persistence.writeCaptured();
  }

  function scheduleSave(): void {
    if (storage === null) return;
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, persistDelayMs);
    maxWaitTimer ??= setTimeout(saveNow, persistMaxWaitMs);
  }

  const lifecycle =
    options.lifecycle === undefined
      ? typeof window === 'undefined'
        ? null
        : window
      : options.lifecycle;
  if (storage !== null && lifecycle !== null) {
    // A mobile browser may discard a hidden tab and reload it later, without a pagehide.
    lifecycle.addEventListener('visibilitychange', saveNow);
    lifecycle.addEventListener('pagehide', saveNow);
  }

  async function handleSafely(request: WireRequest): Promise<WireResponse> {
    inFlight += 1;
    try {
      return await process(request);
    } catch (error) {
      if (error instanceof Refusal) return error.response;
      const message = error instanceof Error ? error.message : String(error);
      return fail('internal', `Mock server bug: ${message}`);
    } finally {
      inFlight -= 1;
      unsaved = true;
      if (saveWhenIdle) saveNow();
      else scheduleSave();
    }
  }

  const transport: Transport = (request) => {
    if (network === 'down') {
      return Promise.reject(
        new NetworkError(`${request.method} ${request.path}: the Demo Mode server is unreachable.`),
      );
    }
    const lose = network === 'dropResponses';
    const run = queue.then(() => handleSafely(request));
    queue = run;
    return run.then((response) => {
      if (lose) throw new NetworkError(`${request.method} ${request.path}: the response was lost.`);
      return structuredClone(response);
    });
  };

  return {
    transport,
    world,
    accounts: async () => (await persistence.accounts()).accounts,
    identity: async () => (await persistence.accounts()).identity,
    ledger: () => world.ledger,
    retainedReplays: () => tableReplays.size + otherReplays.size,
    retainedBurnedKeys: () => burnedKeys.size,
    setNetwork(next) {
      network = next;
    },
    restored: persistence.restored,
    flush: () => {
      if (storage !== null) saveNow();
    },
  };
}
