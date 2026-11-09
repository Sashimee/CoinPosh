import {
  EMPTY_BODY_SHA256,
  HEADERS,
  canonicalRequest,
  type IdempotencyKey,
} from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import { loadOrCreateDeviceKey } from './device.ts';
import { fromBase64Url, sha256Hex, utf8Bytes } from './encoding.ts';
import { ApiRequestError } from './errors.ts';
import { ContractViolationError, newIdempotencyKey, readResponse, signRequest } from './request.ts';
import { memoryStore } from './store.ts';

async function verifyKey(device: Awaited<ReturnType<typeof loadOrCreateDeviceKey>>) {
  return crypto.subtle.importKey(
    'jwk',
    {
      kty: device.publicKey.kty,
      crv: device.publicKey.crv,
      x: device.publicKey.x,
      y: device.publicKey.y,
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
}

describe('signRequest', () => {
  it('signs the canonical request with a key that never leaves WebCrypto', async () => {
    const store = memoryStore();
    const device = await loadOrCreateDeviceKey(store);
    const key = newIdempotencyKey();
    const request = await signRequest(
      'tableDrop',
      { body: { x: 0.5, tick: 42 } },
      { idempotencyKey: key, accessToken: 'at_token' },
      device,
    );
    expect(request).toMatchObject({
      method: 'POST',
      path: '/v1/table/drop',
      body: '{"x":0.5,"tick":42}',
    });
    expect(request.headers[HEADERS.idempotencyKey]).toBe(key);
    expect(request.headers[HEADERS.authorization]).toBe('Bearer at_token');
    const message = canonicalRequest({
      method: 'POST',
      pathWithQuery: '/v1/table/drop',
      idempotencyKey: key,
      bodySha256: await sha256Hex(request.body ?? ''),
    });
    const signature = fromBase64Url(request.headers[HEADERS.deviceSignature] ?? '');
    await expect(
      crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        await verifyKey(device),
        signature,
        utf8Bytes(message),
      ),
    ).resolves.toBe(true);

    const stored = (await store.get('device-key')) as CryptoKeyPair;
    expect(stored.privateKey.extractable).toBe(false);
    expect('d' in device.publicKey).toBe(false);
  });

  it('reuses the stored device key across reloads', async () => {
    const store = memoryStore();
    const first = await loadOrCreateDeviceKey(store);
    const second = await loadOrCreateDeviceKey(store);
    expect(second.publicKey).toEqual(first.publicKey);
  });

  it('signs GETs over the empty body and fills path parameters', async () => {
    const device = await loadOrCreateDeviceKey(memoryStore());
    const request = await signRequest(
      'leaderboard',
      { params: { board: 'weekly' } },
      { idempotencyKey: null, accessToken: 'at_token' },
      device,
    );
    expect(request).toMatchObject({ method: 'GET', path: '/v1/leaderboard/weekly', body: null });
    expect(request.headers[HEADERS.idempotencyKey]).toBeUndefined();
    const message = canonicalRequest({
      method: 'GET',
      pathWithQuery: '/v1/leaderboard/weekly',
      idempotencyKey: null,
      bodySha256: EMPTY_BODY_SHA256,
    });
    const signature = fromBase64Url(request.headers[HEADERS.deviceSignature] ?? '');
    await expect(
      crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        await verifyKey(device),
        signature,
        utf8Bytes(message),
      ),
    ).resolves.toBe(true);
  });

  it('puts the boot flag in the signed query, and nothing for a plain snapshot', async () => {
    const device = await loadOrCreateDeviceKey(memoryStore());
    const signed = { idempotencyKey: null, accessToken: 'at_token' };
    const boot = await signRequest('state', { query: { hydrate: 'boot' } }, signed, device);
    expect(boot.path).toBe('/v1/state?hydrate=boot');
    const message = canonicalRequest({
      method: 'GET',
      pathWithQuery: '/v1/state?hydrate=boot',
      idempotencyKey: null,
      bodySha256: EMPTY_BODY_SHA256,
    });
    await expect(
      crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        await verifyKey(device),
        fromBase64Url(boot.headers[HEADERS.deviceSignature] ?? ''),
        utf8Bytes(message),
      ),
    ).resolves.toBe(true);
    expect((await signRequest('state', {}, signed, device)).path).toBe('/v1/state');
    expect((await signRequest('state', { query: {} }, signed, device)).path).toBe('/v1/state');
  });

  it('refuses a query outside the contract, or on an endpoint that takes none', async () => {
    const device = await loadOrCreateDeviceKey(memoryStore());
    const signed = { idempotencyKey: null, accessToken: 'at' };
    const forged = { hydrate: 'boot', refund: 'all' } as unknown as { hydrate: 'boot' };
    await expect(signRequest('state', { query: forged }, signed, device)).rejects.toBeInstanceOf(
      ContractViolationError,
    );
    const stray = { query: { hydrate: 'boot' } } as unknown as Record<string, never>;
    await expect(signRequest('album', stray, signed, device)).rejects.toThrow(/takes no query/);
  });

  it('refuses to put an out-of-contract body on the wire', async () => {
    const device = await loadOrCreateDeviceKey(memoryStore());
    const smuggled = { x: 0, tick: 1, value: 1_000 } as unknown as { x: number; tick: number };
    await expect(
      signRequest(
        'tableDrop',
        { body: smuggled },
        { idempotencyKey: newIdempotencyKey(), accessToken: 'at' },
        device,
      ),
    ).rejects.toBeInstanceOf(ContractViolationError);
  });

  it('refuses a mutation without an idempotency key and a bearer call without a token', async () => {
    const device = await loadOrCreateDeviceKey(memoryStore());
    await expect(
      signRequest(
        'tableNudge',
        { body: { tick: 1, direction: 'left' } },
        { idempotencyKey: null, accessToken: 'at' },
        device,
      ),
    ).rejects.toThrow(/Idempotency-Key/);
    await expect(
      signRequest('state', {}, { idempotencyKey: null, accessToken: null }, device),
    ).rejects.toThrow(/bearer/);
  });
});

describe('readResponse', () => {
  it('parses a 2xx through the response schema', () => {
    const body = { serverTime: 1, goldenHour: null, heist: null };
    expect(readResponse('eventsCurrent', { status: 200, body })).toEqual(body);
  });

  it('treats a 2xx outside the contract as a contract violation, not data', () => {
    expect(() =>
      readResponse('eventsCurrent', { status: 200, body: { serverTime: 'soon' } }),
    ).toThrow(ContractViolationError);
  });

  it('surfaces the error envelope', () => {
    const error = (() => {
      try {
        readResponse('tableDrop', {
          status: 429,
          body: {
            error: {
              code: 'rate_limited',
              message: 'slow down',
              retryAfterMs: 500,
              requestId: 'r1',
            },
          },
        });
      } catch (caught) {
        return caught;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({
      code: 'rate_limited',
      retryAfterMs: 500,
      requestId: 'r1',
      status: 429,
    });
  });

  it('maps a bodiless error by status', () => {
    const codeFor = (status: number) => {
      try {
        readResponse('state', { status, body: undefined });
      } catch (caught) {
        return caught instanceof ApiRequestError ? caught.code : null;
      }
      return null;
    };
    expect(codeFor(429)).toBe('rate_limited');
    expect(codeFor(503)).toBe('unavailable');
    expect(codeFor(502)).toBe('internal');
    expect(codeFor(418)).toBe('bad_request');
  });
});

describe('newIdempotencyKey', () => {
  it('draws distinct UUIDs', () => {
    const keys = new Set<IdempotencyKey>(Array.from({ length: 50 }, () => newIdempotencyKey()));
    expect(keys.size).toBe(50);
  });
});
