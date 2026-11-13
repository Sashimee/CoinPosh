import { endpoints } from '@coinposh/shared';
import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { app } from './index.ts';
import { API_ORIGIN } from './test/client.ts';

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

describe('POST /v1/ascend', () => {
  it('is routed and asks for a signed-in device before reaching the player', async () => {
    const res = await exports.default.fetch(
      new Request(`${API_ORIGIN}${endpoints.ascend.path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ venueId: 'rivieraYacht' }),
      }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'unauthorized' } });
  });
});
