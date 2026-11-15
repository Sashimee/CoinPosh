import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as shared from '../../index.ts';
import { composeEndpoints, type Endpoint } from '../endpoint.ts';
import { ENDPOINT_NAMES, endpoints } from '../endpoints.ts';
import { collectingEndpoints } from '../collecting/endpoints.ts';
import { liveEventsEndpoints } from '../liveEvents/endpoints.ts';
import { standingEndpoints } from '../standing/endpoints.ts';
import { WORLD_ENDPOINT_NAMES, worldEndpoints } from './endpoints.ts';
import { worldFixtures } from './fixtures.ts';

const entries = Object.entries(worldEndpoints) as [string, Endpoint][];

/** Keys a client must never set; the server derives every one of them. */
const SERVER_OWNED_KEYS = [
  'value',
  'amount',
  'reward',
  'rewards',
  'granted',
  'wallet',
  'balance',
  'level',
  'fetches',
  'rarity',
  'owned',
  'duplicate',
  'proof',
  'seed',
  'nonce',
  'plan',
  'status',
  'met',
  'progress',
  'deliveredAt',
  'openedAt',
  'observedAt',
  'serverTime',
  'weather',
  'timeZone',
  'location',
  'latitude',
  'longitude',
];

describe('worldEndpoints', () => {
  it('names every endpoint after the theme and serves it under /v1/world/', () => {
    expect(WORLD_ENDPOINT_NAMES).toEqual(Object.keys(worldEndpoints));
    for (const [name, endpoint] of entries) {
      expect(name).toMatch(/^world[A-Z]/);
      expect(endpoint.path).toMatch(/^\/v1\/world\/[a-z/-]+$/);
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
      const shape = endpoint.body instanceof z.ZodObject ? endpoint.body : null;
      expect(shape, name).not.toBeNull();
      expect(shape?.def.catchall, name).toBeInstanceOf(z.ZodNever);
      expect(endpoint.body?.safeParse({ forged: 1 }).success, name).toBe(false);
    }
  });

  it('lets no upload carry values, rewards, levels, rolls, timestamps or a location', () => {
    for (const [name, endpoint] of entries) {
      if (!(endpoint.body instanceof z.ZodObject)) continue;
      const shape = Object.keys(endpoint.body.shape);
      expect(
        shape.filter((key) => SERVER_OWNED_KEYS.includes(key)),
        name,
      ).toEqual([]);
    }
  });

  it('asks nothing of the player to serve venue conditions', () => {
    expect(worldEndpoints.worldConditions.method).toBe('GET');
    expect(worldEndpoints.worldConditions.body).toBeNull();
    expect(worldEndpoints.worldConditions.params).toBeNull();
  });

  it('parses one wire example per endpoint, request and answer', () => {
    expect(Object.keys(worldFixtures).sort()).toEqual([...WORLD_ENDPOINT_NAMES].sort());
    for (const [name, endpoint] of entries) {
      const fixture = worldFixtures[name as keyof typeof worldFixtures];
      if (endpoint.body !== null) {
        expect('body' in fixture, name).toBe(true);
        const body = (fixture as { body: unknown }).body;
        expect(endpoint.body.safeParse(body).error, name).toBeUndefined();
      }
      expect(endpoint.response.safeParse(fixture.response).error, name).toBeUndefined();
    }
  });

  it('composes with the live registry and the other staged groups without a clash', () => {
    const composed = composeEndpoints(
      endpoints,
      collectingEndpoints,
      standingEndpoints,
      liveEventsEndpoints,
      worldEndpoints,
    );
    expect(Object.keys(composed)).toEqual([
      ...ENDPOINT_NAMES,
      ...Object.keys(collectingEndpoints),
      ...Object.keys(standingEndpoints),
      ...Object.keys(liveEventsEndpoints),
      ...WORLD_ENDPOINT_NAMES,
    ]);
  });

  it('is staged outside the live registry until the wiring task registers its handlers', () => {
    expect(ENDPOINT_NAMES.filter((name) => name.startsWith('world'))).toEqual([]);
  });

  it('is exported from the package entry point', () => {
    expect(shared.worldEndpoints).toBe(worldEndpoints);
    for (const name of [
      'LettersResponseSchema',
      'GuestArcSchema',
      'LetterOpenRequestSchema',
      'PetsResponseSchema',
      'PetFetchClaimSchema',
      'PetFetchPlanSchema',
      'ConditionsResponseSchema',
      'WorldUpdateSchema',
    ] as const) {
      expect(shared[name], name).toBeInstanceOf(z.ZodType);
    }
  });
});
