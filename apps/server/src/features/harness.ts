import type { Endpoint, EndpointMap, PlayerId } from '@coinposh/shared';
import { env } from 'cloudflare:workers';
import type { z } from 'zod';
import { registerServerFeatures } from '../do/features.ts';
import { createApp } from '../index.ts';
import { newSession, type SendOptions, type Session } from '../test/client.ts';
import { playerStub } from '../test/game.ts';
import type { ServerFeature } from './types.ts';

type UnionToIntersection<U> = (U extends unknown ? (u: U) => void : never) extends (
  i: infer I,
) => void
  ? I
  : never;

type EndpointsOf<F extends readonly ServerFeature[]> = UnionToIntersection<
  F[number] extends ServerFeature<infer E> ? E : never
> &
  EndpointMap;

type Query = Readonly<Record<string, string>>;

/** What `call` takes after the endpoint's name: the body for a POST, path params and query for a GET. */
export type CallArgs<P> =
  P extends Endpoint<'POST', string, infer B extends z.ZodType>
    ? [body: z.input<B>]
    : P extends Endpoint<'GET', string, null, infer Q extends z.ZodType>
      ? [params: z.input<Q>, query?: Query]
      : [query?: Query];

export type ResponseOf<P> =
  P extends Endpoint<infer _M, string, infer _B, infer _Q, infer R> ? z.output<R> : never;

export interface FeaturePlayer<E extends EndpointMap> {
  readonly session: Session;
  readonly playerId: PlayerId;
  readonly stub: ReturnType<typeof playerStub>;
  /** Calls a feature endpoint as the client would and parses the answer; anything but 200 throws. */
  call<K extends keyof E & string>(name: K, ...args: CallArgs<E[K]>): Promise<ResponseOf<E[K]>>;
  /** The raw response for `name`, sending `options` verbatim: for forged bodies and error paths. */
  send(
    name: keyof E & string,
    options?: SendOptions & { readonly params?: Query; readonly query?: Query | undefined },
  ): Promise<Response>;
}

export interface FeatureHarness<E extends EndpointMap> {
  /** The worker under test: every core route plus only these features. */
  readonly fetch: (request: Request) => Promise<Response>;
  /** A fresh guest signed in through that worker, with its own real PlayerDO. */
  player(): Promise<FeaturePlayer<E>>;
}

function fillPath(path: string, params: Query): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined)
      throw new Error(`createFeatureHarness: ${path} needs param "${name}".`);
    return encodeURIComponent(value);
  });
}

function withQuery(path: string, query: Query | undefined): string {
  if (query === undefined || Object.keys(query).length === 0) return path;
  return `${path}?${new URLSearchParams(query).toString()}`;
}

/**
 * Runs `features` against a real PlayerDO in the miniflare test pool: registers them with the
 * PlayerDO (tables, handlers, ledger kinds) and builds a worker mounting only them beside the
 * core routes, so a feature task tests its whole slice without touching SERVER_FEATURES.
 */
export function createFeatureHarness<const F extends readonly ServerFeature[]>(
  features: F,
): FeatureHarness<EndpointsOf<F>> {
  registerServerFeatures(features);
  const app = createApp({
    fetchJwks: () => Promise.reject(new Error('The feature harness serves no ID-token provider.')),
    features,
  });
  const fetch = (request: Request) => Promise.resolve(app.fetch(request, env));
  const endpoints: EndpointMap = Object.fromEntries(
    features.flatMap((feature) => Object.entries(feature.endpoints)),
  );

  const endpoint = (name: string): Endpoint => {
    const found = Object.hasOwn(endpoints, name) ? endpoints[name] : undefined;
    if (found === undefined) throw new Error(`createFeatureHarness: no endpoint named "${name}".`);
    return found;
  };

  return {
    fetch,
    async player() {
      const session = await newSession({ via: fetch });
      const send: FeaturePlayer<EndpointsOf<F>>['send'] = (name, options = {}) => {
        const { params, query, ...rest } = options;
        const target = endpoint(name);
        return session.call(withQuery(fillPath(target.path, params ?? {}), query), {
          method: target.method,
          ...rest,
        });
      };
      return {
        session,
        playerId: session.tokens.playerId,
        stub: playerStub(session.tokens.playerId),
        send,
        async call(name, ...args) {
          const target = endpoint(name);
          const [first, second] = args as readonly unknown[];
          const response =
            target.method === 'POST'
              ? await send(name, { body: first })
              : await send(name, {
                  ...(target.params === null
                    ? { query: first as Query | undefined }
                    : { params: first as Query, query: second as Query | undefined }),
                });
          const text = await response.text();
          if (response.status !== 200) {
            throw new Error(`${target.method} ${target.path} answered ${response.status}: ${text}`);
          }
          return target.response.parse(JSON.parse(text)) as ResponseOf<EndpointsOf<F>[typeof name]>;
        },
      };
    },
  };
}
