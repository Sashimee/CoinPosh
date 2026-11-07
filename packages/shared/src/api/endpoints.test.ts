import { describe, expect, it } from 'vitest';
import { endpointFixtures } from '../test/fixtures.ts';
import { roundTrip } from '../test/roundTrip.ts';
import {
  buildPath,
  ENDPOINT_NAMES,
  endpoints,
  requiresIdempotencyKey,
  type Endpoint,
  type EndpointName,
} from './endpoints.ts';

const ARCHITECTURE_API_SURFACE = [
  'POST /v1/auth/guest',
  'POST /v1/auth/refresh',
  'GET /v1/state',
  'POST /v1/table/drop',
  'POST /v1/table/claims',
  'POST /v1/table/nudge',
  'POST /v1/table/inputs',
  'POST /v1/upgrades/buy',
  'POST /v1/charms/equip',
  'POST /v1/crates/open',
  'POST /v1/safes/open',
  'POST /v1/gacha/pull',
  'POST /v1/scratch/reveal',
  'POST /v1/ascend',
  'GET /v1/album',
  'GET /v1/fair/seeds',
  'POST /v1/fair/rotate',
  'GET /v1/quests',
  'POST /v1/quests/claim',
  'GET /v1/season',
  'GET /v1/leaderboard/:board',
  'GET /v1/events/current',
];

interface LooseFixture {
  body?: unknown;
  params?: unknown;
  response: unknown;
}

interface EndpointCase {
  name: EndpointName;
  endpoint: Endpoint;
  fixture: LooseFixture;
}

const cases: EndpointCase[] = ENDPOINT_NAMES.map((name) => ({
  name,
  endpoint: endpoints[name],
  fixture: endpointFixtures[name],
}));

function withExtraKey(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Fixture must be a JSON object to add a key to it.');
  }
  return { ...value, value: 1_000_000 };
}

describe('endpoint registry', () => {
  it('covers exactly the v1 API surface in 01-ARCHITECTURE.md', () => {
    const registered = cases.map(({ endpoint }) => `${endpoint.method} ${endpoint.path}`);
    expect(registered.toSorted()).toEqual(ARCHITECTURE_API_SURFACE.toSorted());
  });

  it('gives each route a unique method and path', () => {
    const routes = cases.map(({ endpoint }) => `${endpoint.method} ${endpoint.path}`);
    expect(new Set(routes).size).toBe(routes.length);
  });

  it('has a body schema for every POST and none for any GET', () => {
    for (const { name, endpoint } of cases) {
      expect(endpoint.body === null, name).toBe(endpoint.method === 'GET');
    }
  });

  it('requires an idempotency key exactly on mutating requests', () => {
    for (const { name, endpoint } of cases) {
      expect(requiresIdempotencyKey(endpoint), name).toBe(endpoint.method === 'POST');
    }
  });

  it('only lets the auth endpoints skip the bearer token', () => {
    const unauthenticated = cases.filter(({ endpoint }) => endpoint.auth === 'none');
    expect(unauthenticated.map(({ name }) => name).toSorted()).toEqual([
      'authGuest',
      'authRefresh',
    ]);
  });

  it('declares a params schema exactly when the path has :segments', () => {
    for (const { name, endpoint } of cases) {
      expect(endpoint.params !== null, name).toBe(endpoint.path.includes('/:'));
    }
  });
});

describe.each(cases)('$name round-trip', ({ endpoint, fixture }) => {
  it('parses the response fixture losslessly through JSON', () => {
    const { parsed, reparsed } = roundTrip(endpoint.response, fixture.response);
    expect(parsed).toEqual(fixture.response);
    expect(reparsed).toEqual(parsed);
  });

  it('ignores unknown response keys so older clients survive newer servers', () => {
    const parsed = endpoint.response.parse(withExtraKey(fixture.response));
    expect(parsed).toEqual(fixture.response);
  });

  if (endpoint.body !== null) {
    const body = endpoint.body;

    it('parses the request fixture losslessly through JSON', () => {
      const { parsed, reparsed } = roundTrip(body, fixture.body);
      expect(parsed).toEqual(fixture.body);
      expect(reparsed).toEqual(parsed);
    });

    it('rejects a request carrying a key the contract does not define', () => {
      const result = body.safeParse(withExtraKey(fixture.body));
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
    });

    it('rejects a missing body', () => {
      expect(body.safeParse(undefined).success).toBe(false);
    });
  }

  if (endpoint.params !== null) {
    const params = endpoint.params;

    it('parses the params fixture losslessly through JSON', () => {
      const { parsed, reparsed } = roundTrip(params, fixture.params);
      expect(parsed).toEqual(fixture.params);
      expect(reparsed).toEqual(parsed);
    });
  }
});

describe('buildPath', () => {
  it('returns static paths unchanged', () => {
    expect(buildPath('tableDrop')).toBe('/v1/table/drop');
    expect(buildPath('state')).toBe('/v1/state');
  });

  it('fills and URI-encodes path parameters', () => {
    expect(buildPath('leaderboard', { board: 'weekly' })).toBe('/v1/leaderboard/weekly');
    expect(buildPath('leaderboard', { board: 'friends:Ab12' })).toBe(
      '/v1/leaderboard/friends%3AAb12',
    );
  });

  it('refuses parameters that would escape the path segment', () => {
    expect(() => buildPath('leaderboard', { board: '../admin' })).toThrow(/BoardId/);
    expect(() => buildPath('leaderboard', { board: '' })).toThrow();
  });

  it('is typed so static paths take no params and templated paths require them', () => {
    const name: EndpointName = 'album';
    expect(buildPath(name as 'album')).toBe('/v1/album');
    // @ts-expect-error leaderboard needs its :board parameter
    expect(() => buildPath('leaderboard')).toThrow();
  });
});
