import {
  buildPath,
  endpoints,
  requiresIdempotencyKey,
  tableSnapshotEndpoint,
  type Endpoint,
  type EndpointName,
  type EndpointResponse,
  type IdempotencyKey,
  type TableSnapshotRequest,
  type TableSnapshotResponse,
} from '@coinposh/shared';
import type { ServerClock } from './clock.ts';
import type { DeviceKey } from './device.ts';
import { ApiRequestError, isAuthExpired, isRetryable, type ApiOperation } from './errors.ts';
import {
  newIdempotencyKey,
  readEndpointResponse,
  signEndpointRequest,
  type CallInput,
} from './request.ts';
import type { Session } from './session.ts';
import type { Transport, WireRequest } from './wire.ts';

export interface CallOptions {
  /**
   * Reuse a key to make a resend replay-safe: the server answers a repeated key with the
   * response it already gave. Omitted, a fresh key is drawn once and kept across retries.
   */
  readonly idempotencyKey?: IdempotencyKey;
  /** Extra attempts after a network failure or a retryable server error. */
  readonly retries?: number;
  /** Lets the request outlive the page, so one under way when it closes still arrives. */
  readonly keepalive?: boolean;
  /** Called as each attempt is handed to the transport, after its async signing is done. */
  readonly onWire?: () => void;
}

export type CallArgs<N extends EndpointName> =
  { readonly body?: never; readonly params?: never } extends CallInput<N>
    ? [input?: CallInput<N>, options?: CallOptions]
    : [input: CallInput<N>, options?: CallOptions];

export interface RetryPolicy {
  readonly retries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { retries: 2, baseDelayMs: 250, maxDelayMs: 8_000 };

export interface ApiClientDeps {
  readonly transport: Transport;
  readonly device: DeviceKey;
  readonly session: Session;
  readonly clock: ServerClock;
  readonly retry?: RetryPolicy;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Uniform [0, 1) for retry jitter. */
  readonly jitter?: () => number;
}

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

function isBootQuery(query: unknown): boolean {
  return (
    typeof query === 'object' &&
    query !== null &&
    'hydrate' in query &&
    (query as { hydrate?: unknown }).hydrate === 'boot'
  );
}

export function backoffDelay(
  attempt: number,
  policy: RetryPolicy,
  jitter: number,
  retryAfterMs: number | null,
): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  return Math.max(retryAfterMs ?? 0, Math.round(ceiling * (0.5 + jitter / 2)));
}

/** The typed API: every request and response goes through the `@coinposh/shared` zod contracts. */
export class ApiClient {
  readonly #deps: ApiClientDeps;
  readonly #retry: RetryPolicy;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #jitter: () => number;
  #bootGate: (() => Promise<void>) | null = null;

  constructor(deps: ApiClientDeps) {
    this.#deps = deps;
    this.#retry = deps.retry ?? DEFAULT_RETRY;
    this.#sleep = deps.sleep ?? realSleep;
    this.#jitter = deps.jitter ?? Math.random;
  }

  /**
   * Runs before every `hydrate=boot` state call and must settle first, so play queued by an
   * earlier page reaches the server before the boot rotates the table session and refunds what
   * it cannot lay again. A rejection fails the boot call, which its caller retries.
   */
  setBootGate(gate: (() => Promise<void>) | null): void {
    this.#bootGate = gate;
  }

  async call<N extends EndpointName>(name: N, ...args: CallArgs<N>): Promise<EndpointResponse<N>> {
    const [input = {} as CallInput<N>, options = {}] = args;
    if (name === 'state' && isBootQuery(input.query)) await this.#bootGate?.();
    const path = (buildPath as (n: EndpointName, params?: unknown) => string)(name, input.params);
    return (await this.#send(name, endpoints[name], path, input, options)) as EndpointResponse<N>;
  }

  /** Uploads one table snapshot: positions only, through the same retry and re-auth as `call`. */
  async snapshot(body: TableSnapshotRequest, options: CallOptions): Promise<TableSnapshotResponse> {
    return (await this.#send(
      'tableSnapshot',
      tableSnapshotEndpoint,
      tableSnapshotEndpoint.path,
      { body },
      options,
    )) as TableSnapshotResponse;
  }

  /**
   * Signs a snapshot upload now with the current access token, to be sent later by
   * {@link sendKeepalive} from `pagehide`, where there is no time left to sign anything.
   */
  async presignSnapshot(
    body: TableSnapshotRequest,
    idempotencyKey: IdempotencyKey,
  ): Promise<WireRequest> {
    const request = await signEndpointRequest(
      'tableSnapshot',
      tableSnapshotEndpoint,
      tableSnapshotEndpoint.path,
      { body },
      { idempotencyKey, accessToken: await this.#deps.session.accessToken() },
      this.#deps.device,
    );
    return { ...request, keepalive: true };
  }

  /**
   * Fires a pre-signed request without waiting for it. The page is going away, so nobody reads
   * the answer: the op it carries stays in the outbox and is resent under the same key on the
   * next load, which the server replays or refuses as stale.
   */
  sendKeepalive(request: WireRequest): void {
    this.#deps.transport(request).catch(() => undefined);
  }

  /** Called with each new access token, so a pre-signed request can be signed again. */
  onTokenRefresh(listener: () => void): () => void {
    return this.#deps.session.onTokens(listener);
  }

  async #send(
    name: ApiOperation,
    endpoint: Endpoint,
    path: string,
    input: { readonly body?: unknown; readonly query?: unknown },
    options: CallOptions,
  ): Promise<unknown> {
    const idempotencyKey = requiresIdempotencyKey(endpoint)
      ? (options.idempotencyKey ?? newIdempotencyKey())
      : null;
    const retries = options.retries ?? this.#retry.retries;
    let reauthenticated = false;
    for (let attempt = 0; ; attempt++) {
      try {
        const accessToken =
          endpoint.auth === 'bearer' ? await this.#deps.session.accessToken() : null;
        const request = await signEndpointRequest(
          name,
          endpoint,
          path,
          input,
          { idempotencyKey, accessToken },
          this.#deps.device,
        );
        options.onWire?.();
        const response = readEndpointResponse(
          name,
          endpoint,
          await this.#deps.transport(
            options.keepalive === true ? { ...request, keepalive: true } : request,
          ),
        );
        this.#observe(response);
        return response;
      } catch (error) {
        if (endpoint.auth === 'bearer' && isAuthExpired(error) && !reauthenticated) {
          reauthenticated = true;
          this.#deps.session.expireAccessToken();
          attempt--;
          continue;
        }
        if (!isRetryable(error) || attempt >= retries) throw error;
        const retryAfter = error instanceof ApiRequestError ? error.retryAfterMs : null;
        await this.#sleep(backoffDelay(attempt, this.#retry, this.#jitter(), retryAfter));
      }
    }
  }

  #observe(response: unknown): void {
    if (typeof response === 'object' && response !== null && 'serverTime' in response) {
      const { serverTime } = response;
      if (typeof serverTime === 'number') this.#deps.clock.sync(serverTime);
    }
  }
}
