import {
  CURRENCIES,
  type EpochMs,
  type PlayerId,
  type TableSessionId,
  type Wallet,
} from '@coinposh/shared';
import { SERVER_FEATURES } from '../features/registry.ts';
import type {
  FeatureDoContext,
  FeatureDoHandler,
  FeatureTable,
  ServerFeature,
} from '../features/types.ts';
import type { FairRoll } from '../rng/fair.ts';
import {
  type Account,
  checkTxKinds,
  commit,
  ConservationError,
  featureTxKind,
  LedgerTx,
  type LedgerUnit,
  readWallet,
  registerTxKinds,
  txKindOwner,
} from './ledger.ts';

/** No underscore, so the `<featureId>_` table prefix can only ever belong to one feature. */
const FEATURE_ID_PATTERN = /^[a-z][A-Za-z0-9]*$/;
const TABLE_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * Each feature table's own version, kept apart from `schema_version` so features migrate on
 * their own track and never touch schema.ts.
 */
export const FEATURE_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS feature_tables (
    feature TEXT NOT NULL,
    name    TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    PRIMARY KEY (feature, name)
  )
`;

const catalog = new Map<string, ServerFeature>();

function validateTable(featureId: string, table: FeatureTable): void {
  if (!TABLE_NAME_PATTERN.test(table.name) || !table.name.startsWith(`${featureId}_`)) {
    throw new Error(
      `Feature "${featureId}" table "${table.name}" must be snake_case and start with "${featureId}_".`,
    );
  }
  if (
    !Number.isSafeInteger(table.version) ||
    table.version < 1 ||
    table.version !== table.migrations.length
  ) {
    throw new Error(
      `Feature "${featureId}" table "${table.name}" declares version ${table.version} but has ` +
        `${table.migrations.length} migrations; append a migration and bump the version together.`,
    );
  }
}

/**
 * Makes features known to the PlayerDO: their tables, handlers and ledger kinds. Every check
 * runs before anything is recorded, so a bad feature fails the whole boot loudly instead of
 * half-registering. Registering the same module again is a no-op.
 */
export function registerServerFeatures(features: readonly ServerFeature[]): void {
  const ids = new Set<string>();
  const batchKinds = new Map<string, string>();
  for (const feature of features) {
    if (!FEATURE_ID_PATTERN.test(feature.id)) {
      throw new Error(`Server feature id "${feature.id}" must be camelCase, e.g. "cellar".`);
    }
    if (ids.has(feature.id)) {
      throw new Error(`Server feature "${feature.id}" is listed twice.`);
    }
    ids.add(feature.id);
    const existing = catalog.get(feature.id);
    if (existing !== undefined && existing !== feature) {
      throw new Error(
        `A different server feature already registered the id "${feature.id}"; feature ids are unique.`,
      );
    }
    checkTxKinds(feature.id, feature.txKinds);
    for (const kind of feature.txKinds) {
      const other = batchKinds.get(kind);
      if (other !== undefined && other !== feature.id) {
        throw new Error(`Features "${other}" and "${feature.id}" both list ledger kind "${kind}".`);
      }
      batchKinds.set(kind, feature.id);
    }
    const names = new Set<string>();
    for (const table of feature.tables) {
      if (names.has(table.name)) {
        throw new Error(`Feature "${feature.id}" lists table "${table.name}" twice.`);
      }
      names.add(table.name);
      validateTable(feature.id, table);
    }
  }
  for (const feature of features) {
    if (catalog.get(feature.id) === feature) continue;
    registerTxKinds(feature.id, feature.txKinds);
    catalog.set(feature.id, feature);
  }
}

export function registeredServerFeatures(): readonly ServerFeature[] {
  return [...catalog.values()];
}

export function resolveFeatureHandler(
  featureId: string,
  handler: string,
): { readonly feature: ServerFeature; readonly run: FeatureDoHandler } {
  const feature = catalog.get(featureId);
  if (feature === undefined) {
    throw new Error(
      `No server feature "${featureId}" is registered with the PlayerDO; add it to SERVER_FEATURES.`,
    );
  }
  const run = Object.hasOwn(feature.doHandlers, handler) ? feature.doHandlers[handler] : undefined;
  if (run === undefined) {
    throw new Error(`Server feature "${featureId}" has no DO handler "${handler}".`);
  }
  return { feature, run };
}

/** Brings each of the feature's tables up to its declared version, inside one transaction. */
export function applyFeatureTables(
  sql: SqlStorage,
  feature: ServerFeature,
  transactionSync: <T>(run: () => T) => T,
): void {
  transactionSync(() => {
    sql.exec(FEATURE_TABLES_SQL);
    for (const table of feature.tables) {
      const current =
        sql
          .exec<{ version: number }>(
            'SELECT version FROM feature_tables WHERE feature = ? AND name = ?',
            feature.id,
            table.name,
          )
          .toArray()[0]?.version ?? 0;
      if (current > table.version) {
        throw new Error(
          `Feature "${feature.id}" table "${table.name}" is at version ${current} in storage but the ` +
            `code declares ${table.version}; migrations only move forward, so deploy the newer code.`,
        );
      }
      if (current === table.version) continue;
      for (let version = current; version < table.version; version++) {
        sql.exec(table.migrations[version] ?? '');
      }
      sql.exec(
        `INSERT INTO feature_tables (feature, name, version) VALUES (?, ?, ?)
         ON CONFLICT (feature, name) DO UPDATE SET version = excluded.version`,
        feature.id,
        table.name,
        table.version,
      );
    }
  });
}

/**
 * The entity-side totals that the ledger's table, buffer and inventory balances must match.
 * Each is an indexed count or sum over entity rows, so reading it never scans the ledger.
 */
export interface EntityFingerprint {
  readonly bufferPaid: number;
  readonly tableValue: number;
  readonly tableCrates: number;
  readonly cratesHeld: number;
  readonly collectiblesHeld: number;
  readonly safesHeld: number;
  readonly scratchCardsHeld: number;
}

/** The ledger balance each fingerprint field backs. */
const ENTITY_BACKING: readonly {
  readonly field: keyof EntityFingerprint;
  readonly account: Account;
  readonly unit: LedgerUnit;
}[] = [
  { field: 'bufferPaid', account: 'buffer', unit: 'coins' },
  { field: 'tableValue', account: 'table', unit: 'coins' },
  { field: 'tableCrates', account: 'table', unit: 'crate' },
  { field: 'cratesHeld', account: 'inventory', unit: 'crate' },
  { field: 'collectiblesHeld', account: 'inventory', unit: 'collectible' },
  { field: 'safesHeld', account: 'inventory', unit: 'safe' },
  { field: 'scratchCardsHeld', account: 'inventory', unit: 'scratchCard' },
];

/** What the PlayerDO lends a feature handler; everything else of the DO stays private. */
export interface FeatureHost {
  readonly sql: SqlStorage;
  readonly playerId: PlayerId;
  transactionSync<T>(run: () => T): T;
  roll(purpose: string, ref: string | null, now: EpochMs): FairRoll;
  requireLease(session: TableSessionId | undefined): void;
  entityFingerprint(): EntityFingerprint;
}

interface AppendedLeg extends Record<string, SqlStorageValue> {
  readonly tx_id: string;
  readonly kind: string;
  readonly account: string;
  readonly unit: string;
  readonly delta: number;
}

/** Accounts whose balances must match entity rows (coins, crates, items), not just the ledger. */
const ENTITY_ACCOUNTS: ReadonlySet<string> = new Set<Account>(['buffer', 'table', 'inventory']);

function latestSeq(sql: SqlStorage): number {
  return sql.exec<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM ledger').one().seq ?? 0;
}

interface CallSnapshot {
  readonly sinceSeq: number;
  readonly wallet: Wallet;
  readonly entities: EntityFingerprint;
}

function addTo(map: Map<string, number>, key: string, delta: number): void {
  map.set(key, (map.get(key) ?? 0) + delta);
}

/**
 * Re-checks what the handler appended against what it changed: every row is one of the
 * feature's own kinds, every transaction balances per unit, each wallet balance moved by
 * exactly its wallet legs, and each table, buffer and inventory balance moved by exactly as
 * much as its coin, crate or item rows. Raw `sql` is in the handler's hands, so this is what
 * stops a feature from writing the wallet, the ledger or the entity rows behind `commit`'s
 * back. The DO was conserved before the call, so matching the appended legs against the change
 * in the entity fingerprint keeps it conserved without ever scanning the ledger.
 */
function assertFeatureConserved(
  host: FeatureHost,
  feature: ServerFeature,
  before: CallSnapshot,
  mayMoveValue: boolean,
): void {
  const { sql } = host;
  const legs = sql
    .exec<AppendedLeg>(
      'SELECT tx_id, kind, account, unit, delta FROM ledger WHERE seq > ? ORDER BY seq',
      before.sinceSeq,
    )
    .toArray();
  if (legs.length > 0 && !mayMoveValue) {
    throw new ConservationError(
      `Feature "${feature.id}" moved value on a read; value only moves under an Idempotency-Key (a POST).`,
    );
  }
  const entitiesAfter = host.entityFingerprint();
  if (
    !mayMoveValue &&
    ENTITY_BACKING.some(({ field }) => entitiesAfter[field] !== before.entities[field])
  ) {
    throw new ConservationError(
      `Feature "${feature.id}" changed coin, crate or item rows on a read; value only moves ` +
        `under an Idempotency-Key (a POST).`,
    );
  }
  const sums = new Map<string, number>();
  const walletLegs = new Map<string, number>();
  const entityLegs = new Map<string, number>();
  for (const leg of legs) {
    if (txKindOwner(leg.kind) !== feature.id) {
      throw new ConservationError(
        `Feature "${feature.id}" wrote a "${leg.kind}" ledger row; it may only write its own txKinds.`,
      );
    }
    addTo(sums, `${leg.tx_id} ${leg.unit}`, leg.delta);
    if (leg.account === 'wallet') {
      addTo(walletLegs, leg.unit, leg.delta);
    } else if (ENTITY_ACCOUNTS.has(leg.account)) {
      addTo(entityLegs, `${leg.account}/${leg.unit}`, leg.delta);
    }
  }
  for (const [key, sum] of sums) {
    if (sum !== 0) {
      throw new ConservationError(
        `Feature "${feature.id}" left transaction ${key} unbalanced by ${sum}.`,
      );
    }
  }
  const walletAfter = readWallet(sql);
  for (const currency of CURRENCIES) {
    const moved = walletAfter[currency] - before.wallet[currency];
    const legged = walletLegs.get(currency) ?? 0;
    if (moved !== legged) {
      throw new ConservationError(
        `Feature "${feature.id}" changed the ${currency} wallet by ${moved} but its ledger legs ` +
          `say ${legged}; move value only through ctx.ledgerTx and ctx.commit.`,
      );
    }
  }
  for (const { field, account, unit } of ENTITY_BACKING) {
    const balance = `${account}/${unit}`;
    const moved = entitiesAfter[field] - before.entities[field];
    const legged = entityLegs.get(balance) ?? 0;
    entityLegs.delete(balance);
    if (moved !== legged) {
      throw new ConservationError(
        `Feature "${feature.id}" moved ${balance} by ${legged} in the ledger but by ${moved} in ` +
          `its entity rows; a leg on table, buffer or inventory needs the matching coin, crate ` +
          `or item row in the same call.`,
      );
    }
  }
  for (const [balance, legged] of entityLegs) {
    if (legged !== 0) {
      throw new ConservationError(
        `Feature "${feature.id}" moved ${balance} by ${legged}, a balance no entity rows back.`,
      );
    }
  }
}

/**
 * Runs one feature handler. The caller holds the PlayerDO storage transaction, so a throw
 * here rolls back the handler's rows and ledger legs together.
 */
export function runFeatureHandler(
  host: FeatureHost,
  feature: ServerFeature,
  run: FeatureDoHandler,
  now: EpochMs,
  idempotencyKey: string | null,
  input: unknown,
): unknown {
  const { sql } = host;
  const kinds = new Set(feature.txKinds);
  const context = { at: now, idempotencyKey };
  const ctx: FeatureDoContext = {
    featureId: feature.id,
    playerId: host.playerId,
    now,
    idempotencyKey,
    sql,
    transaction: (inner) => host.transactionSync(inner),
    readWallet: () => readWallet(sql),
    ledgerTx: (kind) => {
      if (!kinds.has(kind)) {
        throw new ConservationError(
          `Feature "${feature.id}" cannot open a "${kind}" transaction; its txKinds are [${feature.txKinds.join(', ')}].`,
        );
      }
      return new LedgerTx(featureTxKind(kind));
    },
    commit: (tx) => {
      if (!kinds.has(tx.kind)) {
        throw new ConservationError(
          `Feature "${feature.id}" cannot commit a "${tx.kind}" transaction; open it with ctx.ledgerTx.`,
        );
      }
      commit(sql, tx, context);
    },
    roll: (purpose, ref) => host.roll(`${feature.id}.${purpose}`, ref, now),
    requireLease: (session) => {
      host.requireLease(session);
    },
  };
  const before: CallSnapshot = {
    sinceSeq: latestSeq(sql),
    wallet: readWallet(sql),
    entities: host.entityFingerprint(),
  };
  const output = run(ctx, input);
  assertFeatureConserved(host, feature, before, idempotencyKey !== null);
  return output;
}

registerServerFeatures(SERVER_FEATURES);
