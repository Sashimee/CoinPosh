import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { WalletSchema } from '../domain.ts';
import { endpointFixtures, ids } from '../test/fixtures.ts';
import { roundTrip } from '../test/roundTrip.ts';
import {
  AccountLinkRequestSchema,
  AccountNonceRequestSchema,
  AccountSchema,
  IdTokenSchema,
  ProgressChoiceSchema,
  SignInRequestSchema,
  SignInResponseSchema,
} from './account.ts';
import {
  ACCOUNT_ENDPOINT_NAMES,
  accountEndpoints,
  type AccountEndpointName,
  type Endpoint,
} from './endpoints.ts';

const guestPlayer = '0198f6a2-9d4b-7a21-8e3c-5f1a2b3c4d5e';
const nonce = 'n0nce_9hT2xLq7Vb4Rk8Wm3Zp6Yc1Fd5Gs0Ja-';
const idToken =
  'eyJhbGciOiJSUzI1NiIsImtpZCI6ImsxIn0.eyJpc3MiOiJodHRwczovL2FjY291bnRzLmdvb2dsZS5jb20ifQ.c2lnbmF0dXJl';
const { devicePublicKey } = endpointFixtures.authGuest.body;
const tokens = endpointFixtures.authGuest.response;

const account = {
  playerId: ids.player,
  identities: [{ provider: 'google', linkedAt: 1_762_473_600_000, emailHint: 'l•••@gmail.com' }],
  available: ['google', 'apple'],
};

const choice = {
  guest: {
    playerId: guestPlayer,
    venue: 'rivieraYacht',
    goldBars: 0,
    coins: 640,
    lastPlayedAt: 1_762_470_000_000,
  },
  account: {
    playerId: ids.player,
    venue: 'salonDeParis',
    goldBars: 4,
    coins: 18_250,
    lastPlayedAt: 1_762_300_800_000,
  },
};

const fixtures: Record<AccountEndpointName, { body?: unknown; response: unknown }> = {
  accountNonce: {
    body: { provider: 'apple', purpose: 'signin' },
    response: { nonce, expiresAt: 1_762_473_900_000 },
  },
  accountLink: { body: { provider: 'google', idToken, nonce }, response: account },
  authSignIn: {
    body: { provider: 'google', idToken, nonce, devicePublicKey },
    response: { ...tokens, account, choice },
  },
  accountUnlink: {
    body: { provider: 'google' },
    response: { ...account, identities: [] },
  },
  account: { response: account },
};

function withKey(value: unknown, key: string, extra: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Fixture must be a JSON object to add a key to it.');
  }
  return { ...value, [key]: extra };
}

function fieldNames(schema: z.ZodType): string[] {
  if (schema instanceof z.ZodOptional) {
    return fieldNames(schema.unwrap() as z.ZodType);
  }
  if (schema instanceof z.ZodArray) {
    return fieldNames(schema.element as z.ZodType);
  }
  if (!(schema instanceof z.ZodObject)) {
    return [];
  }
  return Object.entries(schema.shape as Record<string, z.ZodType>).flatMap(([key, field]) => [
    key,
    ...fieldNames(field),
  ]);
}

interface AccountCase {
  name: AccountEndpointName;
  endpoint: Endpoint;
  fixture: { body?: unknown; response: unknown };
}

const cases: AccountCase[] = ACCOUNT_ENDPOINT_NAMES.map((name) => ({
  name,
  endpoint: accountEndpoints[name],
  fixture: fixtures[name],
}));

const requestBodies = cases.flatMap(({ name, endpoint }) =>
  endpoint.body === null ? [] : [{ name, body: endpoint.body }],
);

describe.each(cases)('$name round-trip', ({ endpoint, fixture }) => {
  it('parses the response fixture losslessly through JSON', () => {
    const { parsed, reparsed } = roundTrip(endpoint.response, fixture.response);
    expect(parsed).toEqual(fixture.response);
    expect(reparsed).toEqual(parsed);
  });

  it('ignores unknown response keys so older clients survive newer servers', () => {
    expect(endpoint.response.parse(withKey(fixture.response, 'tier', 'gold'))).toEqual(
      fixture.response,
    );
  });

  if (endpoint.body !== null) {
    const body = endpoint.body;

    it('parses the request fixture losslessly through JSON', () => {
      const { parsed, reparsed } = roundTrip(body, fixture.body);
      expect(parsed).toEqual(fixture.body);
      expect(reparsed).toEqual(parsed);
    });

    it.each([
      ['value', 1_000_000],
      ['wallet', { coins: 1_000_000 }],
      ['playerId', guestPlayer],
      ['serverTime', 1_762_473_600_000],
    ])('rejects a request smuggling %s', (key, extra) => {
      const result = body.safeParse(withKey(fixture.body, key, extra));
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
    });

    it('rejects a missing body', () => {
      expect(body.safeParse(undefined).success).toBe(false);
    });
  }
});

describe('account requests', () => {
  const forbidden = new Set([
    ...Object.keys(WalletSchema.shape),
    'wallet',
    'value',
    'amount',
    'balance',
    'rewards',
    'playerId',
    'serverTime',
    'timestamp',
    'choice',
  ]);

  it.each(requestBodies)(
    '$name carries no wallet, value, identity or timestamp field',
    ({ body }) => {
      const names = fieldNames(body);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        expect(forbidden.has(name) || name.endsWith('At'), name).toBe(false);
      }
    },
  );

  it.each([
    ['an unsupported provider', { provider: 'facebook', idToken, nonce }],
    ['a token that is not a JWS', { provider: 'google', idToken: 'not-a-jwt', nonce }],
    ['a token with a padded segment', { provider: 'google', idToken: `${idToken}=`, nonce }],
    ['a short nonce', { provider: 'google', idToken, nonce: 'abc123' }],
    ['a nonce with spaces', { provider: 'google', idToken, nonce: `${nonce.slice(1)} ` }],
    ['a missing nonce', { provider: 'google', idToken }],
  ])('link rejects %s', (_label, body) => {
    expect(AccountLinkRequestSchema.safeParse(body).success).toBe(false);
  });

  it('bounds the ID token length', () => {
    const huge = `${'a'.repeat(4096)}.${'b'.repeat(4096)}.c`;
    expect(IdTokenSchema.safeParse(huge).success).toBe(false);
  });

  it('asks for a nonce bound to one provider and one purpose', () => {
    expect(AccountNonceRequestSchema.safeParse({ provider: 'google' }).success).toBe(false);
    expect(
      AccountNonceRequestSchema.safeParse({ provider: 'google', purpose: 'merge' }).success,
    ).toBe(false);
  });

  it('refuses a sign-in whose device key leaks the private scalar', () => {
    const leaked = { ...devicePublicKey, d: 'jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI' };
    const body = { provider: 'apple', idToken, nonce, devicePublicKey: leaked };
    expect(SignInRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('AccountSchema', () => {
  it('accepts a guest with no linked identity', () => {
    expect(AccountSchema.parse({ ...account, identities: [], available: [] })).toEqual({
      ...account,
      identities: [],
      available: [],
    });
  });

  it('rejects the same provider linked twice', () => {
    const twice = { ...account, identities: [account.identities[0], account.identities[0]] };
    expect(AccountSchema.safeParse(twice).success).toBe(false);
  });
});

describe('SignInResponseSchema', () => {
  const response = { ...tokens, account };

  it('omits the choice when the device holds no other guest with progress', () => {
    const parsed = SignInResponseSchema.parse(response);
    expect(parsed.choice).toBeUndefined();
    expect(parsed.account.playerId).toBe(parsed.playerId);
  });

  it('carries both saves when the device holds a different guest with progress', () => {
    const parsed = SignInResponseSchema.parse({ ...response, choice });
    expect(parsed.choice?.guest.playerId).toBe(guestPlayer);
    expect(parsed.choice?.account.playerId).toBe(parsed.playerId);
  });

  it('rejects an account view for another player', () => {
    const other = { ...response, account: { ...account, playerId: guestPlayer } };
    expect(SignInResponseSchema.safeParse(other).success).toBe(false);
  });

  it('rejects a choice whose account side is not the signed-in player', () => {
    const swapped = { ...response, choice: { guest: choice.account, account: choice.guest } };
    expect(SignInResponseSchema.safeParse(swapped).success).toBe(false);
  });

  it('rejects a choice between a player and itself', () => {
    const same = { guest: choice.account, account: choice.account };
    expect(ProgressChoiceSchema.safeParse(same).success).toBe(false);
  });
});
