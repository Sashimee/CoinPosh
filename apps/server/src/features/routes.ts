import type { EndpointMap } from '@coinposh/shared';
import { Hono, type MiddlewareHandler } from 'hono';
import type { AppContext, AppEnv } from '../http/context.ts';
import { ApiFailure } from '../http/errors.ts';
import {
  authenticate,
  fingerprint,
  type BearerRequest,
  parseBody,
  requireIdempotencyKey,
  respond,
} from '../http/signed.ts';
import { playerStub } from '../routes/table.ts';
import type { FeatureCall, FeatureRouteDeps, ServerFeature } from './types.ts';

const authenticated = new WeakMap<Request, BearerRequest>();

/** Every feature route is device-signed bearer auth, checked before any feature code runs. */
const featureAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  authenticated.set(c.req.raw, await authenticate(c));
  await next();
};

/** The verified request behind a feature route: who is calling, the raw body and its key. */
export function featureRequest(c: AppContext): BearerRequest {
  const request = authenticated.get(c.req.raw);
  if (request === undefined) {
    throw new Error(
      `${c.req.method} ${c.req.path} is not a mounted feature route; it has no auth.`,
    );
  }
  return request;
}

function parseOrFail(
  schema: NonNullable<EndpointMap[string]['params']>,
  value: unknown,
  what: string,
): unknown {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw ApiFailure.validation(parsed.error, `The ${what} does not match the contract.`);
  }
  return parsed.data;
}

function featureRoutes(feature: ServerFeature): Hono<AppEnv> {
  const sub = new Hono<AppEnv>();
  const requireHandler = (handler: string) => {
    if (!Object.hasOwn(feature.doHandlers, handler)) {
      throw new Error(`Feature "${feature.id}" mounts a route on unknown DO handler "${handler}".`);
    }
  };
  const deps: FeatureRouteDeps = {
    dispatch: (c, handler, call: FeatureCall) => {
      requireHandler(handler);
      return playerStub(c.env, featureRequest(c).grant.playerId).feature(feature.id, handler, call);
    },
    mount: (endpoint, handler) => {
      requireHandler(handler);
      if (endpoint.auth !== 'bearer') {
        throw new Error(
          `Feature "${feature.id}" route ${endpoint.method} ${endpoint.path} must use bearer auth.`,
        );
      }
      sub.on(endpoint.method, endpoint.path, async (c) => {
        const request = featureRequest(c);
        const fields = {
          ...(endpoint.params === null
            ? {}
            : (parseOrFail(endpoint.params, c.req.param(), 'path') as object)),
          ...(endpoint.query === undefined
            ? {}
            : (parseOrFail(endpoint.query, c.req.query(), 'query string') as object)),
        };
        const call: FeatureCall =
          endpoint.method === 'POST' && endpoint.body !== null
            ? {
                idempotencyKey: requireIdempotencyKey(request),
                fingerprint: fingerprint(request),
                input: parseBody(endpoint.body, request.rawBody),
              }
            : { idempotencyKey: null, fingerprint: null, input: fields };
        const result = await deps.dispatch(c, handler, call);
        return respond(c, endpoint.response, result);
      });
    },
  };
  feature.routes(sub, deps);
  return sub;
}

/**
 * Mounts each feature's routes behind bearer auth. A feature may only add `/v1/...` routes
 * that no core route or other feature serves, checked here at boot so a clash fails every
 * test instead of one route silently shadowing another.
 */
export function mountServerFeatures(app: Hono<AppEnv>, features: readonly ServerFeature[]): void {
  const taken = new Map<string, string>(
    app.routes
      .filter((route) => route.method !== 'ALL')
      .map((route) => [`${route.method} ${route.path}`, 'core']),
  );
  const authed = new Set<string>();
  for (const feature of features) {
    const sub = featureRoutes(feature);
    const paths: string[] = [];
    for (const route of sub.routes) {
      if (!route.path.startsWith('/v1/') || route.method === 'ALL') {
        throw new Error(
          `Feature "${feature.id}" registered ${route.method} ${route.path}; feature routes are ` +
            `GET or POST under /v1/<theme>/, and auth is added for them.`,
        );
      }
      const key = `${route.method} ${route.path}`;
      const holder = taken.get(key);
      if (holder !== undefined) {
        throw new Error(
          `Feature "${feature.id}" registers ${key}, which ${holder === 'core' ? 'a core route' : `feature "${holder}"`} already serves.`,
        );
      }
      taken.set(key, feature.id);
      if (!authed.has(route.path)) paths.push(route.path);
      authed.add(route.path);
    }
    for (const path of paths) app.use(path, featureAuth);
    app.route('/', sub);
  }
}
