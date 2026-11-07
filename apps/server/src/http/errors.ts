import {
  errorEnvelope,
  errorStatus,
  validationErrorEnvelope,
  type ApiError,
  type ErrorCode,
  type ErrorEnvelope,
} from '@coinposh/shared';
import type { z } from 'zod';

/** Thrown anywhere in a request to answer with the shared error envelope. */
export class ApiFailure extends Error {
  readonly code: ErrorCode;
  readonly extra: Omit<ApiError, 'code' | 'message'>;

  constructor(code: ErrorCode, message: string, extra: Omit<ApiError, 'code' | 'message'> = {}) {
    super(message);
    this.name = 'ApiFailure';
    this.code = code;
    this.extra = extra;
  }

  static validation(error: z.ZodError, message: string): ApiFailure {
    const { issues } = validationErrorEnvelope(error).error;
    return new ApiFailure('validation_failed', message, issues ? { issues } : {});
  }

  get status(): number {
    return errorStatus(this.code);
  }

  envelope(requestId: string): ErrorEnvelope {
    return errorEnvelope(this.code, this.message, { ...this.extra, requestId });
  }
}
