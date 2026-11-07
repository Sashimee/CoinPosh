import {
  endpoints,
  type FairRotateRequest,
  type FairRotateResponse,
  type FairSeedsResponse,
  type PlayerId,
} from '@coinposh/shared';
import { Hono } from 'hono';
import type { Command, DoResult } from '../do/PlayerDO.ts';
import type { Env } from '../env.ts';
import type { AppEnv } from '../http/context.ts';
import {
  authenticate,
  fingerprint,
  parseBody,
  requireIdempotencyKey,
  respond,
} from '../http/signed.ts';

/** What the fair routes need from a player's Durable Object. */
export interface FairSeedHost {
  fairSeeds(): Promise<DoResult<FairSeedsResponse>>;
  fairRotate(command: Command<FairRotateRequest>): Promise<DoResult<FairRotateResponse>>;
}

export type FairSeedHostResolver = (env: Env, playerId: PlayerId) => FairSeedHost;

/** `GET /v1/fair/seeds` and `POST /v1/fair/rotate`, both device-signed and bearer-authenticated. */
export function fairRoutes(resolve: FairSeedHostResolver): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get(endpoints.fairSeeds.path, async (c) => {
    const { grant } = await authenticate(c);
    const result = await resolve(c.env, grant.playerId).fairSeeds();
    return respond(c, endpoints.fairSeeds.response, result);
  });

  routes.post(endpoints.fairRotate.path, async (c) => {
    const request = await authenticate(c);
    const body = parseBody(endpoints.fairRotate.body, request.rawBody);
    const result = await resolve(c.env, request.grant.playerId).fairRotate({
      idempotencyKey: requireIdempotencyKey(request),
      fingerprint: fingerprint(request),
      body,
    });
    return respond(c, endpoints.fairRotate.response, result);
  });

  return routes;
}
