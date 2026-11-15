import { CURRENCIES, type Currency, type EpochMs, type Wallet } from '@coinposh/shared';

/**
 * Where value sits. `mint` is the only source of new value (starting grants, defined
 * bonuses), `house` is where side-gutter losses go and what stakes the opening heap,
 * `buffer` holds what the wallet prepaid for reserved drop coins, `inventory` holds
 * claimed crates, unopened safes, unrevealed scratch cards and owned album cards.
 */
export const ACCOUNTS = ['mint', 'wallet', 'buffer', 'table', 'house', 'inventory'] as const;
export type Account = (typeof ACCOUNTS)[number];

export type LedgerUnit = Currency | 'crate' | 'safe' | 'scratchCard' | 'collectible';

export const TX_KINDS = [
  'grant.starting',
  'grant.heap',
  'buffer.prepay',
  'drop.mint',
  'drop.buffer',
  'crate.spawn',
  'claim.fall',
  'claim.fusion',
  'claim.crate',
  'crate.open',
  'refund.table',
  'upgrade.buy',
  'ascend',
  'safe.grant',
  'safe.key',
  'safe.open',
  'scratch.grant',
  'scratch.reveal',
  'quest.claim',
  'streak.milestone',
  'season.tier',
  'season.rollover',
  'soiree.reward',
  'soiree.table',
] as const;
export type TxKind = (typeof TX_KINDS)[number];

declare const featureTxKindBrand: unique symbol;
/** A kind a server feature registered with `registerTxKinds`; only `featureTxKind` mints one. */
export type FeatureTxKind = string & { readonly [featureTxKindBrand]: true };
export type LedgerKind = TxKind | FeatureTxKind;

const TX_KIND_PATTERN = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)*$/;
const CORE_TX_KINDS: ReadonlySet<string> = new Set(TX_KINDS);
const kindOwners = new Map<string, string>();
const kindsByFeature = new Map<string, readonly string[]>();

/**
 * Throws unless `featureId` may register `kinds`: each is dotted camelCase, none is core or
 * another feature's, and none is listed twice. Returns true when the feature already holds
 * exactly these kinds, false when they are free to register.
 */
export function checkTxKinds(featureId: string, kinds: readonly string[]): boolean {
  const previous = kindsByFeature.get(featureId);
  if (previous !== undefined) {
    if (previous.length !== kinds.length || previous.some((kind, i) => kind !== kinds[i])) {
      throw new ConservationError(
        `Feature "${featureId}" already registered ledger kinds [${previous.join(', ')}]; ` +
          `it cannot re-register them as [${kinds.join(', ')}].`,
      );
    }
    return true;
  }
  const seen = new Set<string>();
  for (const kind of kinds) {
    if (!TX_KIND_PATTERN.test(kind)) {
      throw new ConservationError(
        `Feature "${featureId}" ledger kind "${kind}" is malformed; use dotted camelCase like "${featureId}.claim".`,
      );
    }
    if (CORE_TX_KINDS.has(kind)) {
      throw new ConservationError(
        `Feature "${featureId}" cannot register ledger kind "${kind}": it is a core kind in TX_KINDS.`,
      );
    }
    const owner = kindOwners.get(kind);
    if (owner !== undefined || seen.has(kind)) {
      throw new ConservationError(
        `Feature "${featureId}" cannot register ledger kind "${kind}": ` +
          `${owner === undefined ? 'it lists it twice' : `feature "${owner}" already owns it`}.`,
      );
    }
    seen.add(kind);
  }
  return false;
}

/**
 * Lets a server feature's ledger kinds into `LedgerTx` and the conservation check. A kind
 * belongs to exactly one owner, so two features can never read each other's rows as their
 * own. Registering the same feature with the same kinds again is a no-op.
 */
export function registerTxKinds(
  featureId: string,
  kinds: readonly string[],
): readonly FeatureTxKind[] {
  if (!checkTxKinds(featureId, kinds)) {
    for (const kind of kinds) kindOwners.set(kind, featureId);
    kindsByFeature.set(featureId, [...kinds]);
  }
  return kinds as readonly FeatureTxKind[];
}

/** The feature that registered `kind`, or `null` for a core or unknown kind. */
export function txKindOwner(kind: string): string | null {
  return kindOwners.get(kind) ?? null;
}

export function isLedgerKind(kind: string): kind is LedgerKind {
  return CORE_TX_KINDS.has(kind) || kindOwners.has(kind);
}

/** Narrows a string to a registered feature kind, throwing for core or unregistered ones. */
export function featureTxKind(kind: string): FeatureTxKind {
  if (!kindOwners.has(kind)) {
    throw new ConservationError(
      `Ledger kind "${kind}" is not registered by any feature; list it in the feature's txKinds.`,
    );
  }
  return kind as FeatureTxKind;
}

function assertLedgerKind(kind: string): void {
  if (!isLedgerKind(kind)) {
    throw new ConservationError(
      `Ledger kind "${kind}" is neither a core TX_KINDS entry nor registered by a feature.`,
    );
  }
}

export interface Leg {
  readonly account: Account;
  readonly unit: LedgerUnit;
  readonly delta: number;
  readonly ref: string | null;
}

export class ConservationError extends Error {
  override readonly name = 'ConservationError';
}

/** A double-entry transaction: legs must sum to zero per unit before it may be committed. */
export class LedgerTx {
  readonly legs: Leg[] = [];

  constructor(readonly kind: LedgerKind) {
    assertLedgerKind(kind);
  }

  post(account: Account, unit: LedgerUnit, delta: number, ref: string | null): this {
    if (!Number.isSafeInteger(delta)) {
      throw new ConservationError(`Ledger delta must be a safe integer, got ${delta}.`);
    }
    if (delta !== 0) this.legs.push({ account, unit, delta, ref });
    return this;
  }

  move(from: Account, to: Account, unit: LedgerUnit, amount: number, ref: string | null): this {
    if (amount < 0) {
      throw new ConservationError(`Ledger moves are non-negative, got ${amount}.`);
    }
    return this.post(from, unit, -amount, ref).post(to, unit, amount, ref);
  }

  assertBalanced(): void {
    assertLedgerKind(this.kind);
    const sums = new Map<LedgerUnit, number>();
    for (const leg of this.legs) sums.set(leg.unit, (sums.get(leg.unit) ?? 0) + leg.delta);
    for (const [unit, sum] of sums) {
      if (sum !== 0) {
        throw new ConservationError(`${this.kind} is unbalanced: ${unit} legs sum to ${sum}.`);
      }
    }
  }
}

function isCurrency(unit: string): unit is Currency {
  return (CURRENCIES as readonly string[]).includes(unit);
}

export interface CommitContext {
  readonly at: EpochMs;
  readonly idempotencyKey: string | null;
}

/**
 * Appends the transaction and applies its wallet legs. Wallet balances change only here,
 * so they always equal the sum of their ledger legs; the `balance >= 0` CHECK aborts the
 * surrounding storage transaction rather than let a balance go negative.
 */
export function commit(sql: SqlStorage, tx: LedgerTx, context: CommitContext): void {
  tx.assertBalanced();
  if (tx.legs.length === 0) return;
  const txId = crypto.randomUUID();
  for (const leg of tx.legs) {
    if (leg.account === 'wallet') {
      if (!isCurrency(leg.unit)) {
        throw new ConservationError(`The wallet only holds currencies, not ${leg.unit}.`);
      }
      sql.exec('UPDATE wallet SET balance = balance + ? WHERE currency = ?', leg.delta, leg.unit);
    }
    sql.exec(
      `INSERT INTO ledger (tx_id, at, kind, account, unit, delta, ref, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      txId,
      context.at,
      tx.kind,
      leg.account,
      leg.unit,
      leg.delta,
      leg.ref,
      context.idempotencyKey,
    );
  }
}

export function readWallet(sql: SqlStorage): Wallet {
  const wallet: Record<Currency, number> = {
    coins: 0,
    bullion: 0,
    goldBars: 0,
    pearls: 0,
    keys: 0,
    tickets: 0,
    stars: 0,
  };
  for (const row of sql.exec<{ currency: string; balance: number }>(
    'SELECT currency, balance FROM wallet',
  )) {
    if (isCurrency(row.currency)) wallet[row.currency] = row.balance;
  }
  return wallet;
}

export function openWallet(sql: SqlStorage): void {
  for (const currency of CURRENCIES) {
    sql.exec('INSERT OR IGNORE INTO wallet (currency, balance) VALUES (?, 0)', currency);
  }
}

/** Sum of every leg for one account and unit: the account's balance as the ledger sees it. */
export function ledgerBalance(sql: SqlStorage, account: Account, unit: LedgerUnit): number {
  const row = sql
    .exec<{ total: number | null }>(
      'SELECT SUM(delta) AS total FROM ledger WHERE account = ? AND unit = ?',
      account,
      unit,
    )
    .one();
  return row.total ?? 0;
}
