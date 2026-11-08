import {
  endpoints,
  ErrorEnvelopeSchema,
  HEADERS,
  type FairRotateRequest,
  type IdempotencyKey,
} from '@coinposh/shared';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { describe, expect, it } from 'vitest';
import type { Command, PlayerDO } from '../do/PlayerDO.ts';
import type { AppEnv } from '../http/context.ts';
import { ApiFailure } from '../http/errors.ts';
import {
  API_ORIGIN,
  newIdempotencyKey,
  newSession,
  signParts,
  type Session,
} from '../test/client.ts';
import { expectError } from '../test/game.ts';
import { FairSeeds, MIN_ROTATION_INTERVAL_MS, verifyRevealedSeed } from './fair.ts';
import { fairRoutes, type FairSeedHostResolver } from './routes.ts';

/**
 * Stands in for the PlayerDO methods the integrator adds: each call runs FairSeeds on
 * the signed-in player's own Durable Object storage, inside one storage transaction.
 * The first seed is committed one throttle interval back, as for a player who signed up
 * earlier, so a test's first rotation is allowed.
 */
const rotations: Command<FairRotateRequest>[] = [];

const resolveHost: FairSeedHostResolver = (workerEnv, playerId) => {
  const stub = workerEnv.PLAYER.get(workerEnv.PLAYER.idFromName(playerId));
  const withFair = <T>(run: (fair: FairSeeds) => T) =>
    runInDurableObject(stub, (_instance: PlayerDO, ctx) =>
      ctx.storage.transactionSync(() => {
        const fair = new FairSeeds(ctx.storage.sql);
        fair.open(Date.now() - MIN_ROTATION_INTERVAL_MS);
        return run(fair);
      }),
    );
  return {
    fairSeeds: async () => ({ ok: true, replayed: false, body: await withFair((f) => f.seeds()) }),
    fairRotate: async (command) => {
      rotations.push(command);
      try {
        const body = await withFair((fair) =>
          fair.rotate(command.body, { at: Date.now(), idempotencyKey: command.idempotencyKey }),
        );
        return { ok: true, replayed: false, body };
      } catch (error) {
        if (!(error instanceof ApiFailure)) throw error;
        return { ok: false, error: { ...error.extra, code: error.code, message: error.message } };
      }
    },
  };
};

const app = new Hono<AppEnv>();
app.use(async (c, next) => {
  c.set('requestId', 'fair-test');
  await next();
});
app.route('/', fairRoutes(resolveHost));
app.onError((error, c) => {
  if (!(error instanceof ApiFailure)) throw error;
  return c.json(error.envelope('fair-test'), error.status as ContentfulStatusCode);
});

interface CallOptions {
  readonly body?: unknown;
  readonly idempotencyKey?: IdempotencyKey | null;
  readonly accessToken?: string | null;
  readonly signBody?: string;
}

async function call(session: Session, path: string, options: CallOptions = {}) {
  const method = options.body === undefined ? 'GET' : 'POST';
  const rawBody =
    options.body === undefined
      ? ''
      : typeof options.body === 'string'
        ? options.body
        : JSON.stringify(options.body);
  const idempotencyKey =
    options.idempotencyKey === undefined
      ? method === 'POST'
        ? newIdempotencyKey()
        : null
      : options.idempotencyKey;
  const headers = new Headers();
  const accessToken =
    options.accessToken === undefined ? session.tokens.accessToken : options.accessToken;
  if (accessToken !== null) headers.set(HEADERS.authorization, `Bearer ${accessToken}`);
  if (idempotencyKey !== null) headers.set(HEADERS.idempotencyKey, idempotencyKey);
  if (rawBody !== '') headers.set('Content-Type', 'application/json');
  headers.set(
    HEADERS.deviceSignature,
    await signParts(
      session.device.privateKey,
      method,
      path,
      idempotencyKey,
      options.signBody ?? rawBody,
    ),
  );
  return app.fetch(
    new Request(`${API_ORIGIN}${path}`, {
      method,
      headers,
      ...(method === 'POST' ? { body: rawBody } : {}),
    }),
    env,
  );
}

async function seeds(session: Session) {
  const response = await call(session, endpoints.fairSeeds.path);
  expect(response.status, await response.clone().text()).toBe(200);
  return endpoints.fairSeeds.response.parse(await response.json());
}

describe('GET /v1/fair/seeds', () => {
  it('shows the commitment and no secret', async () => {
    const session = await newSession();
    const view = await seeds(session);
    expect(view.active.nonce).toBe(0);
    expect(view.revealed).toEqual([]);
    expect(await seeds(session)).toEqual(view);
  });

  it('refuses anyone without a valid access token', async () => {
    const session = await newSession();
    await expectError(
      await call(session, endpoints.fairSeeds.path, { accessToken: null }),
      401,
      'unauthorized',
    );
    await expectError(
      await call(session, endpoints.fairSeeds.path, { accessToken: 'forged.token.value' }),
      401,
      'unauthorized',
    );
  });
});

describe('POST /v1/fair/rotate', () => {
  it('reveals the committed seed and commits a new one with the chosen client seed', async () => {
    const session = await newSession();
    const before = await seeds(session);
    const response = await call(session, endpoints.fairRotate.path, {
      body: { clientSeed: 'velvet-rope' },
    });
    expect(response.status).toBe(200);
    const rotation = endpoints.fairRotate.response.parse(await response.json());
    expect(rotation.revealed.serverSeedHash).toBe(before.active.serverSeedHash);
    expect(verifyRevealedSeed(rotation.revealed)).toBe(true);
    expect(rotation.active.clientSeed).toBe('velvet-rope');
    expect(rotation.active.serverSeedHash).not.toBe(before.active.serverSeedHash);
    expect(await seeds(session)).toEqual({
      active: rotation.active,
      revealed: [rotation.revealed],
    });
  });

  it('hands the Durable Object a fingerprint of the exact signed request', async () => {
    const session = await newSession();
    const idempotencyKey = newIdempotencyKey();
    await call(session, endpoints.fairRotate.path, { body: {}, idempotencyKey });
    expect(rotations.at(-1)).toMatchObject({
      idempotencyKey,
      fingerprint: expect.stringMatching(/^POST \/v1\/fair\/rotate [0-9a-f]{64}$/) as string,
      body: {},
    });
  });

  it('rotates once for a replayed request', async () => {
    const session = await newSession();
    const idempotencyKey = newIdempotencyKey();
    const first = await call(session, endpoints.fairRotate.path, { body: {}, idempotencyKey });
    const replay = await call(session, endpoints.fairRotate.path, { body: {}, idempotencyKey });
    expect(await replay.json()).toEqual(await first.json());
    expect((await seeds(session)).revealed).toHaveLength(1);
  });

  it('throttles back-to-back rotations with fresh keys and reports the wait', async () => {
    const session = await newSession();
    const first = await call(session, endpoints.fairRotate.path, { body: {} });
    expect(first.status).toBe(200);
    const afterFirst = await seeds(session);
    for (let i = 0; i < 5; i++) {
      const refused = await call(session, endpoints.fairRotate.path, { body: {} });
      expect(refused.status).toBe(429);
      const { error } = ErrorEnvelopeSchema.parse(await refused.json());
      expect(error.code).toBe('rate_limited');
      const retryAfterMs = error.retryAfterMs ?? 0;
      expect(retryAfterMs).toBeGreaterThan(0);
      expect(retryAfterMs).toBeLessThanOrEqual(MIN_ROTATION_INTERVAL_MS);
    }
    expect(await seeds(session)).toEqual(afterFirst);
  });

  it('refuses a rotation without an Idempotency-Key', async () => {
    const session = await newSession();
    await expectError(
      await call(session, endpoints.fairRotate.path, { body: {}, idempotencyKey: null }),
      400,
      'idempotency_key_missing',
    );
    expect((await seeds(session)).revealed).toEqual([]);
  });

  it('refuses forged server seeds, nonces and malformed client seeds without rotating', async () => {
    const session = await newSession();
    const before = await seeds(session);
    for (const forged of [
      { serverSeed: 'ab'.repeat(32) },
      { serverSeedHash: before.active.serverSeedHash },
      { nonce: 0 },
      { clientSeed: '' },
      { clientSeed: 'x'.repeat(65) },
      { clientSeed: 'has space' },
      { clientSeed: 42 },
    ]) {
      await expectError(
        await call(session, endpoints.fairRotate.path, { body: forged }),
        400,
        'validation_failed',
      );
    }
    await expectError(
      await call(session, endpoints.fairRotate.path, { body: 'not json' }),
      400,
      'bad_request',
    );
    expect(await seeds(session)).toEqual(before);
  });

  it('refuses a body that differs from the one the device signed', async () => {
    const session = await newSession();
    await expectError(
      await call(session, endpoints.fairRotate.path, {
        body: { clientSeed: 'tampered' },
        signBody: JSON.stringify({ clientSeed: 'original' }),
      }),
      401,
      'invalid_signature',
    );
    expect((await seeds(session)).revealed).toEqual([]);
  });
});
