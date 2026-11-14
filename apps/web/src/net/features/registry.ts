import { ENDPOINT_NAMES, type EndpointName } from '@coinposh/shared';
import { FeatureIdSchema } from '../mock/persist.ts';
import type { MockFeature, MockFeatureHandler } from './types.ts';

/**
 * The Demo feature modules the mock server routes to. A theme's Demo task adds its
 * `apps/web/src/net/features/<theme>/` module here; the order does not matter, since no two
 * features may handle one endpoint.
 */
export const MOCK_FEATURES: readonly MockFeature[] = [];

/** Endpoints that run before a player exists, so no feature can stand behind them. */
const SESSION_ENDPOINTS: ReadonlySet<EndpointName> = new Set(['authGuest', 'authRefresh']);

const KNOWN_ENDPOINTS: ReadonlySet<string> = new Set(ENDPOINT_NAMES);

export interface FeatureRoute {
  readonly feature: MockFeature;
  readonly handler: MockFeatureHandler<EndpointName>;
}

/**
 * Indexes each endpoint to the one feature that handles it. Throws while the mock server is
 * created when two features share an id or an endpoint, or a feature claims one it cannot, so a
 * clash fails every test and Demo boot instead of one handler silently shadowing another.
 */
export function featureRoutes(
  features: readonly MockFeature[],
): ReadonlyMap<EndpointName, FeatureRoute> {
  const routes = new Map<EndpointName, FeatureRoute>();
  const ids = new Set<string>();
  for (const feature of features) {
    if (!FeatureIdSchema.safeParse(feature.id).success) {
      throw new Error(
        `Mock feature "${feature.id}" has an invalid id; use lowercase letters, digits, ".", "_" or "-", starting with a letter.`,
      );
    }
    if (ids.has(feature.id)) {
      throw new Error(
        `Mock feature "${feature.id}" is registered twice; register each feature module once.`,
      );
    }
    ids.add(feature.id);
    for (const [name, handler] of Object.entries(feature.handlers)) {
      if (!KNOWN_ENDPOINTS.has(name)) {
        throw new Error(
          `Mock feature "${feature.id}" handles "${name}", which is not in the endpoint registry; add it to @coinposh/shared first.`,
        );
      }
      const endpoint = name as EndpointName;
      if (SESSION_ENDPOINTS.has(endpoint)) {
        throw new Error(
          `Mock feature "${feature.id}" cannot handle "${endpoint}": it runs before a player exists.`,
        );
      }
      const holder = routes.get(endpoint);
      if (holder !== undefined) {
        throw new Error(
          `Mock features "${holder.feature.id}" and "${feature.id}" both handle "${endpoint}"; one endpoint belongs to one feature.`,
        );
      }
      routes.set(endpoint, { feature, handler });
    }
  }
  return routes;
}
