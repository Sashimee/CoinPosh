import {
  accountEndpoints,
  endpoints,
  HEADERS,
  type AccountNonceResponse,
  type IdempotencyKey,
  type IdentityProvider,
  type NoncePurpose,
  type SignInResponse,
} from '@coinposh/shared';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../crypto.ts';
import { deviceKeyThumbprint } from '../auth/device.ts';
import { MAX_OPEN_NONCES_PER_DEVICE, MAX_OPEN_NONCES_PER_IP } from '../auth/link/nonces.ts';
import { REFRESH_REPLAY_WINDOW_MS } from '../auth/refreshReplay.ts';
import { PROVIDERS } from '../auth/link/providers.ts';
import { LocalJwks, newSigningKey, signIdToken, type SigningKey } from '../auth/link/testIssuer.ts';
import { createApp } from '../index.ts';
import {
  API_ORIGIN,
  newDevice,
  newIdempotencyKey,
  newSession,
  send,
  signParts,
  type Device,
  type Session,
} from '../test/client.ts';
import { dropAsClient, expectConserved, expectError, state, vaultCoins } from '../test/game.ts';

const GOOGLE_CLIENT_ID = 'coinposh-test.apps.googleusercontent.com';
const APPLE_SERVICES_ID = 'lu.bas.coinposh.test';

const jwks = new LocalJwks();
const googleKey = await newSigningKey('google-test-1');
const appleKey = await newSigningKey('apple-test-1');
const forger = await newSigningKey('google-test-1');
jwks.publish(PROVIDERS.google.jwksUrl, [googleKey]);
jwks.publish(PROVIDERS.apple.jwksUrl, [appleKey]);

const configured = {
  ...env,
  GOOGLE_CLIENT_ID,
  APPLE_SERVICES_ID,
  APPLE_TEAM_ID: 'TEAM123456',
  APPLE_KEY_ID: 'KEY1234567',
  APPLE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\ntest-only\n-----END PRIVATE KEY-----',
};
const linkedApp = createApp({ fetchJwks: jwks.fetcher });

interface CallOptions {
  readonly body?: unknown;
  readonly accessToken?: string;
  readonly idempotencyKey?: IdempotencyKey;
  readonly env?: Record<string, unknown>;
  readonly ip?: string;
}

/** Each call comes from its own address unless a test pins one, so per-IP caps stay out of the way. */
function randomIp(): string {
  const [a, b] = crypto.getRandomValues(new Uint16Array(2));
  return `2001:db8::${(a ?? 0).toString(16)}:${(b ?? 0).toString(16)}`;
}

/** Like test/client `send`, but through an app whose provider keys come from `jwks`. */
async function call(device: Device, path: string, options: CallOptions = {}): Promise<Response> {
  const method = options.body === undefined ? 'GET' : 'POST';
  const rawBody = options.body === undefined ? '' : JSON.stringify(options.body);
  const idempotencyKey = method === 'POST' ? (options.idempotencyKey ?? newIdempotencyKey()) : null;
  const headers = new Headers();
  if (rawBody !== '') headers.set('Content-Type', 'application/json');
  if (options.accessToken !== undefined) {
    headers.set(HEADERS.authorization, `Bearer ${options.accessToken}`);
  }
  if (idempotencyKey !== null) headers.set(HEADERS.idempotencyKey, idempotencyKey);
  headers.set('CF-Connecting-IP', options.ip ?? randomIp());
  headers.set(
    HEADERS.deviceSignature,
    await signParts(device.privateKey, method, path, idempotencyKey, rawBody),
  );
  const request = new Request(`${API_ORIGIN}${path}`, {
    method,
    headers,
    ...(method === 'POST' ? { body: rawBody } : {}),
  });
  return linkedApp.fetch(request, options.env ?? configured);
}

/** A link nonce needs the session's bearer token; a sign-in nonce only the device key. */
async function nonceFor(
  who: Device | Session,
  provider: IdentityProvider,
  purpose: NoncePurpose,
  ip?: string,
): Promise<AccountNonceResponse> {
  const device = 'tokens' in who ? who.device : who;
  const response = await call(device, accountEndpoints.accountNonce.path, {
    body: { provider, purpose, devicePublicKey: device.publicKey },
    ...('tokens' in who ? { accessToken: who.tokens.accessToken } : {}),
    ...(ip === undefined ? {} : { ip }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return accountEndpoints.accountNonce.response.parse(await response.json());
}

interface TokenOptions {
  readonly subject: string;
  readonly nonce: string;
  readonly key?: SigningKey;
  readonly claims?: Record<string, unknown>;
}

function googleToken(options: TokenOptions): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signIdToken(options.key ?? googleKey, {
    iss: 'https://accounts.google.com',
    aud: GOOGLE_CLIENT_ID,
    sub: options.subject,
    iat: now,
    exp: now + 3600,
    nonce: options.nonce,
    email: 'lucie@gmail.com',
    email_verified: true,
    ...options.claims,
  });
}

function appleToken(options: TokenOptions): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signIdToken(options.key ?? appleKey, {
    iss: 'https://appleid.apple.com',
    aud: APPLE_SERVICES_ID,
    sub: options.subject,
    iat: now,
    exp: now + 600,
    nonce: options.nonce,
    ...options.claims,
  });
}

function newSubject(): string {
  return `sub-${crypto.randomUUID()}`;
}

function link(session: Session, body: unknown, idempotencyKey?: IdempotencyKey) {
  return call(session.device, accountEndpoints.accountLink.path, {
    body,
    accessToken: session.tokens.accessToken,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  });
}

async function linkGoogle(session: Session, subject: string): Promise<Response> {
  const { nonce } = await nonceFor(session, 'google', 'link');
  return link(session, {
    provider: 'google',
    idToken: await googleToken({ subject, nonce }),
    nonce,
  });
}

async function signIn(
  device: Device,
  subject: string,
  provider: IdentityProvider = 'google',
): Promise<Response> {
  const { nonce } = await nonceFor(device, provider, 'signin');
  const idToken =
    provider === 'google'
      ? await googleToken({ subject, nonce })
      : await appleToken({ subject, nonce });
  return call(device, accountEndpoints.authSignIn.path, {
    body: { provider, idToken, nonce, devicePublicKey: device.publicKey },
  });
}

async function signedIn(device: Device, subject: string): Promise<SignInResponse> {
  const response = await signIn(device, subject);
  expect(response.status, await response.clone().text()).toBe(200);
  return accountEndpoints.authSignIn.response.parse(await response.json());
}

function sessionOf(device: Device, tokens: SignInResponse): Session {
  return {
    device,
    tokens,
    call: (path, options = {}) =>
      send(device, path, { accessToken: tokens.accessToken, ...options }),
  };
}

/** A guest that has really played: its Vault no longer matches a fresh save. */
async function playedGuest(): Promise<Session> {
  const session = await newSession();
  await dropAsClient(session, 3);
  return session;
}

/** A save linked to a fresh Google subject, on its own first device. */
async function linkedAccount(): Promise<{ session: Session; subject: string }> {
  const session = await newSession();
  const subject = newSubject();
  expect((await linkGoogle(session, subject)).status).toBe(200);
  return { session, subject };
}

function refresh(device: Device, refreshToken: string) {
  return send(device, endpoints.authRefresh.path, { body: { refreshToken } });
}

describe('POST /v1/account/nonce', () => {
  it('issues a single-use, ten-minute nonce bound to the asking device', async () => {
    const device = await newDevice();
    const before = Date.now();
    const issued = await nonceFor(device, 'google', 'signin');
    expect(issued.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.expiresAt).toBeGreaterThanOrEqual(before + 10 * 60 * 1000);
    expect(issued.expiresAt).toBeLessThanOrEqual(Date.now() + 10 * 60 * 1000);
    const row = await env.DB.prepare(
      'SELECT device_jkt, purpose FROM account_nonces WHERE nonce = ?',
    )
      .bind(issued.nonce)
      .first();
    expect(row).toMatchObject({ purpose: 'signin' });
  });

  it('refuses a request signed by a key other than the one it names', async () => {
    const device = await newDevice();
    const attacker = await newDevice();
    const response = await call(attacker, accountEndpoints.accountNonce.path, {
      body: { provider: 'google', purpose: 'link', devicePublicKey: device.publicKey },
    });
    await expectError(response, 401, 'invalid_signature');
  });

  it('refuses a replay of a captured nonce request', async () => {
    const device = await newDevice();
    const idempotencyKey = newIdempotencyKey();
    const body = { provider: 'google', purpose: 'signin', devicePublicKey: device.publicKey };
    expect(
      (await call(device, accountEndpoints.accountNonce.path, { body, idempotencyKey })).status,
    ).toBe(200);
    await expectError(
      await call(device, accountEndpoints.accountNonce.path, { body, idempotencyKey }),
      422,
      'idempotency_key_reused',
    );
  });

  it('caps the unspent nonces one device can hold (bot envelope)', async () => {
    const device = await newDevice();
    for (let i = 0; i < MAX_OPEN_NONCES_PER_DEVICE; i++) await nonceFor(device, 'apple', 'signin');
    const response = await call(device, accountEndpoints.accountNonce.path, {
      body: { provider: 'apple', purpose: 'signin', devicePublicKey: device.publicKey },
    });
    await expectError(response, 429, 'rate_limited');
    expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
  });

  it('caps the unspent nonces one IP can hold, however many device keys a bot mints', async () => {
    const ip = randomIp();
    for (let i = 0; i < MAX_OPEN_NONCES_PER_IP; i++) {
      await nonceFor(await newDevice(), 'google', 'signin', ip);
    }
    const bot = await newDevice();
    const idempotencyKey = newIdempotencyKey();
    const response = await call(bot, accountEndpoints.accountNonce.path, {
      body: { provider: 'google', purpose: 'signin', devicePublicKey: bot.publicKey },
      idempotencyKey,
      ip,
    });
    await expectError(response, 429, 'rate_limited');
    expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
    const burned = await env.DB.prepare('SELECT 1 FROM auth_requests WHERE idempotency_key = ?')
      .bind(idempotencyKey)
      .first();
    expect(burned, 'a refused request must not write an auth_requests row').toBeNull();
    const stored = await env.DB.prepare('SELECT 1 FROM account_nonces WHERE device_jkt = ?')
      .bind(await deviceKeyThumbprint(bot.publicKey))
      .first();
    expect(stored, 'a refused request must not write a nonce').toBeNull();
    await nonceFor(await newDevice(), 'google', 'signin');
  });

  it('never stores the client IP itself', async () => {
    const ip = '203.0.113.77';
    const { nonce } = await nonceFor(await newDevice(), 'google', 'signin', ip);
    const row = await env.DB.prepare('SELECT client_ip FROM account_nonces WHERE nonce = ?')
      .bind(nonce)
      .first<{ client_ip: string }>();
    expect(row?.client_ip).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(row?.client_ip).not.toContain('203.0.113');
  });

  it('issues a link nonce only to a session of the key that signs the request', async () => {
    const device = await newDevice();
    const body = { provider: 'google', purpose: 'link', devicePublicKey: device.publicKey };
    await expectError(
      await call(device, accountEndpoints.accountNonce.path, { body }),
      401,
      'unauthorized',
    );
    const other = await newSession();
    await expectError(
      await call(device, accountEndpoints.accountNonce.path, {
        body,
        accessToken: other.tokens.accessToken,
      }),
      401,
      'unauthorized',
    );
    const session = await newSession();
    const response = await call(session.device, accountEndpoints.accountNonce.path, {
      body: { provider: 'google', purpose: 'link', devicePublicKey: session.device.publicKey },
      accessToken: session.tokens.accessToken,
    });
    expect(response.status, await response.clone().text()).toBe(200);
  });

  it('answers provider_unavailable for a provider whose secrets are missing', async () => {
    const device = await newDevice();
    const response = await call(device, accountEndpoints.accountNonce.path, {
      body: { provider: 'apple', purpose: 'link', devicePublicKey: device.publicKey },
      env: { ...configured, APPLE_PRIVATE_KEY: undefined },
    });
    await expectError(response, 503, 'provider_unavailable');
  });
});

describe('POST /v1/account/link', () => {
  it('links a verified Google identity and exposes only a masked email', async () => {
    const session = await newSession();
    const response = await linkGoogle(session, newSubject());
    expect(response.status, await response.clone().text()).toBe(200);
    const account = accountEndpoints.accountLink.response.parse(await response.json());
    expect(account).toMatchObject({
      playerId: session.tokens.playerId,
      identities: [{ provider: 'google', emailHint: 'l•••@gmail.com' }],
      available: ['google', 'apple'],
    });
    expect(JSON.stringify(account)).not.toContain('lucie@');
  });

  it('links Apple too, accepting the hashed nonce native Sign in with Apple sends', async () => {
    const session = await newSession();
    const { nonce } = await nonceFor(session, 'apple', 'link');
    const idToken = await appleToken({ subject: newSubject(), nonce: await sha256Hex(nonce) });
    const response = await link(session, { provider: 'apple', idToken, nonce });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(accountEndpoints.accountLink.response.parse(await response.json()).identities).toEqual([
      expect.objectContaining({ provider: 'apple' }),
    ]);
  });

  it('is idempotent: linking the same identity again changes nothing', async () => {
    const { session, subject } = await linkedAccount();
    const again = await linkGoogle(session, subject);
    expect(again.status).toBe(200);
    const account = accountEndpoints.accountLink.response.parse(await again.json());
    expect(account.identities).toHaveLength(1);
    const events = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM account_events WHERE player_id = ? AND kind = 'link'",
    )
      .bind(session.tokens.playerId)
      .first<{ n: number }>();
    expect(events?.n).toBe(1);
  });

  it('answers a network retry of the exact same request as a replay', async () => {
    const session = await newSession();
    const { nonce } = await nonceFor(session, 'google', 'link');
    const body = {
      provider: 'google',
      idToken: await googleToken({ subject: newSubject(), nonce }),
      nonce,
    };
    const key = newIdempotencyKey();
    expect((await link(session, body, key)).status).toBe(200);
    const retry = await link(session, body, key);
    expect(retry.status).toBe(200);
    expect(retry.headers.get('Idempotent-Replayed')).toBe('true');
  });

  it('refuses a forged signature under the genuine key id', async () => {
    const session = await newSession();
    const { nonce } = await nonceFor(session, 'google', 'link');
    const forged = await googleToken({ subject: newSubject(), nonce, key: forger });
    await expectError(
      await link(session, { provider: 'google', idToken: forged, nonce }),
      401,
      'invalid_id_token',
    );
    const genuine = await googleToken({ subject: newSubject(), nonce });
    expect((await link(session, { provider: 'google', idToken: genuine, nonce })).status).toBe(200);
  });

  it('refuses a token minted for another app (wrong aud)', async () => {
    const session = await newSession();
    const { nonce } = await nonceFor(session, 'google', 'link');
    const idToken = await googleToken({
      subject: newSubject(),
      nonce,
      claims: { aud: 'someone-elses-app.apps.googleusercontent.com' },
    });
    await expectError(
      await link(session, { provider: 'google', idToken, nonce }),
      401,
      'invalid_id_token',
    );
  });

  it('refuses an expired token', async () => {
    const session = await newSession();
    const { nonce } = await nonceFor(session, 'google', 'link');
    const past = Math.floor(Date.now() / 1000) - 7200;
    const idToken = await googleToken({
      subject: newSubject(),
      nonce,
      claims: { iat: past, exp: past + 3600 },
    });
    await expectError(
      await link(session, { provider: 'google', idToken, nonce }),
      401,
      'invalid_id_token',
    );
  });

  it('refuses a replayed nonce, even with a fresh idempotency key', async () => {
    const session = await newSession();
    const { nonce } = await nonceFor(session, 'google', 'link');
    const body = {
      provider: 'google',
      idToken: await googleToken({ subject: newSubject(), nonce }),
      nonce,
    };
    expect((await link(session, body)).status).toBe(200);
    const replay = await link(session, body);
    await expectError(replay, 401, 'invalid_id_token');
  });

  it('refuses a same-key retry that changes the request', async () => {
    const session = await newSession();
    const { nonce } = await nonceFor(session, 'google', 'link');
    const subject = newSubject();
    const key = newIdempotencyKey();
    const first = { provider: 'google', idToken: await googleToken({ subject, nonce }), nonce };
    expect((await link(session, first, key)).status).toBe(200);
    const changed = {
      ...first,
      idToken: await googleToken({ subject, nonce, claims: { email: 'other@gmail.com' } }),
    };
    await expectError(await link(session, changed, key), 422, 'idempotency_key_reused');
  });

  it('refuses a token that embeds a different nonce than the one sent', async () => {
    const session = await newSession();
    const sent = await nonceFor(session, 'google', 'link');
    const other = await nonceFor(session, 'google', 'link');
    const idToken = await googleToken({ subject: newSubject(), nonce: other.nonce });
    await expectError(
      await link(session, { provider: 'google', idToken, nonce: sent.nonce }),
      401,
      'invalid_id_token',
    );
  });

  it('refuses a nonce issued to another device, for another purpose or provider, or expired', async () => {
    const session = await newSession();
    const thief = await newSession();
    const stolen = await nonceFor(thief, 'google', 'link');
    const signinNonce = await nonceFor(session.device, 'google', 'signin');
    const appleNonce = await nonceFor(session, 'apple', 'link');
    const stale = await nonceFor(session, 'google', 'link');
    await env.DB.prepare('UPDATE account_nonces SET expires_at = ? WHERE nonce = ?')
      .bind(Date.now() - 1, stale.nonce)
      .run();
    for (const { nonce } of [stolen, signinNonce, appleNonce, stale]) {
      const idToken = await googleToken({ subject: newSubject(), nonce });
      await expectError(
        await link(session, { provider: 'google', idToken, nonce }),
        401,
        'invalid_id_token',
      );
    }
    const unknown = 'u'.repeat(43);
    const idToken = await googleToken({ subject: newSubject(), nonce: unknown });
    await expectError(
      await link(session, { provider: 'google', idToken, nonce: unknown }),
      401,
      'invalid_id_token',
    );
  });

  it('refuses a subject already linked to another player', async () => {
    const { subject } = await linkedAccount();
    const intruder = await newSession();
    await expectError(await linkGoogle(intruder, subject), 409, 'identity_in_use');
    const owner = await env.DB.prepare('SELECT COUNT(*) AS n FROM identities WHERE subject = ?')
      .bind(subject)
      .first<{ n: number }>();
    expect(owner?.n).toBe(1);
  });

  it('refuses a second Google account on a save that already has one', async () => {
    const { session } = await linkedAccount();
    await expectError(await linkGoogle(session, newSubject()), 409, 'identity_in_use');
  });

  it('accepts no value field from the client', async () => {
    const session = await newSession();
    const { nonce } = await nonceFor(session, 'google', 'link');
    const idToken = await googleToken({ subject: newSubject(), nonce });
    const response = await link(session, {
      provider: 'google',
      idToken,
      nonce,
      wallet: { coins: 1_000_000 },
    });
    await expectError(response, 400, 'validation_failed');
  });

  it('requires a session', async () => {
    const device = await newDevice();
    await expectError(
      await call(device, accountEndpoints.accountLink.path, {
        body: { provider: 'google', idToken: 'a.b.c', nonce: 'n'.repeat(43) },
      }),
      401,
      'unauthorized',
    );
  });
});

describe('POST /v1/auth/signin', () => {
  it('registers a new device on the save, and the old device keeps working', async () => {
    const { session: home, subject } = await linkedAccount();
    const vaultBefore = await vaultCoins(home);
    const phone = await newDevice();
    const signedInTokens = await signedIn(phone, subject);
    expect(signedInTokens.playerId).toBe(home.tokens.playerId);
    expect(signedInTokens.account.identities).toEqual([
      expect.objectContaining({ provider: 'google' }),
    ]);
    expect(signedInTokens.choice).toBeUndefined();

    const onPhone = sessionOf(phone, signedInTokens);
    expect((await state(onPhone)).player.id).toBe(home.tokens.playerId);
    expect((await state(home)).player.id).toBe(home.tokens.playerId);
    expect(await vaultCoins(home)).toBe(vaultBefore);

    const homeRefresh = await refresh(home.device, home.tokens.refreshToken);
    expect(homeRefresh.status).toBe(200);
    const phoneRefresh = await refresh(phone, signedInTokens.refreshToken);
    expect(phoneRefresh.status, await phoneRefresh.clone().text()).toBe(200);
    const rotated = endpoints.authRefresh.response.parse(await phoneRefresh.json());
    expect(rotated.playerId).toBe(home.tokens.playerId);
    expect((await state(sessionOf(phone, { ...signedInTokens, ...rotated }))).player.id).toBe(
      home.tokens.playerId,
    );
  });

  it("binds the new device's refresh token to that device's key", async () => {
    const { subject } = await linkedAccount();
    const phone = await newDevice();
    const tokens = await signedIn(phone, subject);
    const thief = await newDevice();
    await expectError(await refresh(thief, tokens.refreshToken), 401, 'invalid_signature');
  });

  it("revokes the new device's session family when a rotated refresh token is replayed", async () => {
    const { subject } = await linkedAccount();
    const phone = await newDevice();
    const tokens = await signedIn(phone, subject);
    const first = endpoints.authRefresh.response.parse(
      await (await refresh(phone, tokens.refreshToken)).json(),
    );
    await expectError(await refresh(phone, tokens.refreshToken), 401, 'unauthorized');
    await expectError(await refresh(phone, first.refreshToken), 401, 'unauthorized');
  });

  it("replays the new device's refresh resent under the same key, and the family stays live", async () => {
    const { subject } = await linkedAccount();
    const phone = await newDevice();
    const tokens = await signedIn(phone, subject);
    const idempotencyKey = newIdempotencyKey();
    const resend = (body: unknown = { refreshToken: tokens.refreshToken }) =>
      send(phone, endpoints.authRefresh.path, { body, idempotencyKey });

    const first = endpoints.authRefresh.response.parse(await (await resend()).json());
    const again = await resend();
    expect(again.status, await again.clone().text()).toBe(200);
    expect(endpoints.authRefresh.response.parse(await again.json())).toMatchObject({
      playerId: first.playerId,
      accessToken: first.accessToken,
      refreshToken: first.refreshToken,
    });

    await expectError(
      await resend(JSON.stringify({ refreshToken: tokens.refreshToken }, null, 1)),
      422,
      'idempotency_key_reused',
    );
    await env.DB.prepare('UPDATE auth_requests SET at = at - ? WHERE idempotency_key = ?')
      .bind(REFRESH_REPLAY_WINDOW_MS + 1, idempotencyKey)
      .run();
    await expectError(await resend(), 422, 'idempotency_key_reused');

    const next = await refresh(phone, first.refreshToken);
    expect(next.status, await next.clone().text()).toBe(200);
  });

  it('offers a choice, never a merge, when the device holds an unlinked guest with progress', async () => {
    const { session: home, subject } = await linkedAccount();
    const guest = await playedGuest();
    const guestVault = await vaultCoins(guest);
    const homeVault = await vaultCoins(home);
    const guestVenue = (await state(guest)).venue.id;

    const response = await signedIn(guest.device, subject);
    expect(response.playerId).toBe(home.tokens.playerId);
    expect(response.choice).toMatchObject({
      guest: { playerId: guest.tokens.playerId, coins: guestVault, venue: guestVenue },
      account: { playerId: home.tokens.playerId, coins: homeVault },
    });

    expect(await vaultCoins(guest)).toBe(guestVault);
    expect(await vaultCoins(home)).toBe(homeVault);
    await expectConserved(guest);
    await expectConserved(home);
    const guestAgain = await send(guest.device, endpoints.authGuest.path, {
      body: { devicePublicKey: guest.device.publicKey, turnstileToken: 't', locale: 'en' },
    });
    expect(endpoints.authGuest.response.parse(await guestAgain.json()).playerId).toBe(
      guest.tokens.playerId,
    );
  });

  it('offers no choice for a guest that has not played yet', async () => {
    const { subject } = await linkedAccount();
    const fresh = await newSession();
    expect((await signedIn(fresh.device, subject)).choice).toBeUndefined();
  });

  it("offers no choice when the device's own save is already linked elsewhere", async () => {
    const { subject } = await linkedAccount();
    const other = await linkedAccount();
    await dropAsClient(other.session, 3);
    expect((await signedIn(other.session.device, subject)).choice).toBeUndefined();
  });

  it("signs the save's own first device back in without registering a second key", async () => {
    const { session, subject } = await linkedAccount();
    await dropAsClient(session, 2);
    const response = await signedIn(session.device, subject);
    expect(response.choice).toBeUndefined();
    const devices = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM player_devices WHERE player_id = ?',
    )
      .bind(session.tokens.playerId)
      .first<{ n: number }>();
    expect(devices?.n).toBe(0);
    expect((await refresh(session.device, response.refreshToken)).status).toBe(200);
  });

  it('answers not_found for an identity no save is linked to', async () => {
    await expectError(await signIn(await newDevice(), newSubject()), 404, 'not_found');
  });

  it('works with Apple', async () => {
    const session = await newSession();
    const subject = newSubject();
    const { nonce } = await nonceFor(session, 'apple', 'link');
    expect(
      (
        await link(session, {
          provider: 'apple',
          idToken: await appleToken({ subject, nonce }),
          nonce,
        })
      ).status,
    ).toBe(200);
    const response = await signIn(await newDevice(), subject, 'apple');
    expect(response.status).toBe(200);
    expect(accountEndpoints.authSignIn.response.parse(await response.json()).playerId).toBe(
      session.tokens.playerId,
    );
  });

  it('refuses a replay of a captured sign-in request', async () => {
    const { subject } = await linkedAccount();
    const phone = await newDevice();
    const { nonce } = await nonceFor(phone, 'google', 'signin');
    const body = {
      provider: 'google',
      idToken: await googleToken({ subject, nonce }),
      nonce,
      devicePublicKey: phone.publicKey,
    };
    const idempotencyKey = newIdempotencyKey();
    expect(
      (await call(phone, accountEndpoints.authSignIn.path, { body, idempotencyKey })).status,
    ).toBe(200);
    await expectError(
      await call(phone, accountEndpoints.authSignIn.path, { body, idempotencyKey }),
      422,
      'idempotency_key_reused',
    );
    await expectError(
      await call(phone, accountEndpoints.authSignIn.path, { body }),
      401,
      'invalid_id_token',
    );
  });

  it("refuses an attacker device replaying a victim's ID token and nonce", async () => {
    const { subject } = await linkedAccount();
    const victim = await newDevice();
    const attacker = await newDevice();
    const { nonce } = await nonceFor(victim, 'google', 'signin');
    const idToken = await googleToken({ subject, nonce });
    const response = await call(attacker, accountEndpoints.authSignIn.path, {
      body: { provider: 'google', idToken, nonce, devicePublicKey: attacker.publicKey },
    });
    await expectError(response, 401, 'invalid_id_token');
  });

  it('refuses a forged token and a link nonce', async () => {
    const { subject } = await linkedAccount();
    const guest = await newSession();
    const phone = guest.device;
    const signinNonce = await nonceFor(phone, 'google', 'signin');
    const forged = await googleToken({ subject, nonce: signinNonce.nonce, key: forger });
    await expectError(
      await call(phone, accountEndpoints.authSignIn.path, {
        body: {
          provider: 'google',
          idToken: forged,
          nonce: signinNonce.nonce,
          devicePublicKey: phone.publicKey,
        },
      }),
      401,
      'invalid_id_token',
    );
    const linkNonce = await nonceFor(guest, 'google', 'link');
    await expectError(
      await call(phone, accountEndpoints.authSignIn.path, {
        body: {
          provider: 'google',
          idToken: await googleToken({ subject, nonce: linkNonce.nonce }),
          nonce: linkNonce.nonce,
          devicePublicKey: phone.publicKey,
        },
      }),
      401,
      'invalid_id_token',
    );
  });
});

describe('POST /v1/account/unlink', () => {
  it('signs out the devices that came in through it, and the first device keeps working', async () => {
    const { session: home, subject } = await linkedAccount();
    const phone = await newDevice();
    const phoneTokens = await signedIn(phone, subject);

    const response = await call(home.device, accountEndpoints.accountUnlink.path, {
      body: { provider: 'google' },
      accessToken: home.tokens.accessToken,
    });
    expect(response.status).toBe(200);
    expect(accountEndpoints.accountUnlink.response.parse(await response.json()).identities).toEqual(
      [],
    );

    await expectError(await refresh(phone, phoneTokens.refreshToken), 401, 'unauthorized');
    expect((await refresh(home.device, home.tokens.refreshToken)).status).toBe(200);
    await expectError(await signIn(await newDevice(), subject), 404, 'not_found');
  });

  it('keeps the unlinking device signed in, and is idempotent', async () => {
    const { subject } = await linkedAccount();
    const phone = await newDevice();
    const tokens = await signedIn(phone, subject);
    for (let i = 0; i < 2; i++) {
      const response = await call(phone, accountEndpoints.accountUnlink.path, {
        body: { provider: 'google' },
        accessToken: tokens.accessToken,
      });
      expect(response.status).toBe(200);
    }
    expect((await refresh(phone, tokens.refreshToken)).status).toBe(200);
  });

  it('frees the identity to be linked to a different save', async () => {
    const { session, subject } = await linkedAccount();
    await call(session.device, accountEndpoints.accountUnlink.path, {
      body: { provider: 'google' },
      accessToken: session.tokens.accessToken,
    });
    const other = await newSession();
    expect((await linkGoogle(other, subject)).status).toBe(200);
  });

  it('keeps an append-only audit of every link, sign-in and unlink', async () => {
    const { session, subject } = await linkedAccount();
    await signedIn(await newDevice(), subject);
    await call(session.device, accountEndpoints.accountUnlink.path, {
      body: { provider: 'google' },
      accessToken: session.tokens.accessToken,
    });
    const kinds = await env.DB.prepare(
      'SELECT kind FROM account_events WHERE player_id = ? ORDER BY id',
    )
      .bind(session.tokens.playerId)
      .all<{ kind: string }>();
    expect(kinds.results.map((row) => row.kind)).toEqual(['link', 'signin', 'unlink']);
    await expect(
      env.DB.prepare('DELETE FROM account_events WHERE player_id = ?')
        .bind(session.tokens.playerId)
        .run(),
    ).rejects.toThrow(/append-only/);
  });
});

describe('GET /v1/account', () => {
  it('lists linked identities and the providers this server can verify', async () => {
    const { session } = await linkedAccount();
    const response = await call(session.device, accountEndpoints.account.path, {
      accessToken: session.tokens.accessToken,
    });
    expect(accountEndpoints.account.response.parse(await response.json())).toMatchObject({
      playerId: session.tokens.playerId,
      identities: [{ provider: 'google' }],
      available: ['google', 'apple'],
    });
  });
});

describe('without provider secrets (the deployed worker before H-10.01/H-10.02)', () => {
  it('answers provider_unavailable everywhere a provider is needed', async () => {
    const device = await newDevice();
    const nonceResponse = await send(device, accountEndpoints.accountNonce.path, {
      body: { provider: 'google', purpose: 'signin', devicePublicKey: device.publicKey },
    });
    await expectError(nonceResponse, 503, 'provider_unavailable');
    const signInResponse = await send(device, accountEndpoints.authSignIn.path, {
      body: {
        provider: 'apple',
        idToken: 'a.b.c',
        nonce: 'n'.repeat(43),
        devicePublicKey: device.publicKey,
      },
    });
    await expectError(signInResponse, 503, 'provider_unavailable');
  });

  it('leaves guest play untouched and reports no provider as available', async () => {
    const session = await newSession();
    await dropAsClient(session, 2);
    await expectConserved(session);
    const linkResponse = await session.call(accountEndpoints.accountLink.path, {
      body: { provider: 'google', idToken: 'a.b.c', nonce: 'n'.repeat(43) },
    });
    await expectError(linkResponse, 503, 'provider_unavailable');
    const account = await session.call(accountEndpoints.account.path);
    expect(accountEndpoints.account.response.parse(await account.json())).toEqual({
      playerId: session.tokens.playerId,
      identities: [],
      available: [],
    });
    expect((await refresh(session.device, session.tokens.refreshToken)).status).toBe(200);
  });

  it('answers provider_unavailable when the provider keys cannot be fetched', async () => {
    const down = new LocalJwks();
    down.failing = true;
    const app = createApp({ fetchJwks: down.fetcher });
    const session = await newSession();
    const { nonce } = await nonceFor(session, 'google', 'link');
    const rawBody = JSON.stringify({
      provider: 'google',
      idToken: await googleToken({ subject: newSubject(), nonce }),
      nonce,
    });
    const idempotencyKey = newIdempotencyKey();
    const path = accountEndpoints.accountLink.path;
    const response = await app.fetch(
      new Request(`${API_ORIGIN}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [HEADERS.authorization]: `Bearer ${session.tokens.accessToken}`,
          [HEADERS.idempotencyKey]: idempotencyKey,
          [HEADERS.deviceSignature]: await signParts(
            session.device.privateKey,
            'POST',
            path,
            idempotencyKey,
            rawBody,
          ),
        },
        body: rawBody,
      }),
      configured,
    );
    await expectError(response, 503, 'provider_unavailable');
  });
});
