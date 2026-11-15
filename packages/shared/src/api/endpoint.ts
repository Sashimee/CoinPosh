import type { z } from 'zod';

export type HttpMethod = 'GET' | 'POST';

/**
 * `none` endpoints carry no bearer access token but are still device-signed: the verifying key
 * travels in the body (`devicePublicKey`) or is looked up from the refresh-token row.
 */
export type AuthMode = 'none' | 'bearer';

export interface Endpoint<
  M extends HttpMethod = HttpMethod,
  P extends string = string,
  B extends z.ZodType | null = z.ZodType | null,
  Q extends z.ZodType | null = z.ZodType | null,
  R extends z.ZodType = z.ZodType,
> {
  readonly method: M;
  readonly path: P;
  readonly auth: AuthMode;
  /** JSON request body; `null` for GET. Every body schema is strict: unknown keys are rejected. */
  readonly body: B;
  /** Path parameters (`:name` segments); `null` when the path has none. */
  readonly params: Q;
  /** Query string fields, each a string on the wire; absent when the endpoint takes none. */
  readonly query?: z.ZodType;
  readonly response: R;
}

export type EndpointMap = Readonly<Record<string, Endpoint>>;

export function get<const P extends string, R extends z.ZodType>(
  path: P,
  response: R,
): Endpoint<'GET', P, null, null, R> {
  return { method: 'GET', path, auth: 'bearer', body: null, params: null, response };
}

export function getWithParams<const P extends string, Q extends z.ZodType, R extends z.ZodType>(
  path: P,
  params: Q,
  response: R,
): Endpoint<'GET', P, null, Q, R> {
  return { method: 'GET', path, auth: 'bearer', body: null, params, response };
}

export function post<const P extends string, B extends z.ZodType, R extends z.ZodType>(
  path: P,
  body: B,
  response: R,
  auth: AuthMode = 'bearer',
): Endpoint<'POST', P, B, null, R> {
  return { method: 'POST', path, auth, body, params: null, response };
}

type Merged<Maps extends readonly EndpointMap[]> = Maps extends readonly [
  infer Head,
  ...infer Tail extends readonly EndpointMap[],
]
  ? Head & Merged<Tail>
  : unknown;

export type ComposedEndpoints<Maps extends readonly EndpointMap[]> = {
  readonly [K in keyof Merged<Maps>]: Merged<Maps>[K];
};

/**
 * Merges the core map with each theme's map into one registry, keeping every endpoint's literal
 * type. Throws while the module loads if two endpoints share a name or a method and path, so a
 * clash between themes fails every test and boot instead of one route silently shadowing another.
 */
export function composeEndpoints<const Maps extends readonly EndpointMap[]>(
  ...maps: Maps
): ComposedEndpoints<Maps> {
  const composed: Record<string, Endpoint> = {};
  const nameByRoute = new Map<string, string>();
  for (const map of maps) {
    for (const [name, endpoint] of Object.entries(map)) {
      if (Object.hasOwn(composed, name)) {
        const first = composed[name];
        throw new Error(
          `composeEndpoints: endpoint name "${name}" is registered twice ` +
            `(${first?.method} ${first?.path} and ${endpoint.method} ${endpoint.path}); ` +
            `rename one, prefixed with its theme.`,
        );
      }
      const route = `${endpoint.method} ${endpoint.path}`;
      const holder = nameByRoute.get(route);
      if (holder !== undefined) {
        throw new Error(
          `composeEndpoints: "${holder}" and "${name}" both register ${route}; ` +
            `move one under its own /v1/<theme>/ path.`,
        );
      }
      composed[name] = endpoint;
      nameByRoute.set(route, name);
    }
  }
  return composed as ComposedEndpoints<Maps>;
}
