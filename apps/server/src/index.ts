import { errorEnvelope } from '@coinposh/shared';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from './http/context.ts';
import { corsMiddleware } from './http/cors.ts';
import { ApiFailure } from './http/errors.ts';
import { originGuardMiddleware, requestIdMiddleware } from './http/signed.ts';
import { authRoutes } from './routes/auth.ts';
import { tableRoutes } from './routes/table.ts';

export type { Env } from './env.ts';
export { PlayerDO } from './do/PlayerDO.ts';

export const app = new Hono<AppEnv>();

app.use(requestIdMiddleware, originGuardMiddleware, corsMiddleware);

app.get('/health', (c) => c.json({ status: 'ok', service: 'coinposh-server' }));

app.route('/', authRoutes);
app.route('/', tableRoutes);

app.notFound((c) => c.json(errorEnvelope('not_found', 'No such route.'), 404));

app.onError((error, c) => {
  const requestId = c.get('requestId');
  if (error instanceof ApiFailure) {
    if (error.extra.retryAfterMs !== undefined) {
      c.header('Retry-After', String(Math.ceil(error.extra.retryAfterMs / 1000)));
    }
    return c.json(error.envelope(requestId), error.status as ContentfulStatusCode);
  }
  console.error(`Unhandled error on ${c.req.method} ${c.req.path} [${requestId}]`, error);
  return c.json(
    errorEnvelope('internal', 'Something went wrong on our side. Retry shortly.', { requestId }),
    500,
  );
});

export default app;
