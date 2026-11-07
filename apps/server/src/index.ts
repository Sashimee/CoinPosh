import { Hono } from 'hono';

export interface Env {
  readonly DB: D1Database;
}

export const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ status: 'ok', service: 'coinposh-server' }));

app.notFound((c) => c.json({ error: { code: 'not_found', message: 'No such route.' } }, 404));

export default app;
