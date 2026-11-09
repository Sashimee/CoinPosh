import { coinTiers, openingHeap, upgradeLines, upgradeStat } from '@coinposh/economy';
import { endpoints, HEADERS, PlayerIdSchema } from '@coinposh/shared';
import { env, exports } from 'cloudflare:workers';
import { sign } from 'hono/jwt';
import { describe, expect, it } from 'vitest';
import { ACCESS_TOKEN_TTL_MS, authSecret, issueAccessToken } from '../auth/tokens.ts';
import { verifyTurnstile } from '../auth/turnstile.ts';
import { PREMINT_BUFFER_TARGET } from '../do/PlayerDO.ts';
import {
  API_ORIGIN,
  guestSignIn,
  newDevice,
  newIdempotencyKey,
  newSession,
  send,
  type Session,
} from '../test/client.ts';
import { expectError, state, vaultCoins } from '../test/game.ts';

const AUTH_SECRET = authSecret(env.AUTH_SECRET);

function startingCoins(): number {
  const line = upgradeLines.find((candidate) => candidate.effect.stat === 'startingCoins');
  if (line === undefined) throw new Error('No startingCoins line in economy config.');
  return upgradeStat(line, 0);
}

function refresh(
  session: Session,
  refreshToken: string,
  options: { idempotencyKey?: ReturnType<typeof newIdempotencyKey> } = {},
) {
  return send(session.device, endpoints.authRefresh.path, {
    body: { refreshToken },
    ...options,
  });
}

describe('POST /v1/auth/guest', () => {
  it("creates a player funded only by the starting grant, on the house's opening heap", async () => {
    const session = await newSession();
    expect(PlayerIdSchema.safeParse(session.tokens.playerId).success).toBe(true);
    expect(session.tokens.accessTokenTtlMs).toBe(ACCESS_TOKEN_TTL_MS);
    expect(session.tokens.refreshToken).toMatch(/^rt_[A-Za-z0-9_-]{43}$/);

    const snapshot = await state(session);
    const buffered = Math.min(PREMINT_BUFFER_TARGET, startingCoins() / coinTiers[0].value);
    expect(snapshot.table.buffer).toHaveLength(buffered);
    expect(snapshot.wallet.coins).toBe(startingCoins() - buffered * coinTiers[0].value);
    expect(await vaultCoins(session)).toBe(startingCoins());
    expect(snapshot.table.coins).toHaveLength(openingHeap.coins);
    expect(snapshot.player.displayName).toMatch(/^[0-9A-Z]{4}$/);
    expect(snapshot.fair.serverSeedHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('signs the same device back into the same player without a second starting grant', async () => {
    const session = await newSession();
    await expect(state(session)).resolves.toBeDefined();
    const again = await guestSignIn(session.device);
    expect(again.status).toBe(200);
    const tokens = endpoints.authGuest.response.parse(await again.json());
    expect(tokens.playerId).toBe(session.tokens.playerId);
    expect(tokens.refreshToken).not.toBe(session.tokens.refreshToken);

    await state({ ...session, tokens });
    expect(await vaultCoins(session)).toBe(startingCoins());
  });

  it('rejects a replay of a captured, validly signed sign-in request', async () => {
    const device = await newDevice();
    const idempotencyKey = newIdempotencyKey();
    expect((await guestSignIn(device, { idempotencyKey })).status).toBe(200);
    await expectError(await guestSignIn(device, { idempotencyKey }), 422, 'idempotency_key_reused');
  });

  it('rejects a sign-in signed by a different key than the one it registers', async () => {
    const device = await newDevice();
    const attacker = await newDevice();
    const response = await send(device, endpoints.authGuest.path, {
      body: { devicePublicKey: device.publicKey, turnstileToken: 't', locale: 'en' },
      signWith: attacker.privateKey,
    });
    await expectError(response, 401, 'invalid_signature');
  });

  it('rejects a sign-in without a signature or with a malformed one', async () => {
    const device = await newDevice();
    const body = { devicePublicKey: device.publicKey, turnstileToken: 't', locale: 'en' };
    await expectError(
      await send(device, endpoints.authGuest.path, { body, signature: null }),
      401,
      'invalid_signature',
    );
    await expectError(
      await send(device, endpoints.authGuest.path, { body, signature: 'not-a-signature' }),
      401,
      'invalid_signature',
    );
  });

  it('rejects a JWK that smuggles in a private scalar or an off-curve point', async () => {
    const device = await newDevice();
    const withPrivate = await send(device, endpoints.authGuest.path, {
      body: {
        devicePublicKey: { ...device.publicKey, d: device.publicKey.x },
        turnstileToken: 't',
        locale: 'en',
      },
    });
    await expectError(withPrivate, 400, 'validation_failed');

    const offCurve = await send(device, endpoints.authGuest.path, {
      body: {
        devicePublicKey: { ...device.publicKey, y: device.publicKey.x },
        turnstileToken: 't',
        locale: 'en',
      },
    });
    await expectError(offCurve, 401, 'invalid_signature');
  });

  it('requires an Idempotency-Key that is a UUID', async () => {
    const device = await newDevice();
    const body = { devicePublicKey: device.publicKey, turnstileToken: 't', locale: 'en' };
    await expectError(
      await send(device, endpoints.authGuest.path, { body, idempotencyKey: null }),
      400,
      'idempotency_key_missing',
    );
  });

  it('rejects malformed JSON and oversized bodies', async () => {
    const device = await newDevice();
    await expectError(
      await send(device, endpoints.authGuest.path, { body: '{"devicePublicKey":' }),
      400,
      'bad_request',
    );
    await expectError(
      await send(device, endpoints.authGuest.path, { body: 'x'.repeat(65 * 1024) }),
      413,
      'payload_too_large',
    );
  });

  it('stops reading a chunked body with no Content-Length once it passes the limit', async () => {
    let pulled = 0;
    const chunk = new Uint8Array(16 * 1024).fill(0x78);
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(chunk);
      },
    });
    const response = await exports.default.fetch(
      new Request(`${API_ORIGIN}${endpoints.authGuest.path}`, {
        method: 'POST',
        headers: { [HEADERS.idempotencyKey]: newIdempotencyKey() },
        body: endless,
      }),
    );
    await expectError(response, 413, 'payload_too_large');
    expect(pulled).toBeLessThan(16);
  });
});

describe('bearer authentication', () => {
  it('rejects requests with no, malformed or foreign-secret access tokens', async () => {
    const session = await newSession();
    await expectError(await send(session.device, endpoints.state.path), 401, 'unauthorized');
    await expectError(
      await send(session.device, endpoints.state.path, { accessToken: 'a.b.c' }),
      401,
      'unauthorized',
    );
    const forged = await sign(
      {
        iss: 'coinposh',
        typ: 'access',
        sub: session.tokens.playerId,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 600,
        cnf: { jwk: session.device.publicKey },
      },
      'an-attacker-chosen-secret-that-is-long-enough',
      'HS256',
    );
    await expectError(
      await send(session.device, endpoints.state.path, { accessToken: forged }),
      401,
      'unauthorized',
    );
  });

  it('judges expiry by server time, whatever clock the client claims', async () => {
    const session = await newSession();
    const grant = { playerId: session.tokens.playerId, deviceKey: session.device.publicKey };
    const stale = await issueAccessToken(
      AUTH_SECRET,
      grant,
      Date.now() - ACCESS_TOKEN_TTL_MS - 1000,
    );
    const response = await exports.default.fetch(
      new Request(`${API_ORIGIN}${endpoints.state.path}`, {
        headers: { [HEADERS.authorization]: `Bearer ${stale}`, Date: new Date(0).toUTCString() },
      }),
    );
    await expectError(response, 401, 'token_expired');
  });

  it('binds the token to its device key: a stolen token is useless without it', async () => {
    const victim = await newSession();
    const thief = await newDevice();
    const response = await send(thief, endpoints.state.path, {
      accessToken: victim.tokens.accessToken,
    });
    await expectError(response, 401, 'invalid_signature');
  });

  it('rejects a signature made for a different path, body or idempotency key', async () => {
    const session = await newSession();
    const body = { x: 0, tick: 1 };
    await expectError(
      await session.call(endpoints.tableDrop.path, { body, signPath: endpoints.tableClaims.path }),
      401,
      'invalid_signature',
    );
    await expectError(
      await session.call(endpoints.tableDrop.path, {
        body,
        signBody: JSON.stringify({ x: 0, tick: 2 }),
      }),
      401,
      'invalid_signature',
    );
    await expectError(
      await session.call(`${endpoints.state.path}?x=1`, { signPath: endpoints.state.path }),
      401,
      'invalid_signature',
    );
  });
});

describe('POST /v1/auth/refresh', () => {
  it('rotates the refresh token and issues a working access token', async () => {
    const session = await newSession();
    const response = await refresh(session, session.tokens.refreshToken);
    expect(response.status).toBe(200);
    const tokens = endpoints.authRefresh.response.parse(await response.json());
    expect(tokens.playerId).toBe(session.tokens.playerId);
    expect(tokens.refreshToken).not.toBe(session.tokens.refreshToken);
    await expect(state({ ...session, tokens })).resolves.toMatchObject({
      player: { id: session.tokens.playerId },
    });
  });

  it('revokes the whole family when a rotated token is presented again', async () => {
    const session = await newSession();
    const first = await refresh(session, session.tokens.refreshToken);
    const rotated = endpoints.authRefresh.response.parse(await first.json());

    await expectError(await refresh(session, session.tokens.refreshToken), 401, 'unauthorized');
    await expectError(await refresh(session, rotated.refreshToken), 401, 'unauthorized');
  });

  it('refuses a refresh token used from another device', async () => {
    const session = await newSession();
    const thief = await newDevice();
    const response = await send(thief, endpoints.authRefresh.path, {
      body: { refreshToken: session.tokens.refreshToken },
    });
    await expectError(response, 401, 'invalid_signature');
    expect((await refresh(session, session.tokens.refreshToken)).status).toBe(200);
  });

  it('refuses unknown refresh tokens and replayed refresh requests', async () => {
    const session = await newSession();
    await expectError(await refresh(session, `rt_${'A'.repeat(43)}`), 401, 'unauthorized');

    const idempotencyKey = newIdempotencyKey();
    const fresh = await newSession();
    expect((await refresh(fresh, fresh.tokens.refreshToken, { idempotencyKey })).status).toBe(200);
    await expectError(
      await refresh(fresh, fresh.tokens.refreshToken, { idempotencyKey }),
      422,
      'idempotency_key_reused',
    );
  });
});

describe('Turnstile', () => {
  const verify = (mode: string | undefined, secret: string | undefined) =>
    verifyTurnstile(mode, secret, 'token', undefined, newIdempotencyKey());

  it('fails closed when the secret is missing unless the mode is explicitly off', async () => {
    for (const mode of [undefined, 'enforce']) {
      for (const secret of [undefined, '']) {
        const attempt = verify(mode, secret);
        await expect(attempt).rejects.toMatchObject({ code: 'unavailable' });
        await expect(attempt).rejects.toThrow(/wrangler secret put TURNSTILE_SECRET_KEY/);
      }
    }
    await expect(verify('off', undefined)).resolves.toBeUndefined();
  });

  it('refuses an unknown mode instead of guessing', async () => {
    for (const mode of ['', 'OFF', 'disabled']) {
      await expect(verify(mode, 'secret')).rejects.toMatchObject({ code: 'unavailable' });
    }
  });
});

describe('AUTH_SECRET', () => {
  it('fails loudly with setup instructions when missing or too short', () => {
    expect(() => authSecret(undefined)).toThrow(/wrangler secret put AUTH_SECRET/);
    expect(() => authSecret('short')).toThrow(/at least 32 characters/);
  });
});
