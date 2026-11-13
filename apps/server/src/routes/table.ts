import { endpoints, tableSnapshotEndpoint, type PlayerId } from '@coinposh/shared';
import { Hono } from 'hono';
import type { Env } from '../env.ts';
import type { AppEnv } from '../http/context.ts';
import {
  authenticate,
  fingerprint,
  parseBody,
  parseQuery,
  requireIdempotencyKey,
  respond,
} from '../http/signed.ts';

export const tableRoutes = new Hono<AppEnv>();

export function playerStub(env: Env, playerId: PlayerId) {
  return env.PLAYER.get(env.PLAYER.idFromName(playerId));
}

tableRoutes.get(endpoints.state.path, async (c) => {
  const { grant } = await authenticate(c);
  const query = parseQuery(endpoints.state.query, c);
  const result = await playerStub(c.env, grant.playerId).state(query);
  return respond(c, endpoints.state.response, result);
});

tableRoutes.post(endpoints.tableDrop.path, async (c) => {
  const request = await authenticate(c);
  const body = parseBody(endpoints.tableDrop.body, request.rawBody);
  const result = await playerStub(c.env, request.grant.playerId).drop({
    idempotencyKey: requireIdempotencyKey(request),
    fingerprint: fingerprint(request),
    body,
  });
  return respond(c, endpoints.tableDrop.response, result);
});

tableRoutes.post(tableSnapshotEndpoint.path, async (c) => {
  const request = await authenticate(c);
  const body = parseBody(tableSnapshotEndpoint.body, request.rawBody);
  const result = await playerStub(c.env, request.grant.playerId).tableSnapshot({
    idempotencyKey: requireIdempotencyKey(request),
    fingerprint: fingerprint(request),
    body,
  });
  return respond(c, tableSnapshotEndpoint.response, result);
});

tableRoutes.post(endpoints.tableClaims.path, async (c) => {
  const request = await authenticate(c);
  const body = parseBody(endpoints.tableClaims.body, request.rawBody);
  const result = await playerStub(c.env, request.grant.playerId).claims({
    idempotencyKey: requireIdempotencyKey(request),
    fingerprint: fingerprint(request),
    body,
  });
  return respond(c, endpoints.tableClaims.response, result);
});
