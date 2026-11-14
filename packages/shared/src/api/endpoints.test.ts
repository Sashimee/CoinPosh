import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { endpointFixtures, ids } from '../test/fixtures.ts';
import { roundTrip } from '../test/roundTrip.ts';
import {
  ACCOUNT_ENDPOINT_NAMES,
  accountEndpoints,
  buildPath,
  ENDPOINT_NAMES,
  endpoints,
  requiresIdempotencyKey,
  SOIREE_ENDPOINT_NAMES,
  soireeEndpoints,
  tableSnapshotEndpoint,
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

describe('tableSnapshotEndpoint', () => {
  const endpoint: Endpoint = tableSnapshotEndpoint;
  const body = {
    session: 'session_K3p9Wz2QfL',
    seq: 3,
    tick: 7_200,
    pusher: { tickInCycle: 15 },
    coins: [[ids.coins[0], 1_250, 480, -32_000, 0, 0, 0, 32_767, 'asleep']],
    crates: [[ids.crate, -4_100, 22_000, 1_850, 'riding']],
  };
  const response = { seq: 3, stored: 2, ignored: 0 };

  it('is a signed bearer POST that requires an idempotency key', () => {
    expect(`${endpoint.method} ${endpoint.path}`).toBe('POST /v1/table/snapshot');
    expect(endpoint.auth).toBe('bearer');
    expect(endpoint.params).toBeNull();
    expect(requiresIdempotencyKey(endpoint)).toBe(true);
  });

  it('does not collide with a registered route', () => {
    const routes = cases.map((c) => `${c.endpoint.method} ${c.endpoint.path}`);
    expect(routes).not.toContain(`${endpoint.method} ${endpoint.path}`);
  });

  it('round-trips its request and response through JSON', () => {
    expect(endpoint.body).not.toBeNull();
    const request = roundTrip(tableSnapshotEndpoint.body, body);
    expect(request.parsed).toEqual(body);
    expect(request.reparsed).toEqual(request.parsed);
    const answer = roundTrip(endpoint.response, response);
    expect(answer.parsed).toEqual(response);
    expect(answer.reparsed).toEqual(answer.parsed);
  });

  it('rejects a body with an extra key and ignores an extra response key', () => {
    const result = tableSnapshotEndpoint.body.safeParse(withExtraKey(body));
    expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
    expect(endpoint.response.parse(withExtraKey(response))).toEqual(response);
  });
});

describe('accountEndpoints', () => {
  const accountCases: { name: string; endpoint: Endpoint }[] = ACCOUNT_ENDPOINT_NAMES.map(
    (name) => ({ name, endpoint: accountEndpoints[name] }),
  );
  const routeOf = ({ endpoint }: { endpoint: Endpoint }) => `${endpoint.method} ${endpoint.path}`;

  it('covers exactly the account link surface of T-10.01', () => {
    expect(accountCases.map(routeOf).toSorted()).toEqual(
      [
        'POST /v1/account/nonce',
        'POST /v1/account/link',
        'POST /v1/auth/signin',
        'POST /v1/account/unlink',
        'GET /v1/account',
      ].toSorted(),
    );
  });

  it('does not collide with a registered route or the table snapshot', () => {
    const taken = new Set([...cases.map(routeOf), routeOf({ endpoint: tableSnapshotEndpoint })]);
    for (const accountCase of accountCases) {
      expect(taken.has(routeOf(accountCase)), accountCase.name).toBe(false);
    }
  });

  it('lets only a device without a session skip the bearer token', () => {
    const unauthenticated = accountCases.filter(({ endpoint }) => endpoint.auth === 'none');
    expect(unauthenticated.map(({ name }) => name).toSorted()).toEqual([
      'accountNonce',
      'authSignIn',
    ]);
  });

  it('carries the signing key in the body of every route without a session', () => {
    for (const { name, endpoint } of accountCases) {
      if (endpoint.auth !== 'none') {
        continue;
      }
      expect(endpoint.body, name).toBeInstanceOf(z.ZodObject);
      const shape = (endpoint.body as z.ZodObject).shape as Record<string, z.ZodType>;
      const key = shape.devicePublicKey;
      expect(key, name).toBeDefined();
      expect(key?.safeParse(undefined).success, name).toBe(false);
    }
  });

  it('has a strict body and an idempotency key on every POST, and no body on the GET', () => {
    for (const { name, endpoint } of accountCases) {
      expect(endpoint.body === null, name).toBe(endpoint.method === 'GET');
      expect(endpoint.params, name).toBeNull();
      expect(requiresIdempotencyKey(endpoint), name).toBe(endpoint.method === 'POST');
      if (endpoint.body !== null) {
        const result = endpoint.body.safeParse({ value: 1_000_000 });
        expect(
          result.error?.issues.map((issue) => issue.code),
          name,
        ).toContain('unrecognized_keys');
      }
    }
  });
});

describe('soireeEndpoints', () => {
  const soireeCases: { name: string; endpoint: Endpoint }[] = SOIREE_ENDPOINT_NAMES.map((name) => ({
    name,
    endpoint: soireeEndpoints[name],
  }));
  const routeOf = ({ endpoint }: { endpoint: Endpoint }) => `${endpoint.method} ${endpoint.path}`;

  it('covers exactly the Soirée run surface of T-3.06', () => {
    expect(soireeCases.map(routeOf).toSorted()).toEqual([
      'POST /v1/soiree/draft',
      'POST /v1/soiree/finish',
      'POST /v1/soiree/start',
    ]);
  });

  it('does not collide with a registered, account or table snapshot route', () => {
    const taken = new Set([
      ...cases.map(routeOf),
      ...ACCOUNT_ENDPOINT_NAMES.map((name) => routeOf({ endpoint: accountEndpoints[name] })),
      routeOf({ endpoint: tableSnapshotEndpoint }),
    ]);
    for (const soireeCase of soireeCases) {
      expect(taken.has(routeOf(soireeCase)), soireeCase.name).toBe(false);
    }
  });

  it('is bearer-only, idempotent and strict, so the client cannot post a tally or a value', () => {
    for (const { name, endpoint } of soireeCases) {
      expect(endpoint.auth, name).toBe('bearer');
      expect(endpoint.params, name).toBeNull();
      expect(requiresIdempotencyKey(endpoint), name).toBe(true);
      expect(endpoint.body, name).not.toBeNull();
      const result = endpoint.body?.safeParse({ value: 1_000_000 });
      expect(
        result?.error?.issues.map((issue) => issue.code),
        name,
      ).toContain('unrecognized_keys');
    }
  });
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
