import { CURRENCIES, type Currency, type EpochMs, type Wallet } from '@coinposh/shared';

/**
 * Where value sits. `mint` is the only source of new value (starting grants, defined
 * bonuses), `house` is where side-gutter losses go and what stakes the opening heap,
 * `buffer` holds what the wallet prepaid for reserved drop coins, `inventory` holds
 * claimed crates.
 */
export const ACCOUNTS = ['mint', 'wallet', 'buffer', 'table', 'house', 'inventory'] as const;
export type Account = (typeof ACCOUNTS)[number];

export type LedgerUnit = Currency | 'crate';

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
] as const;
export type TxKind = (typeof TX_KINDS)[number];

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

  constructor(readonly kind: TxKind) {}

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
