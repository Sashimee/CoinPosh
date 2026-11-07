import { endpoints } from '@coinposh/shared';
import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { API_ORIGIN, newDevice, send } from '../test/client.ts';
import { expectError } from '../test/game.ts';
import { isAllowedOrigin, PRODUCTION_ORIGIN } from './cors.ts';

function preflight(origin: string) {
  return exports.default.fetch(
    new Request(`${API_ORIGIN}${endpoints.tableDrop.path}`, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,idempotency-key,x-coinposh-signature',
      },
    }),
  );
}

describe('CORS', () => {
  it.each([
    PRODUCTION_ORIGIN,
    'http://localhost:5173',
    'http://localhost',
    'http://127.0.0.1:4173',
    'https://localhost:8443',
    'http://[::1]:5173',
  ])('allows %s', async (origin) => {
    expect(isAllowedOrigin(origin)).toBe(true);
    const response = await preflight(origin);
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(response.headers.get('Access-Control-Allow-Headers')?.toLowerCase()).toContain(
      'x-coinposh-signature',
    );
  });

  it.each([
    'https://evil.example',
    'https://sashimee.github.io.evil.example',
    'https://evil-sashimee.github.io',
    'http://sashimee.github.io',
    'https://sashimee.github.io:8443',
    'https://other.github.io',
    'http://localhost.evil.example',
    'http://localhost:5173.evil.example',
    'http://192.168.1.10:5173',
    'null',
  ])('refuses %s with 403 and no CORS grant', async (origin) => {
    expect(isAllowedOrigin(origin)).toBe(false);
    const response = await preflight(origin);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    await expectError(response, 403, 'forbidden');
  });

  it('refuses a disallowed origin before doing any work, even on auth routes', async () => {
    const device = await newDevice();
    const response = await send(device, endpoints.authGuest.path, {
      origin: 'https://evil.example',
      body: { devicePublicKey: device.publicKey, turnstileToken: 't', locale: 'en' },
    });
    await expectError(response, 403, 'forbidden');
  });

  it('serves requests without an Origin (native apps, curl) and echoes a request ID', async () => {
    const response = await exports.default.fetch(new Request(`${API_ORIGIN}/health`));
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Request-Id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('exposes the idempotency and request-ID headers to the allowed origin', async () => {
    const response = await exports.default.fetch(
      new Request(`${API_ORIGIN}/health`, { headers: { Origin: PRODUCTION_ORIGIN } }),
    );
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(PRODUCTION_ORIGIN);
    const exposed = response.headers.get('Access-Control-Expose-Headers') ?? '';
    expect(exposed).toContain('Idempotent-Replayed');
    expect(exposed).toContain('X-Request-Id');
  });
});
