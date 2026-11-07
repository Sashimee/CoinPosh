import { describe, expect, it } from 'vitest';
import { app } from './index.ts';

describe('GET /health', () => {
  it('answers 200 with an ok status', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ status: 'ok', service: 'coinposh-server' });
  });

  it('rejects non-GET methods on /health', async () => {
    const res = await app.request('/health', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('unknown routes', () => {
  it('answer 404 with a JSON error envelope', async () => {
    const res = await app.request('/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'No such route.' } });
  });
});
