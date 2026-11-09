import { accountEndpoints, HEADERS, type ProgressChoice } from '@coinposh/shared';
import { Hono } from 'hono';
import { deviceKeyThumbprint } from '../auth/device.ts';
import { nonceMatches, verifyIdToken, type VerifiedIdToken } from '../auth/link/idToken.ts';
import type { JwksCache } from '../auth/link/jwks.ts';
import { assertNonceEnvelope, clientKey, issueNonce, spendNonce } from '../auth/link/nonces.ts';
import { requireProvider, type ReadyProvider } from '../auth/link/providers.ts';
import {
  admitDevice,
  burnAuthKey,
  deviceGuest,
  identityOwner,
  isLinked,
  linkIdentity,
  readAccount,
  readSave,
  unlinkIdentity,
} from '../auth/link/store.ts';
import { authSecret, tokenBundle, verifyAccessToken } from '../auth/tokens.ts';
import type { AppContext, AppEnv } from '../http/context.ts';
import { IDEMPOTENT_REPLAYED_HEADER } from '../http/cors.ts';
import { ApiFailure } from '../http/errors.ts';
import {
  authenticate,
  fingerprint,
  parseBody,
  readSignedRequest,
  requireIdempotencyKey,
  verifySigned,
} from '../http/signed.ts';

export interface AccountRouteDeps {
  readonly jwks: JwksCache;
}

async function verifiedFor(
  provider: ReadyProvider,
  idToken: string,
  nonce: string,
  deps: AccountRouteDeps,
  now: number,
): Promise<VerifiedIdToken> {
  const token = await verifyIdToken(idToken, provider, deps.jwks, now);
  if (!(await nonceMatches(provider, token, nonce))) {
    throw new ApiFailure(
      'invalid_id_token',
      `This ${provider.config.label} sign-in was not made for the nonce sent with it. Start the sign-in again.`,
    );
  }
  return token;
}

/**
 * A link nonce is only useful to a session that can then call link, so only such a session
 * may ask for one: the bearer token must belong to the same key that signed the request.
 */
async function requireSessionOf(c: AppContext, deviceJkt: string): Promise<void> {
  const grant = await verifyAccessToken(
    authSecret(c.env.AUTH_SECRET),
    c.req.header(HEADERS.authorization),
    Date.now(),
  );
  if ((await deviceKeyThumbprint(grant.deviceKey)) !== deviceJkt) {
    throw new ApiFailure(
      'unauthorized',
      'This access token belongs to another device key. Sign the request with the key it was issued to.',
    );
  }
}

/**
 * Google and Apple linking. Nothing here reads a balance or a reward from the client: a link
 * only maps a verified provider subject to a save, and a sign-in only hands this device a
 * session on the save that subject already keeps. Saves are never merged.
 */
export function createAccountRoutes(deps: AccountRouteDeps) {
  const routes = new Hono<AppEnv>();
  const endpoints = accountEndpoints;

  routes.post(endpoints.accountNonce.path, async (c) => {
    const request = await readSignedRequest(c);
    const idempotencyKey = requireIdempotencyKey(request);
    const body = parseBody(endpoints.accountNonce.body, request.rawBody);
    await verifySigned(c, request, body.devicePublicKey);
    requireProvider(c.env, body.provider);
    const deviceJkt = await deviceKeyThumbprint(body.devicePublicKey);
    if (body.purpose === 'link') await requireSessionOf(c, deviceJkt);
    const now = Date.now();
    const requester = {
      deviceJkt,
      clientKey: await clientKey(authSecret(c.env.AUTH_SECRET), c.req.header('CF-Connecting-IP')),
      now,
    };
    await assertNonceEnvelope(c.env.DB, requester);
    await burnAuthKey(c.env.DB, idempotencyKey, endpoints.accountNonce.path, now);
    const issued = await issueNonce(c.env.DB, {
      ...requester,
      provider: body.provider,
      purpose: body.purpose,
    });
    return c.json(endpoints.accountNonce.response.parse(issued));
  });

  routes.post(endpoints.accountLink.path, async (c) => {
    const request = await authenticate(c);
    const idempotencyKey = requireIdempotencyKey(request);
    const body = parseBody(endpoints.accountLink.body, request.rawBody);
    const provider = requireProvider(c.env, body.provider);
    const now = Date.now();
    const token = await verifiedFor(provider, body.idToken, body.nonce, deps, now);
    const playerId = request.grant.playerId;
    const deviceJkt = await deviceKeyThumbprint(request.grant.deviceKey);
    const spent = await spendNonce(c.env.DB, {
      nonce: body.nonce,
      provider: body.provider,
      purpose: 'link',
      deviceJkt,
      now,
      idempotencyKey,
      fingerprint: fingerprint(request),
      playerId,
    });
    await linkIdentity(c.env.DB, {
      playerId,
      provider: body.provider,
      label: provider.config.label,
      subject: token.subject,
      emailHint: token.emailHint,
      deviceJkt,
      now,
    });
    if (spent === 'replay') c.header(IDEMPOTENT_REPLAYED_HEADER, 'true');
    return c.json(endpoints.accountLink.response.parse(await readAccount(c.env, playerId)));
  });

  routes.post(endpoints.authSignIn.path, async (c) => {
    const secret = authSecret(c.env.AUTH_SECRET);
    const request = await readSignedRequest(c);
    const idempotencyKey = requireIdempotencyKey(request);
    const body = parseBody(endpoints.authSignIn.body, request.rawBody);
    await verifySigned(c, request, body.devicePublicKey);
    const provider = requireProvider(c.env, body.provider);
    const now = Date.now();
    await burnAuthKey(c.env.DB, idempotencyKey, endpoints.authSignIn.path, now);
    const token = await verifiedFor(provider, body.idToken, body.nonce, deps, now);
    const deviceJkt = await deviceKeyThumbprint(body.devicePublicKey);
    await spendNonce(c.env.DB, {
      nonce: body.nonce,
      provider: body.provider,
      purpose: 'signin',
      deviceJkt,
      now,
      idempotencyKey,
      fingerprint: fingerprint(request),
      playerId: null,
    });

    const playerId = await identityOwner(c.env.DB, body.provider, token.subject);
    if (playerId === null) {
      throw new ApiFailure(
        'not_found',
        `No CoinPosh save is linked to this ${provider.config.label} account yet. Play as a guest and link it from Settings to keep your progress.`,
      );
    }
    const guest = await deviceGuest(c.env.DB, deviceJkt);
    let choice: ProgressChoice | undefined;
    if (guest !== null && guest !== playerId && !(await isLinked(c.env.DB, guest))) {
      const guestSave = await readSave(c.env, guest);
      if (guestSave.hasProgress) {
        choice = { guest: guestSave.summary, account: (await readSave(c.env, playerId)).summary };
      }
    }
    const refreshToken = await admitDevice(c.env.DB, {
      playerId,
      provider: body.provider,
      deviceKey: body.devicePublicKey,
      deviceJkt,
      firstDevice: guest === playerId,
      now,
    });
    const tokens = await tokenBundle(
      secret,
      { playerId, deviceKey: body.devicePublicKey },
      refreshToken,
      now,
    );
    return c.json(
      endpoints.authSignIn.response.parse({
        ...tokens,
        account: await readAccount(c.env, playerId),
        ...(choice === undefined ? {} : { choice }),
      }),
    );
  });

  routes.post(endpoints.accountUnlink.path, async (c) => {
    const request = await authenticate(c);
    const body = parseBody(endpoints.accountUnlink.body, request.rawBody);
    const playerId = request.grant.playerId;
    await unlinkIdentity(c.env.DB, {
      playerId,
      provider: body.provider,
      deviceJkt: await deviceKeyThumbprint(request.grant.deviceKey),
      now: Date.now(),
    });
    return c.json(endpoints.accountUnlink.response.parse(await readAccount(c.env, playerId)));
  });

  routes.get(endpoints.account.path, async (c) => {
    const request = await authenticate(c);
    return c.json(
      endpoints.account.response.parse(await readAccount(c.env, request.grant.playerId)),
    );
  });

  return routes;
}
