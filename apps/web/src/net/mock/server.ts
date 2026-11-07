import {
  DevicePublicKeySchema,
  DeviceSignatureSchema,
  EMPTY_BODY_SHA256,
  ENDPOINT_NAMES,
  HEADERS,
  IdempotencyKeySchema,
  PlayerIdSchema,
  canonicalRequest,
  endpoints,
  errorEnvelope,
  errorStatus,
  requiresIdempotencyKey,
  validationErrorEnvelope,
  type DevicePublicKey,
  type Endpoint,
  type EndpointName,
  type ErrorCode,
  type ErrorEnvelope,
  type IdempotencyKey,
  type PlayerId,
  type Sha256Hex,
} from '@coinposh/shared';
import { fromBase64Url, randomBase62, sha256Hex, utf8Bytes } from '../encoding.ts';
import { NetworkError } from '../errors.ts';
import type { Transport, WireRequest, WireResponse } from '../wire.ts';
import { MOCK_RULES } from './rules.ts';
import {
  MockFailure,
  MockWorld,
  deviceThumbprint,
  type LedgerEntry,
  type MockPlayer,
} from './world.ts';

/** `down` refuses every request; `dropResponses` runs it but loses the answer, like a cut connection. */
export type MockNetwork = 'up' | 'down' | 'dropResponses';

export interface MockServerOptions {
  /** Server time. Every rule reads this clock, never a timestamp the client sent. */
  readonly now?: () => number;
}

export interface MockServer {
  readonly transport: Transport;
  readonly world: MockWorld;
  ledger(): readonly LedgerEntry[];
  setNetwork(network: MockNetwork): void;
}

interface StoredResponse {
  readonly fingerprint: string;
  readonly response: WireResponse;
}

interface RefreshRecord {
  readonly playerId: PlayerId;
  revoked: boolean;
}

interface Route {
  readonly name: EndpointName;
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
  for (const name of ENDPOINT_NAMES) {
    const endpoint: Endpoint = endpoints[name];
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
  const world = new MockWorld();
  const accessTokens = new Map<string, { playerId: PlayerId; expiresAt: number }>();
  const refreshTokens = new Map<string, RefreshRecord>();
  const idempotency = new Map<string, StoredResponse>();
  const usedTurnstile = new Set<string>();
  const recentRequests = new Map<string, number[]>();
  let network: MockNetwork = 'up';
  let queue: Promise<unknown> = Promise.resolve();

  function issueTokens(player: MockPlayer) {
    for (const record of refreshTokens.values()) {
      if (record.playerId === player.id) record.revoked = true;
    }
    const accessToken = `at_${randomBase62(40)}`;
    const refreshToken = `rt_${randomBase62(48)}`;
    accessTokens.set(accessToken, {
      playerId: player.id,
      expiresAt: now() + MOCK_RULES.accessTokenTtlMs,
    });
    refreshTokens.set(refreshToken, { playerId: player.id, revoked: false });
    return {
      playerId: player.id,
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

  async function authenticate(
    found: Route,
    request: WireRequest,
    body: unknown,
    idempotencyKey: IdempotencyKey | null,
    bodySha256: Sha256Hex,
    at: number,
  ) {
    if (found.name === 'authGuest') {
      const devicePublicKey = DevicePublicKeySchema.parse(
        (body as { devicePublicKey: unknown }).devicePublicKey,
      );
      const key = await importVerifyKey(devicePublicKey);
      await verify(key, request, idempotencyKey, bodySha256);
      return {
        scope: `device:${deviceThumbprint(devicePublicKey)}`,
        player: null,
        devicePublicKey,
        key,
      };
    }
    if (found.name === 'authRefresh') {
      const { refreshToken } = body as { refreshToken: string };
      const record = refreshTokens.get(refreshToken);
      const player = record === undefined ? undefined : world.player(record.playerId);
      if (record === undefined || player === undefined)
        refuse('unauthorized', 'Unknown refresh token.');
      await verify(player.deviceKey, request, idempotencyKey, bodySha256);
      return {
        scope: `player:${player.id}`,
        player,
        devicePublicKey: null,
        key: player.deviceKey,
        refresh: record,
      };
    }
    const authorization = header(request, HEADERS.authorization);
    const token =
      authorization?.startsWith('Bearer ') === true ? authorization.slice('Bearer '.length) : null;
    const access = token === null ? undefined : accessTokens.get(token);
    const player = access === undefined ? undefined : world.player(access.playerId);
    if (access === undefined || player === undefined)
      refuse('unauthorized', 'Missing or unknown access token.');
    if (at >= access.expiresAt)
      refuse('token_expired', 'The access token has expired; refresh it.');
    await verify(player.deviceKey, request, idempotencyKey, bodySha256);
    return { scope: `player:${player.id}`, player, devicePublicKey: null, key: player.deviceKey };
  }

  async function runAuth(
    name: 'authGuest' | 'authRefresh',
    auth: Awaited<ReturnType<typeof authenticate>>,
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
      const existing = world.playerByDevice(deviceThumbprint(devicePublicKey));
      const player =
        existing ??
        (await world.createPlayer(
          PlayerIdSchema.parse(crypto.randomUUID()),
          devicePublicKey,
          auth.key,
          locale,
          at,
        ));
      return issueTokens(player);
    }
    const player = auth.player;
    const record = 'refresh' in auth ? auth.refresh : undefined;
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
    return issueTokens(player);
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

    const fingerprint = `${request.method} ${request.path} ${bodySha256}`;
    const storeKey = idempotencyKey === null ? null : `${auth.scope}:${idempotencyKey}`;
    const stored = storeKey === null ? undefined : idempotency.get(storeKey);
    if (stored !== undefined) {
      if (stored.fingerprint !== fingerprint) {
        return fail(
          'idempotency_key_reused',
          'This Idempotency-Key was already used for a different request.',
        );
      }
      return stored.response;
    }

    let response: WireResponse;
    try {
      let result: unknown;
      if (found.name === 'authGuest' || found.name === 'authRefresh') {
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
        result = await world.handle(player, found.name, body as never, params?.data as never, at);
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
      response = fail(error.code, error.message);
    }
    if (storeKey !== null) idempotency.set(storeKey, { fingerprint, response });
    return response;
  }

  async function handleSafely(request: WireRequest): Promise<WireResponse> {
    try {
      return await process(request);
    } catch (error) {
      if (error instanceof Refusal) return error.response;
      const message = error instanceof Error ? error.message : String(error);
      return fail('internal', `Mock server bug: ${message}`);
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
    ledger: () => world.ledger,
    setNetwork(next) {
      network = next;
    },
  };
}
