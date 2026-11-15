import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { composeEndpoints, type Endpoint } from '../endpoint.ts';
import { ENDPOINT_NAMES, endpoints } from '../endpoints.ts';
import { COLLECTING_ENDPOINT_NAMES, collectingEndpoints } from './endpoints.ts';

const entries = Object.entries(collectingEndpoints) as [string, Endpoint][];

/** Keys a client must never set; the server derives every one of them. */
const SERVER_OWNED_KEYS = [
  'value',
  'credited',
  'tier',
  'rarity',
  'variant',
  'polish',
  'reward',
  'laidAt',
  'serverTime',
  'collectionValue',
];

describe('collectingEndpoints', () => {
  it('names every endpoint after the theme and serves it under /v1/collecting/', () => {
    expect(COLLECTING_ENDPOINT_NAMES).toEqual(Object.keys(collectingEndpoints));
    for (const [name, endpoint] of entries) {
      expect(name).toMatch(/^collecting[A-Z]/);
      expect(endpoint.path).toMatch(/^\/v1\/collecting\/[a-z/]+$/);
      expect(endpoint.auth).toBe('bearer');
      expect(endpoint.params).toBeNull();
    }
  });

  it('gives each POST a strict body and each GET none', () => {
    for (const [name, endpoint] of entries) {
      if (endpoint.method === 'GET') {
        expect(endpoint.body, name).toBeNull();
        continue;
      }
      expect(endpoint.body, name).toBeInstanceOf(z.ZodObject);
      const body = endpoint.body as z.ZodObject;
      expect(body.def.catchall, name).toBeInstanceOf(z.ZodNever);
      expect(body.safeParse({ forged: 1 }).success, name).toBe(false);
    }
  });

  it('lets no upload carry a value, tier, reward or timestamp field', () => {
    for (const [name, endpoint] of entries) {
      if (endpoint.body === null) continue;
      const shape = Object.keys((endpoint.body as z.ZodObject).shape);
      expect(
        shape.filter((key) => SERVER_OWNED_KEYS.includes(key)),
        name,
      ).toEqual([]);
    }
  });

  it('composes with the live registry without a name or route clash', () => {
    const composed = composeEndpoints(endpoints, collectingEndpoints);
    expect(Object.keys(composed)).toEqual([...ENDPOINT_NAMES, ...COLLECTING_ENDPOINT_NAMES]);
  });

  it('is staged outside the live registry until the wiring task registers its handlers', () => {
    expect(ENDPOINT_NAMES.filter((name) => name.startsWith('collecting'))).toEqual([]);
  });
});
