import { z } from 'zod';
import { DurationMsSchema } from './primitives.ts';

export const ERROR_STATUS = {
  bad_request: 400,
  validation_failed: 400,
  idempotency_key_missing: 400,
  unauthorized: 401,
  invalid_signature: 401,
  token_expired: 401,
  forbidden: 403,
  feature_disabled: 403,
  not_found: 404,
  conflict: 409,
  idempotency_in_progress: 409,
  insufficient_funds: 409,
  not_ready: 409,
  table_frozen: 409,
  payload_too_large: 413,
  idempotency_key_reused: 422,
  rate_limited: 429,
  internal: 500,
  unavailable: 503,
} as const satisfies Record<string, number>;

export type ErrorCode = keyof typeof ERROR_STATUS;
export const ERROR_CODES = Object.keys(ERROR_STATUS) as [ErrorCode, ...ErrorCode[]];
export const ErrorCodeSchema = z.enum(ERROR_CODES);

export const ErrorIssueSchema = z.object({
  path: z.array(z.union([z.string(), z.int()])),
  message: z.string(),
});
export type ErrorIssue = z.infer<typeof ErrorIssueSchema>;

/** The body of every non-2xx response. `message` is for logs; the client localizes by `code`. */
export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string().min(1),
    requestId: z.string().min(1).max(128).optional(),
    retryAfterMs: DurationMsSchema.optional(),
    issues: z.array(ErrorIssueSchema).optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
export type ApiError = ErrorEnvelope['error'];

export function errorStatus(code: ErrorCode): number {
  return ERROR_STATUS[code];
}

export function errorEnvelope(
  code: ErrorCode,
  message: string,
  extra: Omit<ApiError, 'code' | 'message'> = {},
): ErrorEnvelope {
  return { error: { code, message, ...extra } };
}

export function validationErrorEnvelope(
  error: z.ZodError,
  message = 'Request is invalid.',
): ErrorEnvelope {
  return errorEnvelope('validation_failed', message, {
    issues: error.issues.map((issue) => ({
      path: issue.path.map((key) => (typeof key === 'number' ? key : String(key))),
      message: issue.message,
    })),
  });
}
