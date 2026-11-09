import { HEADERS } from '@coinposh/shared';
import { cors } from 'hono/cors';

export const SITE_ORIGINS: ReadonlySet<string> = new Set([
  'https://coinposh.bas.lu',
  'https://devcoinposh.bas.lu',
]);

const LOCAL_DEV_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/;

export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';

export function isAllowedOrigin(origin: string): boolean {
  return SITE_ORIGINS.has(origin) || LOCAL_DEV_ORIGIN.test(origin);
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
