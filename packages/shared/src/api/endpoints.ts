import type { z } from 'zod';
import {
  GuestAuthRequestSchema,
  GuestAuthResponseSchema,
  RefreshRequestSchema,
  RefreshResponseSchema,
} from './auth.ts';
import {
  FairRotateRequestSchema,
  FairRotateResponseSchema,
  FairSeedsResponseSchema,
} from './fair.ts';
import {
  CrateOpenRequestSchema,
  CrateOpenResponseSchema,
  GachaPullRequestSchema,
  GachaPullResponseSchema,
  SafeOpenRequestSchema,
  SafeOpenResponseSchema,
  ScratchRevealRequestSchema,
  ScratchRevealResponseSchema,
} from './loot.ts';
import {
  AlbumResponseSchema,
  QuestClaimRequestSchema,
  QuestClaimResponseSchema,
  QuestsResponseSchema,
  SeasonResponseSchema,
} from './meta.ts';
import {
  AscendRequestSchema,
  AscendResponseSchema,
  CharmEquipRequestSchema,
  CharmEquipResponseSchema,
  UpgradeBuyRequestSchema,
  UpgradeBuyResponseSchema,
} from './progression.ts';
import {
  EventsCurrentResponseSchema,
  LeaderboardParamsSchema,
  LeaderboardResponseSchema,
} from './social.ts';
import { StateResponseSchema } from './state.ts';
import {
  ClaimsRequestSchema,
  ClaimsResponseSchema,
  DropRequestSchema,
  DropResponseSchema,
  InputsRequestSchema,
  InputsResponseSchema,
  NudgeRequestSchema,
  NudgeResponseSchema,
} from './table.ts';

export type HttpMethod = 'GET' | 'POST';

/** `none` endpoints are still device-signed; they just carry no bearer access token. */
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
  readonly response: R;
}

function get<const P extends string, R extends z.ZodType>(
  path: P,
  response: R,
): Endpoint<'GET', P, null, null, R> {
  return { method: 'GET', path, auth: 'bearer', body: null, params: null, response };
}

function getWithParams<const P extends string, Q extends z.ZodType, R extends z.ZodType>(
  path: P,
  params: Q,
  response: R,
): Endpoint<'GET', P, null, Q, R> {
  return { method: 'GET', path, auth: 'bearer', body: null, params, response };
}

function post<const P extends string, B extends z.ZodType, R extends z.ZodType>(
  path: P,
  body: B,
  response: R,
  auth: AuthMode = 'bearer',
): Endpoint<'POST', P, B, null, R> {
  return { method: 'POST', path, auth, body, params: null, response };
}

export const endpoints = {
  authGuest: post('/v1/auth/guest', GuestAuthRequestSchema, GuestAuthResponseSchema, 'none'),
  authRefresh: post('/v1/auth/refresh', RefreshRequestSchema, RefreshResponseSchema, 'none'),
  state: get('/v1/state', StateResponseSchema),
  tableDrop: post('/v1/table/drop', DropRequestSchema, DropResponseSchema),
  tableClaims: post('/v1/table/claims', ClaimsRequestSchema, ClaimsResponseSchema),
  tableNudge: post('/v1/table/nudge', NudgeRequestSchema, NudgeResponseSchema),
  tableInputs: post('/v1/table/inputs', InputsRequestSchema, InputsResponseSchema),
  upgradesBuy: post('/v1/upgrades/buy', UpgradeBuyRequestSchema, UpgradeBuyResponseSchema),
  charmsEquip: post('/v1/charms/equip', CharmEquipRequestSchema, CharmEquipResponseSchema),
  cratesOpen: post('/v1/crates/open', CrateOpenRequestSchema, CrateOpenResponseSchema),
  safesOpen: post('/v1/safes/open', SafeOpenRequestSchema, SafeOpenResponseSchema),
  gachaPull: post('/v1/gacha/pull', GachaPullRequestSchema, GachaPullResponseSchema),
  scratchReveal: post(
    '/v1/scratch/reveal',
    ScratchRevealRequestSchema,
    ScratchRevealResponseSchema,
  ),
  ascend: post('/v1/ascend', AscendRequestSchema, AscendResponseSchema),
  album: get('/v1/album', AlbumResponseSchema),
  fairSeeds: get('/v1/fair/seeds', FairSeedsResponseSchema),
  fairRotate: post('/v1/fair/rotate', FairRotateRequestSchema, FairRotateResponseSchema),
  quests: get('/v1/quests', QuestsResponseSchema),
  questsClaim: post('/v1/quests/claim', QuestClaimRequestSchema, QuestClaimResponseSchema),
  season: get('/v1/season', SeasonResponseSchema),
  leaderboard: getWithParams(
    '/v1/leaderboard/:board',
    LeaderboardParamsSchema,
    LeaderboardResponseSchema,
  ),
  eventsCurrent: get('/v1/events/current', EventsCurrentResponseSchema),
} as const satisfies Record<string, Endpoint>;

export type Endpoints = typeof endpoints;
export type EndpointName = keyof Endpoints;
export const ENDPOINT_NAMES = Object.keys(endpoints) as EndpointName[];

type Output<S> = S extends z.ZodType ? z.output<S> : never;
type Input<S> = S extends z.ZodType ? z.input<S> : never;

export type EndpointBody<N extends EndpointName> = Output<Endpoints[N]['body']>;
export type EndpointBodyInput<N extends EndpointName> = Input<Endpoints[N]['body']>;
export type EndpointParams<N extends EndpointName> = Output<Endpoints[N]['params']>;
export type EndpointParamsInput<N extends EndpointName> = Input<Endpoints[N]['params']>;
export type EndpointResponse<N extends EndpointName> = Output<Endpoints[N]['response']>;
export type EndpointResponseInput<N extends EndpointName> = Input<Endpoints[N]['response']>;

/** Every mutating request must carry an `Idempotency-Key` header. */
export function requiresIdempotencyKey(endpoint: Endpoint): boolean {
  return endpoint.method === 'POST';
}

/** Fills `:name` path segments from validated, URI-encoded params. */
export function buildPath<N extends EndpointName>(
  name: N,
  ...args: [EndpointParamsInput<N>] extends [never] ? [] : [params: EndpointParamsInput<N>]
): string {
  const endpoint: Endpoint = endpoints[name];
  if (endpoint.params === null) {
    return endpoint.path;
  }
  const params = endpoint.params.parse(args[0]) as Record<string, string>;
  return endpoint.path.replace(/:([A-Za-z]+)/g, (_segment, key: string) => {
    const value = params[key];
    if (value === undefined) {
      throw new Error(`buildPath(${name}): missing path parameter "${key}".`);
    }
    return encodeURIComponent(value);
  });
}
