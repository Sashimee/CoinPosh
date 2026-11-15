import type { EndpointMap, EpochMs, PlayerId, TableSessionId, Wallet } from '@coinposh/shared';
import type { Hono } from 'hono';
import type { DoResult } from '../do/PlayerDO.ts';
import type { LedgerTx } from '../do/ledger.ts';
import type { AppContext, AppEnv } from '../http/context.ts';
import type { FairRoll } from '../rng/fair.ts';

/**
 * One PlayerDO table a feature owns. `migrations[i]` takes it from version `i` to `i + 1`, and
 * `version` must equal `migrations.length`, so a migration is only ever appended. The name is
 * prefixed `<featureId>_` so no feature can shadow a core table or another feature's.
 */
export interface FeatureTable {
  readonly name: string;
  readonly version: number;
  readonly migrations: readonly string[];
}

/** What a feature's DO handler may touch, inside the PlayerDO's storage transaction. */
export interface FeatureDoContext {
  readonly featureId: string;
  readonly playerId: PlayerId;
  /** The DO clock for this call; the only time a handler may trust. */
  readonly now: EpochMs;
  /** `null` on reads, which may not move value. */
  readonly idempotencyKey: string | null;
  readonly sql: SqlStorage;
  /** A nested savepoint: what `run` wrote rolls back alone if it throws. */
  transaction<T>(run: () => T): T;
  readWallet(): Wallet;
  /** A transaction of one of this feature's own `txKinds`; any other kind throws. */
  ledgerTx(kind: string): LedgerTx;
  /** Commits a transaction from `ledgerTx`, stamped with this call's time and Idempotency-Key. */
  commit(tx: LedgerTx): void;
  /** A provably fair roll on the player's seed chain, logged under `<featureId>.<purpose>`. */
  roll(purpose: string, ref: string | null): FairRoll;
  /** Refuses a table op from any tab but the one that booted last, like the core table routes. */
  requireLease(session: TableSessionId | undefined): void;
}

export type FeatureDoHandler = (ctx: FeatureDoContext, input: unknown) => unknown;

/**
 * What a feature route sends the PlayerDO. Writes carry the request's Idempotency-Key and
 * fingerprint so a retry replays the stored answer; reads carry neither and may not move value.
 */
export interface FeatureCall {
  readonly idempotencyKey: string | null;
  readonly fingerprint: string | null;
  readonly input: unknown;
}

export interface FeatureRouteDeps {
  /**
   * Serves `endpoint` from `handler`: the body (strict), path params and query are parsed
   * against the contract, the handler runs in the caller's PlayerDO (as a write under the
   * Idempotency-Key for POST, as a read for GET) and its answer is checked against the response.
   */
  mount(endpoint: EndpointMap[string], handler: string): void;
  /** Runs one of this feature's handlers in the caller's PlayerDO, for routes `mount` cannot express. */
  dispatch(c: AppContext, handler: string, call: FeatureCall): Promise<DoResult<unknown>>;
}

/**
 * A server feature module. Its routes are mounted behind device-signed bearer auth, its
 * handlers run inside the PlayerDO's storage transaction under the per-call conservation
 * check, and its tables migrate on their own version track, so it never edits PlayerDO.ts
 * or schema.ts.
 */
export interface ServerFeature<E extends EndpointMap = EndpointMap> {
  readonly id: string;
  /** The contract its routes serve, which also types `createFeatureHarness`'s client. */
  readonly endpoints: E;
  routes(app: Hono<AppEnv>, deps: FeatureRouteDeps): void;
  readonly doHandlers: Readonly<Record<string, FeatureDoHandler>>;
  readonly tables: readonly FeatureTable[];
  readonly txKinds: readonly string[];
}
