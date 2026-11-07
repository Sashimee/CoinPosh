import type { ApiError, EndpointName, ErrorCode, ErrorIssue } from '@coinposh/shared';

/** The server answered with an error envelope (or something we had to treat as one). */
export class ApiRequestError extends Error {
  readonly endpoint: EndpointName;
  readonly status: number;
  readonly code: ErrorCode;
  readonly retryAfterMs: number | null;
  readonly requestId: string | null;
  readonly issues: readonly ErrorIssue[];

  constructor(endpoint: EndpointName, status: number, error: ApiError) {
    super(`${endpoint} failed with ${error.code} (${status}): ${error.message}`);
    this.name = 'ApiRequestError';
    this.endpoint = endpoint;
    this.status = status;
    this.code = error.code;
    this.retryAfterMs = error.retryAfterMs ?? null;
    this.requestId = error.requestId ?? null;
    this.issues = error.issues ?? [];
  }
}

/** The request may never have reached the server; resend it with the same idempotency key. */
export class NetworkError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NetworkError';
  }
}

const RETRYABLE: ReadonlySet<ErrorCode> = new Set([
  'rate_limited',
  'unavailable',
  'internal',
  'idempotency_in_progress',
]);

const AUTH_EXPIRED: ReadonlySet<ErrorCode> = new Set(['token_expired', 'unauthorized']);

export function isRetryable(error: unknown): boolean {
  if (error instanceof NetworkError) return true;
  return error instanceof ApiRequestError && RETRYABLE.has(error.code);
}

export function isAuthExpired(error: unknown): boolean {
  return error instanceof ApiRequestError && AUTH_EXPIRED.has(error.code);
}
