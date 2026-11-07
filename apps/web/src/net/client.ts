import {
  endpoints,
  requiresIdempotencyKey,
  type Endpoint,
  type EndpointName,
  type EndpointResponse,
  type IdempotencyKey,
} from '@coinposh/shared';
import type { ServerClock } from './clock.ts';
import type { DeviceKey } from './device.ts';
import { ApiRequestError, isAuthExpired, isRetryable } from './errors.ts';
import { newIdempotencyKey, readResponse, signRequest, type CallInput } from './request.ts';
import type { Session } from './session.ts';
import type { Transport } from './wire.ts';

export interface CallOptions {
  /**
   * Reuse a key to make a resend replay-safe: the server answers a repeated key with the
   * response it already gave. Omitted, a fresh key is drawn once and kept across retries.
   */
  readonly idempotencyKey?: IdempotencyKey;
  /** Extra attempts after a network failure or a retryable server error. */
  readonly retries?: number;
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

  constructor(deps: ApiClientDeps) {
    this.#deps = deps;
    this.#retry = deps.retry ?? DEFAULT_RETRY;
    this.#sleep = deps.sleep ?? realSleep;
    this.#jitter = deps.jitter ?? Math.random;
  }

  async call<N extends EndpointName>(name: N, ...args: CallArgs<N>): Promise<EndpointResponse<N>> {
    const [input = {} as CallInput<N>, options = {}] = args;
    const endpoint: Endpoint = endpoints[name];
    const idempotencyKey = requiresIdempotencyKey(endpoint)
      ? (options.idempotencyKey ?? newIdempotencyKey())
      : null;
    const retries = options.retries ?? this.#retry.retries;
    let reauthenticated = false;
    for (let attempt = 0; ; attempt++) {
      try {
        const accessToken =
          endpoint.auth === 'bearer' ? await this.#deps.session.accessToken() : null;
        const request = await signRequest(
          name,
          input,
          { idempotencyKey, accessToken },
          this.#deps.device,
        );
        const response = readResponse(name, await this.#deps.transport(request));
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
