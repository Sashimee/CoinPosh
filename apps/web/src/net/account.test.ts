import {
  AccountNonceResponseSchema,
  type AccountNonce,
  type IdentityProvider,
  type NoncePurpose,
  type StateResponse,
} from '@coinposh/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APPLE_JS_SCRIPT,
  AccountClient,
  AccountRequestError,
  GOOGLE_GIS_SCRIPT,
  IdentityProviderError,
  SessionSwapError,
  SignInCancelledError,
  demoIdentityDrivers,
  domScriptLoader,
  liveIdentityDrivers,
  type AppleAuthApi,
  type GoogleIdApi,
  type IdentityConfig,
  type IdentityDrivers,
  type SessionSwap,
  type SignInOutcome,
} from './account.ts';
import { fromBase64Url } from './encoding.ts';
import {
  DEMO_ACCOUNT_STORAGE_KEY,
  DEMO_IDENTITY,
  MOCK_ACCOUNT_RULES,
  MockIdentityProvider,
} from './mock/account.ts';
import type { MockStorage } from './mock/persist.ts';
import { MOCK_RULES } from './mock/rules.ts';
import type { MockServer } from './mock/server.ts';
import { newIdempotencyKey } from './request.ts';
import {
  FakeTime,
  connectPlayer,
  createMockServer,
  errorCode,
  forge,
  requirePlayerId,
  type Player,
} from './test/harness.ts';
import type { Transport, WireRequest, WireResponse } from './wire.ts';

let time: FakeTime;
let server: MockServer;

beforeEach(() => {
  time = new FakeTime();
  server = createMockServer({ now: time.now, storage: null, lifecycle: null });
});

interface FakeTable {
  readonly order: string[];
  readonly hydrated: StateResponse[];
  failDrain: number;
  drainBeforeBoot(): Promise<void>;
  hydrate(state: StateResponse): void;
}

function fakeTable(): FakeTable {
  const table: FakeTable = {
    order: [],
    hydrated: [],
    failDrain: 0,
    drainBeforeBoot() {
      table.order.push('drain');
      if (table.failDrain > 0) {
        table.failDrain -= 1;
        return Promise.reject(new Error('Queued table ops are still offline.'));
      }
      return Promise.resolve();
    },
    hydrate(state) {
      table.order.push('hydrate');
      table.hydrated.push(state);
    },
  };
  return table;
}

interface Device {
  readonly player: Player;
  readonly account: AccountClient;
  readonly table: FakeTable;
  readonly swaps: SessionSwap[];
  readonly errors: unknown[];
  persona: string;
}

interface DeviceOptions {
  readonly drivers?: IdentityDrivers;
  readonly transport?: Transport;
  readonly monotonic?: () => number;
}

/** A tab on its own device: own key, own session, the shared Demo server behind it. */
async function device(persona: string, options: DeviceOptions = {}): Promise<Device> {
  const player = await connectPlayer(
    server,
    time,
    options.monotonic === undefined ? {} : { monotonic: options.monotonic },
  );
  const table = fakeTable();
  const errors: unknown[] = [];
  const swaps: SessionSwap[] = [];
  const transport: Transport =
    options.transport ??
    ((request) => {
      player.requests.push(request);
      return server.transport(request);
    });
  const self: { persona: string } = { persona };
  const account = new AccountClient({
    transport,
    device: player.device,
    session: player.session,
    store: player.store,
    client: player.client,
    table,
    drivers:
      options.drivers ?? demoIdentityDrivers(server.identity, { persona: () => self.persona }),
    onError: (error) => errors.push(error),
    sleep: () => Promise.resolve(),
    jitter: () => 0,
  });
  account.onSwap((swap) => swaps.push(swap));
  await player.client.call('state');
  return {
    player,
    account,
    table,
    swaps,
    errors,
    get persona() {
      return self.persona;
    },
    set persona(next) {
      self.persona = next;
    },
  };
}

function paths(requests: readonly WireRequest[]): string[] {
  return requests.map((request) => request.path);
}

async function makeProgress(dev: Device): Promise<void> {
  const state = await dev.player.client.call('state', { query: { hydrate: 'boot' } });
  const startedAt = time.now();
  const coin = state.table.buffer[0];
  const session = state.table.session;
  if (coin === undefined || session === undefined) throw new Error('Expected a booted table.');
  time.advance(200);
  await dev.player.client.call('tableDrop', {
    body: {
      session,
      x: 0,
      tick: Math.floor(((time.now() - startedAt) / 1000) * 60),
      coinId: coin.id,
    },
  });
}

async function signedIn(outcome: Promise<SignInOutcome>): Promise<SessionSwap | null> {
  const result = await outcome;
  if (result.kind !== 'signedIn') throw new Error(`Expected a sign-in, got ${result.kind}.`);
  return result.swap;
}

function claims(token: string): Record<string, unknown> {
  const [, payload = ''] = token.split('.');
  return JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as Record<string, unknown>;
}

async function requestNonce(
  dev: Device,
  provider: IdentityProvider,
  purpose: NoncePurpose,
  options: {
    readonly token?: string | null;
    readonly key?: ReturnType<typeof newIdempotencyKey>;
  } = {},
): Promise<WireResponse> {
  return forge(server, dev.player.device, {
    method: 'POST',
    path: '/v1/account/nonce',
    body: JSON.stringify({ provider, purpose, devicePublicKey: dev.player.device.publicKey }),
    token:
      options.token === undefined
        ? purpose === 'link'
          ? await dev.player.session.accessToken()
          : null
        : options.token,
    ...(options.key === undefined ? {} : { key: options.key }),
  });
}

async function nonceFor(
  dev: Device,
  provider: IdentityProvider,
  purpose: NoncePurpose,
): Promise<AccountNonce> {
  const response = await requestNonce(dev, provider, purpose);
  expect(response.status).toBe(200);
  return AccountNonceResponseSchema.parse(response.body).nonce;
}

async function forgeLink(dev: Device, body: Record<string, unknown>): Promise<WireResponse> {
  return forge(server, dev.player.device, {
    method: 'POST',
    path: '/v1/account/link',
    body: JSON.stringify(body),
    token: await dev.player.session.accessToken(),
  });
}

async function forgeSignIn(
  dev: Device,
  body: Record<string, unknown>,
  key = newIdempotencyKey(),
): Promise<WireResponse> {
  return forge(server, dev.player.device, {
    method: 'POST',
    path: '/v1/auth/signin',
    body: JSON.stringify({ devicePublicKey: dev.player.device.publicKey, ...body }),
    key,
  });
}

describe('Demo provider', () => {
  it('is offered as a clearly fake provider whose tokens name a .invalid issuer', async () => {
    const alice = await device('alice');
    expect(alice.account.offers()).toEqual([
      { provider: 'google', available: true, demo: true },
      { provider: 'apple', available: true, demo: true },
    ]);
    const prepared = await alice.account.prepareLink('apple');
    expect(prepared.demo).toBe(true);
    const token = await server.identity.issue('apple', 'n'.repeat(43), { persona: 'alice' });
    expect(claims(token)).toMatchObject({
      iss: 'https://demo-identity.coinposh.invalid/apple',
      aud: DEMO_IDENTITY.audience,
      sub: 'demo-apple-alice',
      email: 'alice.apple@demo.coinposh.invalid',
    });
  });
});

describe('linking a guest save', () => {
  it('links Google to the guest save without moving a single coin', async () => {
    const alice = await device('alice');
    const id = requirePlayerId(alice.player);
    const walletBefore = structuredClone(server.world.player(id)?.wallet);
    const ledgerBefore = server.ledger().length;
    expect((await alice.account.get()).identities).toEqual([]);

    const account = await alice.account.link('google');

    expect(account.playerId).toBe(id);
    expect(account.identities).toEqual([
      { provider: 'google', linkedAt: time.now(), emailHint: 'a•••@demo.coinposh.invalid' },
    ]);
    expect(await alice.account.get()).toEqual(account);
    expect(server.ledger()).toHaveLength(ledgerBefore);
    expect(server.world.player(id)?.wallet).toEqual(walletBefore);
    for (const request of alice.player.requests) {
      expect(request.body ?? '').not.toMatch(/"coins"|"wallet"|"value"|"balance"|serverTime/);
    }
  });

  it('is idempotent for the same identity and refuses a second Google account on one save', async () => {
    const alice = await device('alice');
    await alice.account.link('google');
    const again = await alice.account.link('google');
    expect(again.identities).toHaveLength(1);
    expect(server.accounts.events.filter((event) => event.kind === 'link')).toHaveLength(1);

    alice.persona = 'alice-work';
    await expect(alice.account.link('google')).rejects.toMatchObject({
      name: 'AccountRequestError',
      code: 'identity_in_use',
      status: 409,
    });
  });

  it('answers identity_in_use when the identity already keeps another save', async () => {
    const alice = await device('alice');
    await alice.account.link('google');
    const mallory = await device('alice');
    const error = await mallory.account.link('google').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AccountRequestError);
    expect(error).toMatchObject({ code: 'identity_in_use', status: 409, operation: 'accountLink' });
    expect((await mallory.account.get()).identities).toEqual([]);
  });

  it('unlinks, and the identity can then be linked again', async () => {
    const alice = await device('alice');
    await alice.account.link('apple');
    expect((await alice.account.unlink('apple')).identities).toEqual([]);
    expect((await alice.account.unlink('apple')).identities).toEqual([]);
    expect((await alice.account.link('apple')).identities).toHaveLength(1);
  });

  it('ignores the client clock: a device a day fast still gets server-time nonces and links', async () => {
    const alice = await device('alice', { monotonic: () => time.now() + 86_400_000 });
    const prepared = await alice.account.prepareLink('google');
    expect(prepared.expiresAt).toBe(time.now() + MOCK_ACCOUNT_RULES.nonceTtlMs);
    const account = await prepared.complete();
    expect(account.identities[0]?.linkedAt).toBe(time.now());
  });
});

describe('signing in on another device', () => {
  it('swaps the session onto the linked save and re-boots the table with hydrate=boot', async () => {
    const alice = await device('alice');
    await alice.account.link('google');
    const aliceId = requirePlayerId(alice.player);
    const phone = await device('alice');
    const guestId = requirePlayerId(phone.player);
    phone.player.requests.length = 0;

    const swap = await signedIn(phone.account.signIn('google'));

    expect(swap).toMatchObject({ from: guestId, to: aliceId });
    expect(phone.player.session.playerId).toBe(aliceId);
    expect(phone.table.order).toEqual(['drain', 'hydrate']);
    expect(phone.table.hydrated[0]?.player.id).toBe(aliceId);
    expect(phone.swaps).toEqual([swap]);
    const sent = paths(phone.player.requests);
    expect(sent.indexOf('/v1/state?hydrate=boot')).toBeGreaterThan(sent.indexOf('/v1/auth/signin'));
    expect(sent).not.toContain('/v1/auth/guest');
    expect((await phone.player.client.call('state')).player.id).toBe(aliceId);
    expect((await alice.player.client.call('state')).player.id).toBe(aliceId);
  });

  it('offers a choice instead of merging when the device holds guest progress', async () => {
    const alice = await device('alice');
    await alice.account.link('google');
    const aliceId = requirePlayerId(alice.player);
    const phone = await device('alice');
    const guestId = requirePlayerId(phone.player);
    await makeProgress(phone);
    const guestWallet = structuredClone(server.world.player(guestId)?.wallet);

    const outcome = await phone.account.signIn('google');

    if (outcome.kind !== 'choice') throw new Error('Expected a progress choice.');
    expect(outcome.choice.guest.playerId).toBe(guestId);
    expect(outcome.choice.account.playerId).toBe(aliceId);
    expect(phone.player.session.playerId).toBe(guestId);
    outcome.keepGuest();
    expect(() => {
      outcome.keepGuest();
    }).toThrow(/already made/);
    await expect(outcome.keepAccount()).rejects.toThrow(/already made/);
    expect(phone.player.session.playerId).toBe(guestId);
    expect(phone.table.order).toEqual([]);
    expect(server.world.player(guestId)?.wallet).toEqual(guestWallet);
  });

  it('moves onto the account save when the person keeps it', async () => {
    const alice = await device('alice');
    await alice.account.link('apple');
    const phone = await device('alice');
    await makeProgress(phone);
    const outcome = await phone.account.signIn('apple');
    if (outcome.kind !== 'choice') throw new Error('Expected a progress choice.');
    const swap = await outcome.keepAccount();
    expect(swap.to).toBe(requirePlayerId(alice.player));
    expect(phone.player.session.playerId).toBe(swap.to);
  });

  it('keeps the session working when a device signs in to the save it already plays', async () => {
    const alice = await device('alice');
    await alice.account.link('google');
    const id = requirePlayerId(alice.player);
    expect(await signedIn(alice.account.signIn('google'))).toBeNull();
    expect(alice.table.order).toEqual([]);
    time.advance(MOCK_RULES.accessTokenTtlMs + 1);
    alice.player.session.expireAccessToken();
    expect((await alice.player.client.call('state')).player.id).toBe(id);
    expect(paths(alice.player.requests).filter((path) => path === '/v1/auth/guest')).toHaveLength(
      1,
    );
  });

  it('answers not_found for an identity no save is linked to', async () => {
    const phone = await device('nobody');
    await expect(phone.account.signIn('google')).rejects.toMatchObject({ code: 'not_found' });
    expect(phone.table.order).toEqual([]);
  });

  it('reports a swap that could not drain and finishes it on retry', async () => {
    const alice = await device('alice');
    await alice.account.link('google');
    const phone = await device('alice');
    phone.table.failDrain = 1;
    const error = await phone.account.signIn('google').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SessionSwapError);
    if (!(error instanceof SessionSwapError)) throw new Error('unreachable');
    expect(error.stage).toBe('drain');
    expect(phone.player.session.playerId).not.toBe(requirePlayerId(alice.player));
    const swap = await error.retry();
    expect(swap.to).toBe(requirePlayerId(alice.player));
    expect(phone.table.order).toEqual(['drain', 'drain', 'hydrate']);
  });

  it('signs other devices out of the save when the provider they came through is unlinked', async () => {
    const alice = await device('alice');
    await alice.account.link('google');
    const phone = await device('alice');
    await signedIn(phone.account.signIn('google'));
    const phoneToken = await phone.player.session.accessToken();
    const aliceToken = await alice.player.session.accessToken();

    await alice.account.unlink('google');

    const get = (dev: Device, token: string) =>
      forge(server, dev.player.device, { method: 'GET', path: '/v1/account', body: null, token });
    expect(errorCode(await get(phone, phoneToken))).toBe('unauthorized');
    expect((await get(alice, aliceToken)).status).toBe(200);
  });

  it('cancels without sending the sign-in when the person backs out', async () => {
    const alice = await device('alice');
    await alice.account.link('google');
    const phone = await device('alice');
    const prepared = await phone.account.prepareSignIn('google');
    const controller = new AbortController();
    controller.abort();
    await expect(prepared.complete({ signal: controller.signal })).rejects.toBeInstanceOf(
      SignInCancelledError,
    );
    await expect(prepared.complete()).rejects.toThrow(/already completed/);
    expect(paths(phone.player.requests)).not.toContain('/v1/auth/signin');
  });
});

describe('attacks on the account routes', () => {
  it('refuses forged, expired, foreign, future-dated and cross-provider ID tokens', async () => {
    const alice = await device('alice');
    const forger = new MockIdentityProvider(time.now);
    const nowSeconds = Math.floor(time.now() / 1000);
    const cases: [string, (nonce: string) => Promise<string>, IdentityProvider][] = [
      ['another key', (nonce) => forger.issue('google', nonce), 'google'],
      [
        'expired',
        (nonce) => server.identity.issue('google', nonce, { claims: { exp: nowSeconds - 1 } }),
        'google',
      ],
      [
        'another audience',
        (nonce) => server.identity.issue('google', nonce, { claims: { aud: 'someone-else' } }),
        'google',
      ],
      [
        'issued in the future',
        (nonce) =>
          server.identity.issue('google', nonce, {
            claims: { iat: nowSeconds + 3600, exp: nowSeconds + 7200 },
          }),
        'google',
      ],
      ['an Apple token sent as Google', (nonce) => server.identity.issue('apple', nonce), 'google'],
      ['another nonce', () => server.identity.issue('google', 'x'.repeat(43)), 'google'],
    ];
    for (const [label, mint, provider] of cases) {
      const nonce = await nonceFor(alice, provider, 'link');
      const response = await forgeLink(alice, { provider, idToken: await mint(nonce), nonce });
      expect(errorCode(response), label).toBe('invalid_id_token');
      expect(response.status, label).toBe(401);
    }
    expect(server.accounts.account(requirePlayerId(alice.player)).identities).toEqual([]);
  });

  it('spends each nonce once, for one device, provider and purpose', async () => {
    const alice = await device('alice');
    const bob = await device('bob');

    const nonce = await nonceFor(alice, 'google', 'link');
    const token = await server.identity.issue('google', nonce, { persona: 'alice' });
    expect((await forgeLink(alice, { provider: 'google', idToken: token, nonce })).status).toBe(
      200,
    );
    expect(errorCode(await forgeLink(alice, { provider: 'google', idToken: token, nonce }))).toBe(
      'invalid_id_token',
    );

    const stolen = await nonceFor(alice, 'apple', 'link');
    const bobToken = await server.identity.issue('apple', stolen, { persona: 'bob' });
    expect(
      errorCode(await forgeLink(bob, { provider: 'apple', idToken: bobToken, nonce: stolen })),
    ).toBe('invalid_id_token');

    const signinNonce = await nonceFor(bob, 'apple', 'signin');
    const forLink = await server.identity.issue('apple', signinNonce, { persona: 'bob' });
    expect(
      errorCode(await forgeLink(bob, { provider: 'apple', idToken: forLink, nonce: signinNonce })),
    ).toBe('invalid_id_token');

    const googleNonce = await nonceFor(bob, 'google', 'link');
    const asApple = await server.identity.issue('apple', googleNonce, { persona: 'bob' });
    expect(
      errorCode(await forgeLink(bob, { provider: 'apple', idToken: asApple, nonce: googleNonce })),
    ).toBe('invalid_id_token');

    const late = await nonceFor(bob, 'google', 'link');
    time.advance(MOCK_ACCOUNT_RULES.nonceTtlMs);
    const lateToken = await server.identity.issue('google', late, { persona: 'bob' });
    expect(
      errorCode(await forgeLink(bob, { provider: 'google', idToken: lateToken, nonce: late })),
    ).toBe('invalid_id_token');
    expect(server.accounts.account(requirePlayerId(bob.player)).identities).toEqual([]);
  });

  it('burns sign-in and nonce keys: a captured request works once', async () => {
    const alice = await device('alice');
    await alice.account.link('google');
    const phone = await device('alice');

    const nonceKey = newIdempotencyKey();
    expect((await requestNonce(phone, 'google', 'signin', { key: nonceKey })).status).toBe(200);
    expect(errorCode(await requestNonce(phone, 'google', 'signin', { key: nonceKey }))).toBe(
      'idempotency_key_reused',
    );

    const nonce = await nonceFor(phone, 'google', 'signin');
    const idToken = await server.identity.issue('google', nonce, { persona: 'alice' });
    const key = newIdempotencyKey();
    const first = await forgeSignIn(phone, { provider: 'google', idToken, nonce }, key);
    expect(first.status).toBe(200);
    const replay = await forgeSignIn(phone, { provider: 'google', idToken, nonce }, key);
    expect(errorCode(replay)).toBe('idempotency_key_reused');
    expect(JSON.stringify(replay.body)).not.toMatch(/refreshToken|accessToken/);
    expect(errorCode(await forgeSignIn(phone, { provider: 'google', idToken, nonce }))).toBe(
      'invalid_id_token',
    );
  });

  it('caps open nonces per device and says when to retry', async () => {
    const bot = await device('bot');
    for (let i = 0; i < MOCK_ACCOUNT_RULES.maxOpenNoncesPerDevice; i++) {
      expect((await requestNonce(bot, 'google', 'signin')).status).toBe(200);
    }
    const refused = await requestNonce(bot, 'google', 'signin');
    expect(errorCode(refused)).toBe('rate_limited');
    expect(refused.status).toBe(429);
    expect((refused.body as { error: { retryAfterMs: number } }).error.retryAfterMs).toBe(
      MOCK_ACCOUNT_RULES.nonceTtlMs,
    );
    time.advance(MOCK_ACCOUNT_RULES.nonceTtlMs);
    expect((await requestNonce(bot, 'google', 'signin')).status).toBe(200);
  });

  it('holds a bot to the request envelope on the account routes', async () => {
    const bot = await device('bot');
    const token = await bot.player.session.accessToken();
    const codes: (string | null)[] = [];
    for (let i = 0; i <= MOCK_RULES.maxRequestsPerSecond; i++) {
      codes.push(
        errorCode(
          await forge(server, bot.player.device, {
            method: 'GET',
            path: '/v1/account',
            body: null,
            token,
          }),
        ),
      );
    }
    expect(codes.slice(0, -2).every((code) => code === null)).toBe(true);
    expect(codes.at(-1)).toBe('rate_limited');
  });

  it('only issues link nonces to the device holding the session', async () => {
    const alice = await device('alice');
    const bob = await device('bob');
    expect(errorCode(await requestNonce(alice, 'google', 'link', { token: null }))).toBe(
      'unauthorized',
    );
    const bobToken = await bob.player.session.accessToken();
    expect(errorCode(await requestNonce(alice, 'google', 'link', { token: bobToken }))).toBe(
      'unauthorized',
    );
    expect(errorCode(await requestNonce(alice, 'google', 'link', { token: 'at_forged' }))).toBe(
      'unauthorized',
    );
  });

  it('refuses a sign-in signed by another key than the one in its body', async () => {
    const alice = await device('alice');
    await alice.account.link('google');
    const phone = await device('alice');
    const mallory = await device('mallory');
    const nonce = await nonceFor(phone, 'google', 'signin');
    const idToken = await server.identity.issue('google', nonce, { persona: 'alice' });
    const response = await forge(server, phone.player.device, {
      method: 'POST',
      path: '/v1/auth/signin',
      body: JSON.stringify({
        provider: 'google',
        idToken,
        nonce,
        devicePublicKey: phone.player.device.publicKey,
      }),
      signer: mallory.player.device,
    });
    expect(errorCode(response)).toBe('invalid_signature');
  });

  it('rejects any value smuggled into a link body', async () => {
    const alice = await device('alice');
    const nonce = await nonceFor(alice, 'google', 'link');
    const idToken = await server.identity.issue('google', nonce, { persona: 'alice' });
    const response = await forgeLink(alice, { provider: 'google', idToken, nonce, coins: 1e9 });
    expect(errorCode(response)).toBe('validation_failed');
  });
});

describe('retries', () => {
  it('resends a link under the same key and a nonce under fresh ones', async () => {
    const alice = await device('alice');
    server.setNetwork('dropResponses');
    await expect(alice.account.prepareLink('google')).rejects.toMatchObject({
      name: 'NetworkError',
    });
    const nonceKeys = alice.player.requests
      .filter((request) => request.path === '/v1/account/nonce')
      .map((request) => request.headers['Idempotency-Key']);
    expect(nonceKeys).toHaveLength(3);
    expect(new Set(nonceKeys).size).toBe(3);

    server.setNetwork('up');
    const prepared = await alice.account.prepareLink('google');
    server.setNetwork('dropResponses');
    await expect(prepared.complete()).rejects.toMatchObject({ name: 'NetworkError' });
    const linkKeys = alice.player.requests
      .filter((request) => request.path === '/v1/account/link')
      .map((request) => request.headers['Idempotency-Key']);
    expect(linkKeys).toHaveLength(3);
    expect(new Set(linkKeys).size).toBe(1);
    expect(server.accounts.events.filter((event) => event.kind === 'link')).toHaveLength(1);
  });

  it('never resends a sign-in whose answer was lost', async () => {
    const alice = await device('alice');
    await alice.account.link('google');
    const phone = await device('alice');
    const prepared = await phone.account.prepareSignIn('google');
    server.setNetwork('dropResponses');
    await expect(prepared.complete()).rejects.toMatchObject({ name: 'NetworkError' });
    expect(paths(phone.player.requests).filter((path) => path === '/v1/auth/signin')).toHaveLength(
      1,
    );
  });

  it('surfaces provider_unavailable from the server without retrying it', async () => {
    const sent: WireRequest[] = [];
    const unavailable: Transport = (request) => {
      sent.push(request);
      return Promise.resolve({
        status: 503,
        body: {
          error: {
            code: 'provider_unavailable',
            message: 'Google sign-in is not configured on this server.',
          },
        },
      });
    };
    const alice = await device('alice', { transport: unavailable });
    const error = await alice.account.prepareSignIn('google').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AccountRequestError);
    expect(error).toMatchObject({ code: 'provider_unavailable', status: 503 });
    expect(sent).toHaveLength(1);
  });
});

const UNSET: IdentityConfig = {
  googleClientId: undefined,
  appleServicesId: undefined,
  appleRedirectUri: undefined,
};

const CONFIGURED: IdentityConfig = {
  googleClientId: '1234-abc.apps.googleusercontent.com',
  appleServicesId: 'lu.bas.coinposh.web',
  appleRedirectUri: 'https://coinposh.test/',
};

describe('live providers', () => {
  it('reports provider_unavailable for unset client IDs without loading a script or sending a request', async () => {
    const loadScript = vi.fn(() => Promise.resolve());
    const sent: WireRequest[] = [];
    const alice = await device('alice', {
      drivers: liveIdentityDrivers(UNSET, { loadScript }),
      transport: (request) => {
        sent.push(request);
        return server.transport(request);
      },
    });
    expect(alice.account.offers()).toEqual([
      { provider: 'google', available: false, demo: false },
      { provider: 'apple', available: false, demo: false },
    ]);
    for (const provider of ['google', 'apple'] as const) {
      const error = await alice.account.prepareSignIn(provider).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(IdentityProviderError);
      expect(error).toMatchObject({
        code: 'provider_unavailable',
        reason: 'unconfigured',
        provider,
      });
    }
    await expect(alice.account.prepareLink('google')).rejects.toBeInstanceOf(IdentityProviderError);
    expect(loadScript).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect((await alice.player.client.call('state')).player.id).toBe(requirePlayerId(alice.player));
  });

  it('treats a malformed client ID as unavailable', () => {
    const drivers = liveIdentityDrivers(
      { ...CONFIGURED, googleClientId: 'my-secret-key', appleServicesId: 'nodots' },
      { loadScript: () => Promise.resolve() },
    );
    expect(drivers.google.unavailable).toMatch(/not a google client ID/);
    expect(drivers.apple.unavailable).toMatch(/not a apple client ID/);
  });

  it('loads the Google script only on tap and signs in with the credential GIS hands back', async () => {
    const alice = await device('alice');
    await alice.account.link('google');
    const loadScript = vi.fn((_src: string) => Promise.resolve());
    let callback: ((response: { credential?: string }) => void) | null = null;
    let nonce = '';
    const host = {} as HTMLElement;
    const google: GoogleIdApi = {
      initialize: (config) => {
        callback = config.callback;
        nonce = config.nonce;
      },
      renderButton: (parent) => {
        expect(parent).toBe(host);
        void server.identity.issue('google', nonce, { persona: 'alice' }).then((credential) => {
          callback?.({ credential });
        });
      },
      prompt: () => undefined,
      cancel: () => undefined,
    };
    const phone = await device('alice', {
      drivers: liveIdentityDrivers(CONFIGURED, { loadScript, google: () => google }),
    });
    expect(phone.account.offers().every((offer) => offer.available && !offer.demo)).toBe(true);
    expect(loadScript).not.toHaveBeenCalled();

    const prepared = await phone.account.prepareSignIn('google');
    expect(loadScript.mock.calls).toEqual([[GOOGLE_GIS_SCRIPT]]);
    const swap = await signedIn(prepared.complete({ host }));
    expect(swap?.to).toBe(requirePlayerId(alice.player));
  });

  it('calls Apple with the server nonce and refuses an answer for another state', async () => {
    const loadScript = vi.fn((_src: string) => Promise.resolve());
    let init: Parameters<AppleAuthApi['init']>[0] | null = null;
    let answer: 'ok' | 'wrong-state' | 'closed' = 'ok';
    const apple: AppleAuthApi = {
      init: (config) => {
        init = config;
      },
      signIn: async () => {
        const config = init;
        if (config === null) throw new Error('init first');
        if (answer === 'closed')
          throw Object.assign(new Error('Popup closed.'), { error: 'popup_closed_by_user' });
        const idToken = await server.identity.issue('apple', config.nonce, { persona: 'alice' });
        return {
          authorization: {
            id_token: idToken,
            state: answer === 'ok' ? config.state : 'forged',
          },
        };
      },
    };
    const linking = await device('alice', {
      drivers: liveIdentityDrivers(CONFIGURED, { loadScript, apple: () => apple }),
    });

    answer = 'closed';
    await expect(linking.account.link('apple')).rejects.toBeInstanceOf(SignInCancelledError);
    answer = 'wrong-state';
    await expect(linking.account.link('apple')).rejects.toMatchObject({
      name: 'IdentityProviderError',
      reason: 'failed',
    });
    answer = 'ok';
    const account = await linking.account.link('apple');
    expect(account.identities.map((identity) => identity.provider)).toEqual(['apple']);
    expect(init).toMatchObject({
      clientId: CONFIGURED.appleServicesId,
      redirectURI: CONFIGURED.appleRedirectUri,
      usePopup: true,
    });
    expect(new Set(loadScript.mock.calls.map(([src]) => src))).toEqual(new Set([APPLE_JS_SCRIPT]));
  });

  it('maps a script that failed to load to provider_unavailable', async () => {
    const alice = await device('alice', {
      drivers: liveIdentityDrivers(CONFIGURED, {
        loadScript: () => Promise.reject(new Error('blocked by an extension')),
      }),
    });
    await expect(alice.account.prepareSignIn('google')).rejects.toMatchObject({
      name: 'IdentityProviderError',
      code: 'provider_unavailable',
      reason: 'load_failed',
    });
  });
});

describe('domScriptLoader', () => {
  class FakeScript extends EventTarget {
    src = '';
    async = false;
    removed = false;
    remove() {
      this.removed = true;
    }
  }

  it('injects each script once and lets a failed one be tried again', async () => {
    const appended: FakeScript[] = [];
    const doc = {
      createElement: () => new FakeScript(),
      head: { append: (script: FakeScript) => appended.push(script) },
    } as unknown as Document;
    const load = domScriptLoader(() => doc);

    const first = load(GOOGLE_GIS_SCRIPT);
    const second = load(GOOGLE_GIS_SCRIPT);
    expect(second).toBe(first);
    expect(appended).toHaveLength(1);
    appended[0]?.dispatchEvent(new Event('error'));
    await expect(first).rejects.toThrow(/did not load/);
    expect(appended[0]?.removed).toBe(true);

    const retry = load(GOOGLE_GIS_SCRIPT);
    expect(appended).toHaveLength(2);
    expect(appended[1]).toMatchObject({ src: GOOGLE_GIS_SCRIPT, async: true });
    appended[1]?.dispatchEvent(new Event('load'));
    await expect(retry).resolves.toBeUndefined();
  });
});

class FakeStorage implements MockStorage {
  readonly items = new Map<string, string>();
  writes = 0;

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.writes += 1;
    this.items.set(key, value);
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }
}

describe('Demo account persistence', () => {
  function page(storage: FakeStorage, warnings: string[] = []): MockServer {
    return createMockServer({
      now: time.now,
      storage,
      lifecycle: null,
      onPersistWarning: (message) => warnings.push(message),
    });
  }

  it('keeps links across a reload of the tab, beside the world they point into', async () => {
    const storage = new FakeStorage();
    server = page(storage);
    const alice = await device('alice');
    await alice.account.link('google');
    const id = requirePlayerId(alice.player);
    server.flush();
    expect(storage.items.has(DEMO_ACCOUNT_STORAGE_KEY)).toBe(true);
    const writes = storage.writes;
    server.flush();
    expect(storage.writes).toBe(writes + 1);

    server = page(storage);
    expect(server.restored).toBe(true);
    expect(server.accounts.account(id).identities).toHaveLength(1);
    const reloaded = await device('alice');
    expect(requirePlayerId(reloaded.player)).toBe(id);
    expect((await reloaded.account.get()).identities).toHaveLength(1);
    const phone = await device('alice');
    expect(requirePlayerId(phone.player)).not.toBe(id);
    const swap = await signedIn(phone.account.signIn('google'));
    expect(swap?.to).toBe(id);
  });

  it('drops a broken or mismatched account blob and keeps the world', async () => {
    const storage = new FakeStorage();
    server = page(storage);
    const alice = await device('alice');
    const id = requirePlayerId(alice.player);
    await alice.account.link('apple');
    server.flush();

    storage.items.set(DEMO_ACCOUNT_STORAGE_KEY, '{"schema":1,"identities":"nope","events":[]}');
    const warnings: string[] = [];
    server = page(storage, warnings);
    expect(server.restored).toBe(true);
    expect(server.world.player(id)).toBeDefined();
    expect(server.accounts.account(id).identities).toEqual([]);
    expect(warnings).toEqual([expect.stringMatching(/account links were dropped: its shape/)]);
    expect(storage.items.has(DEMO_ACCOUNT_STORAGE_KEY)).toBe(false);

    storage.items.set(
      DEMO_ACCOUNT_STORAGE_KEY,
      JSON.stringify({
        schema: 1,
        identities: [
          {
            provider: 'google',
            subject: 'demo-google-ghost',
            playerId: crypto.randomUUID(),
            linkedAt: time.now(),
            emailHint: null,
          },
        ],
        events: [],
      }),
    );
    warnings.length = 0;
    server = page(storage, warnings);
    expect(warnings).toEqual([expect.stringMatching(/names unknown player/)]);
  });

  it('forgets links when the world they belong to is gone', async () => {
    const storage = new FakeStorage();
    server = page(storage);
    const alice = await device('alice');
    await alice.account.link('google');
    server.flush();
    storage.items.delete('coinposh.demo.world');

    server = page(storage);
    expect(server.restored).toBe(false);
    expect(storage.items.has(DEMO_ACCOUNT_STORAGE_KEY)).toBe(false);
    const phone = await device('alice');
    await expect(phone.account.signIn('google')).rejects.toMatchObject({ code: 'not_found' });
  });
});
