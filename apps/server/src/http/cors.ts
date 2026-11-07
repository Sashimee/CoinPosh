import { HEADERS } from '@coinposh/shared';
import { cors } from 'hono/cors';

export const PRODUCTION_ORIGIN = 'https://sashimee.github.io';

const LOCAL_DEV_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/;

export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';

export function isAllowedOrigin(origin: string): boolean {
  return origin === PRODUCTION_ORIGIN || LOCAL_DEV_ORIGIN.test(origin);
}

export const corsMiddleware = cors({
  origin: (origin) => (isAllowedOrigin(origin) ? origin : null),
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: [
    'Content-Type',
    HEADERS.authorization,
    HEADERS.idempotencyKey,
    HEADERS.deviceSignature,
    HEADERS.requestId,
  ],
  exposeHeaders: [HEADERS.requestId, IDEMPOTENT_REPLAYED_HEADER, 'Retry-After'],
  maxAge: 600,
});
