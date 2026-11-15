import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as shared from '../../index.ts';
import { composeEndpoints, type Endpoint } from '../endpoint.ts';
import { ENDPOINT_NAMES, endpoints } from '../endpoints.ts';
import { collectingEndpoints } from '../collecting/endpoints.ts';
import { standingEndpoints } from '../standing/endpoints.ts';
import { LIVE_EVENTS_ENDPOINT_NAMES, liveEventsEndpoints } from './endpoints.ts';
import { liveEventsFixtures } from './fixtures.ts';

const entries = Object.entries(liveEventsEndpoints) as [string, Endpoint][];

/** Keys a client must never set; the server derives every one of them. */
const SERVER_OWNED_KEYS = [
  'damage',
  'dealt',
  'health',
  'tier',
  'score',
  'solved',
  'dropsUsed',
  'ticksUsed',
  'rank',
  'seed',
  'goal',
  'reward',
  'rewards',
  'granted',
  'amount',
  'claims',
  'nextDay',
  'cycle',
  'track',
  'claimedAt',
  'startedAt',
  'verifiedAt',
  'changedAt',
  'dayStartsAt',
  'serverTime',
];

describe('liveEventsEndpoints', () => {
  it('names every endpoint after the theme and serves it under /v1/live-events/', () => {
    expect(LIVE_EVENTS_ENDPOINT_NAMES).toEqual(Object.keys(liveEventsEndpoints));
    for (const [name, endpoint] of entries) {
      expect(name).toMatch(/^liveEvents[A-Z]/);
      expect(endpoint.path).toMatch(/^\/v1\/live-events\/[a-z/-]+$/);
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

  it('lets no upload carry damage, scores, outcomes, rewards or timestamps', () => {
    for (const [name, endpoint] of entries) {
      if (!(endpoint.body instanceof z.ZodObject)) continue;
      const shape = Object.keys(endpoint.body.shape);
      expect(
        shape.filter((key) => SERVER_OWNED_KEYS.includes(key)),
        name,
      ).toEqual([]);
    }
  });

  it('parses one wire example per endpoint, request and answer', () => {
    expect(Object.keys(liveEventsFixtures).sort()).toEqual([...LIVE_EVENTS_ENDPOINT_NAMES].sort());
    for (const [name, endpoint] of entries) {
      const fixture = liveEventsFixtures[name as keyof typeof liveEventsFixtures];
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
    );
    expect(Object.keys(composed)).toEqual([
      ...ENDPOINT_NAMES,
      ...Object.keys(collectingEndpoints),
      ...Object.keys(standingEndpoints),
      ...LIVE_EVENTS_ENDPOINT_NAMES,
    ]);
  });

  it('is staged outside the live registry until the wiring task registers its handlers', () => {
    expect(ENDPOINT_NAMES.filter((name) => name.startsWith('liveEvents'))).toEqual([]);
  });

  it('is exported from the package entry point', () => {
    expect(shared.liveEventsEndpoints).toBe(liveEventsEndpoints);
    for (const name of [
      'CalendarResponseSchema',
      'DailyPuzzleSchema',
      'PuzzleSubmitRequestSchema',
      'BossSchema',
      'BossHitSchema',
      'ThemesResponseSchema',
      'TimeZoneSchema',
      'PlayerClockSchema',
    ] as const) {
      expect(shared[name], name).toBeInstanceOf(z.ZodType);
    }
  });
});
