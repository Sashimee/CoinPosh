import { z } from 'zod';
import {
  AccountLinkRequestSchema,
  AccountLinkResponseSchema,
  AccountNonceRequestSchema,
  AccountNonceResponseSchema,
  AccountResponseSchema,
  AccountUnlinkRequestSchema,
  AccountUnlinkResponseSchema,
  SignInRequestSchema,
  SignInResponseSchema,
} from './account.ts';
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
  TableSnapshotRequestSchema,
  TableSnapshotResponseSchema,
} from './table.ts';

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

/**
 * `hydrate=boot` marks the snapshot a freshly loaded client lays its table from. Its sim can
 * only lay the opening heap, so the server refunds every other table coin for that one call.
 * Mid-session snapshots (resync, resume) omit it and leave coins in play alone.
 */
export const StateQuerySchema = z.strictObject({
  hydrate: z.literal('boot').optional(),
});
export type StateQuery = z.infer<typeof StateQuerySchema>;

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
  state: { ...get('/v1/state', StateResponseSchema), query: StateQuerySchema },
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

// TODO(lead-architect): register as `endpoints.tableSnapshot` in the same change that adds its
// fixture to `test/fixtures.ts` and its mock handler (T-92.05); both are mapped over every
// EndpointName, so registering it ahead of them breaks their typecheck.
export const tableSnapshotEndpoint = post(
  '/v1/table/snapshot',
  TableSnapshotRequestSchema,
  TableSnapshotResponseSchema,
);

// TODO(lead-architect): spread into `endpoints` in the same change that adds their fixtures to
// `test/fixtures.ts` and their Demo handlers to `apps/web/src/net/mock/world.ts`; both are mapped
// over every EndpointName (https://github.com/Sashimee/CoinPosh/issues/119).
/** `none` routes serve a device with no session yet and carry the signing key in the body. */
export const accountEndpoints = {
  accountNonce: post(
    '/v1/account/nonce',
    AccountNonceRequestSchema,
    AccountNonceResponseSchema,
    'none',
  ),
  accountLink: post('/v1/account/link', AccountLinkRequestSchema, AccountLinkResponseSchema),
  authSignIn: post('/v1/auth/signin', SignInRequestSchema, SignInResponseSchema, 'none'),
  accountUnlink: post(
    '/v1/account/unlink',
    AccountUnlinkRequestSchema,
    AccountUnlinkResponseSchema,
  ),
  account: get('/v1/account', AccountResponseSchema),
} as const satisfies Record<string, Endpoint>;

export type AccountEndpoints = typeof accountEndpoints;
export type AccountEndpointName = keyof AccountEndpoints;
export const ACCOUNT_ENDPOINT_NAMES = Object.keys(accountEndpoints) as AccountEndpointName[];

export type Endpoints = typeof endpoints;
export type EndpointName = keyof Endpoints;
export const ENDPOINT_NAMES = Object.keys(endpoints) as EndpointName[];

type Output<S> = S extends z.ZodType ? z.output<S> : never;
type Input<S> = S extends z.ZodType ? z.input<S> : never;

export type EndpointBody<N extends EndpointName> = Output<Endpoints[N]['body']>;
export type EndpointBodyInput<N extends EndpointName> = Input<Endpoints[N]['body']>;
export type EndpointParams<N extends EndpointName> = Output<Endpoints[N]['params']>;
export type EndpointParamsInput<N extends EndpointName> = Input<Endpoints[N]['params']>;
export type EndpointQueryInput<N extends EndpointName> = Endpoints[N] extends {
  readonly query: infer S;
}
  ? Input<S>
  : never;
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
