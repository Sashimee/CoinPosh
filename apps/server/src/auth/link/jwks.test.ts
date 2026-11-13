import { describe, expect, it } from 'vitest';
import { ApiFailure } from '../../http/errors.ts';
import {
  JWKS_MAX_STALE_MS,
  JWKS_MAX_TTL_MS,
  JWKS_MIN_TTL_MS,
  JWKS_REFETCH_INTERVAL_MS,
  JwksCache,
} from './jwks.ts';
import { LocalJwks, newSigningKey } from './testIssuer.ts';

const URL_A = 'https://issuer.test/keys';

async function setup() {
  const jwks = new LocalJwks();
  const k1 = await newSigningKey('k1');
  jwks.publish(URL_A, [k1]);
  let now = 1_800_000_000_000;
  const cache = new JwksCache(jwks.fetcher, () => now);
  return {
    jwks,
    cache,
    k1,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('JwksCache', () => {
  it('fetches once and serves every later lookup from the cache until max-age', async () => {
    const { jwks, cache, advance } = await setup();
    await expect(cache.key(URL_A, 'k1', 'Test')).resolves.not.toBeNull();
    await expect(cache.key(URL_A, 'k1', 'Test')).resolves.not.toBeNull();
    advance(3600 * 1000 - 1);
    await cache.key(URL_A, 'k1', 'Test');
    expect(jwks.fetches).toHaveLength(1);
    advance(1);
    await cache.key(URL_A, 'k1', 'Test');
    expect(jwks.fetches).toHaveLength(2);
  });

  it('collapses concurrent cold lookups into one fetch', async () => {
    const { jwks, cache } = await setup();
    await Promise.all(Array.from({ length: 8 }, () => cache.key(URL_A, 'k1', 'Test')));
    expect(jwks.fetches).toHaveLength(1);
  });

  it('picks up a rotated key, but refetches for unknown kids at most once per interval', async () => {
    const { jwks, cache, advance } = await setup();
    await cache.key(URL_A, 'k1', 'Test');
    const k2 = await newSigningKey('k2');
    jwks.publish(URL_A, [k2]);

    await expect(cache.key(URL_A, 'k2', 'Test')).resolves.toBeNull();
    for (let i = 0; i < 20; i++) await cache.key(URL_A, `forged-${i}`, 'Test');
    expect(jwks.fetches).toHaveLength(1);

    advance(JWKS_REFETCH_INTERVAL_MS);
    await expect(cache.key(URL_A, 'k2', 'Test')).resolves.not.toBeNull();
    expect(jwks.fetches).toHaveLength(2);
  });

  it('clamps Cache-Control max-age between the floor and the ceiling', async () => {
    const tiny = await setup();
    tiny.jwks.maxAgeSeconds = 1;
    await tiny.cache.key(URL_A, 'k1', 'Test');
    tiny.advance(JWKS_MIN_TTL_MS - 1);
    await tiny.cache.key(URL_A, 'k1', 'Test');
    expect(tiny.jwks.fetches).toHaveLength(1);

    const huge = await setup();
    huge.jwks.maxAgeSeconds = 10 * 365 * 24 * 3600;
    await huge.cache.key(URL_A, 'k1', 'Test');
    huge.advance(JWKS_MAX_TTL_MS);
    await huge.cache.key(URL_A, 'k1', 'Test');
    expect(huge.jwks.fetches).toHaveLength(2);
  });

  it('rides out a provider outage on the last good keys, then gives up after the stale window', async () => {
    const { jwks, cache, advance } = await setup();
    await cache.key(URL_A, 'k1', 'Test');
    jwks.failing = true;
    advance(3600 * 1000);
    await expect(cache.key(URL_A, 'k1', 'Test')).resolves.not.toBeNull();
    advance(JWKS_MAX_STALE_MS);
    const failure = await cache.key(URL_A, 'k1', 'Test').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiFailure);
    expect((failure as ApiFailure).code).toBe('provider_unavailable');
  });

  it('answers provider_unavailable when the keys were never reachable', async () => {
    const { jwks, cache } = await setup();
    jwks.failing = true;
    await expect(cache.key(URL_A, 'k1', 'Test')).rejects.toMatchObject({
      code: 'provider_unavailable',
    });
  });

  it('skips non-RS256 and malformed keys without dropping the good ones', async () => {
    const { k1 } = await setup();
    const fetcher = () =>
      Promise.resolve(
        Response.json({
          keys: [
            { kty: 'EC', kid: 'ec', crv: 'P-256', x: 'a', y: 'b' },
            { ...k1.publicJwk, kid: 'hs', alg: 'HS256' },
            { ...k1.publicJwk, kid: 'enc', use: 'enc' },
            { kty: 'RSA', kid: 'broken', n: '!!', e: 'AQAB' },
            k1.publicJwk,
          ],
        }),
      );
    const cache = new JwksCache(fetcher);
    await expect(cache.key(URL_A, 'k1', 'Test')).resolves.not.toBeNull();
    for (const kid of ['ec', 'hs', 'enc', 'broken']) {
      await expect(cache.key(URL_A, kid, 'Test')).resolves.toBeNull();
    }
  });
});
