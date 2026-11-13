import type { HttpMethod } from '@coinposh/shared';
import { NetworkError } from './errors.ts';

export interface WireRequest {
  readonly method: HttpMethod;
  /** Path plus query, exactly as signed. */
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  /** The exact JSON bytes that were hashed and signed; `null` for GET. */
  readonly body: string | null;
  /** Lets the request outlive the page, for the last snapshot sent on `pagehide`. */
  readonly keepalive?: boolean;
}

export interface WireResponse {
  readonly status: number;
  /** Parsed JSON, or `undefined` when the response had no parseable body. */
  readonly body: unknown;
}

/** Rejects with {@link NetworkError} when the server could not be reached. */
export type Transport = (request: WireRequest) => Promise<WireResponse>;

const DEFAULT_TIMEOUT_MS = 10_000;

export function fetchTransport(
  baseUrl: string,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Transport {
  return async (request) => {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${request.path}`, {
        method: request.method,
        headers:
          request.body === null
            ? request.headers
            : { ...request.headers, 'Content-Type': 'application/json' },
        body: request.body,
        credentials: 'omit',
        cache: 'no-store',
        keepalive: request.keepalive === true,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new NetworkError(`${request.method} ${request.path} did not reach the server.`, {
        cause: error,
      });
    }
    const text = await response.text();
    let body: unknown;
    try {
      body = text === '' ? undefined : JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: response.status, body };
  };
}
