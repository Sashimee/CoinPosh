import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { composeEndpoints, type Endpoint } from '../endpoint.ts';
import { ENDPOINT_NAMES, endpoints } from '../endpoints.ts';
import { collectingEndpoints } from '../collecting/endpoints.ts';
import { STANDING_ENDPOINT_NAMES, standingEndpoints } from './endpoints.ts';
import { standingFixtures } from './fixtures.ts';

const entries = Object.entries(standingEndpoints) as [string, Endpoint][];

/** Keys a client must never set; the server derives every one of them. */
const SERVER_OWNED_KEYS = [
  'repute',
  'reputeIntoRank',
  'rank',
  'progress',
  'points',
  'goal',
  'status',
  'unlocked',
  'unlockedAt',
  'claimedAt',
  'rewards',
  'amount',
  'hireCost',
  'fee',
  'dailyWage',
  'wagesOwed',
  'wagesPaidUntil',
  'hiredAt',
  'idleBoostBp',
  'bonusBp',
  'serverTime',
];

describe('standingEndpoints', () => {
  it('names every endpoint after the theme and serves it under /v1/standing/', () => {
    expect(STANDING_ENDPOINT_NAMES).toEqual(Object.keys(standingEndpoints));
    for (const [name, endpoint] of entries) {
      expect(name).toMatch(/^standing[A-Z]/);
      expect(endpoint.path).toMatch(/^\/v1\/standing\/[a-z/]+$/);
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

  it('lets no upload carry Repute, progress, prices, boosts or timestamps', () => {
    for (const [name, endpoint] of entries) {
      if (endpoint.body === null) continue;
      const shape = Object.keys((endpoint.body as z.ZodObject).shape);
      expect(
        shape.filter((key) => SERVER_OWNED_KEYS.includes(key)),
        name,
      ).toEqual([]);
    }
  });

  it('parses one wire example per endpoint, request and answer', () => {
    expect(Object.keys(standingFixtures).sort()).toEqual([...STANDING_ENDPOINT_NAMES].sort());
    for (const [name, endpoint] of entries) {
      const fixture = standingFixtures[name as keyof typeof standingFixtures];
      if (endpoint.body !== null) {
        expect('body' in fixture, name).toBe(true);
        const body = (fixture as { body: unknown }).body;
        expect(endpoint.body.safeParse(body).error, name).toBeUndefined();
      }
      expect(endpoint.response.safeParse(fixture.response).error, name).toBeUndefined();
    }
  });

  it('composes with the live registry and the collecting group without a clash', () => {
    const composed = composeEndpoints(endpoints, collectingEndpoints, standingEndpoints);
    expect(Object.keys(composed)).toEqual([
      ...ENDPOINT_NAMES,
      ...Object.keys(collectingEndpoints),
      ...STANDING_ENDPOINT_NAMES,
    ]);
  });

  it('is staged outside the live registry until the wiring task registers its handlers', () => {
    expect(ENDPOINT_NAMES.filter((name) => name.startsWith('standing'))).toEqual([]);
  });
});
