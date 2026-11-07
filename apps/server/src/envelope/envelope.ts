import {
  RATE_ENVELOPE_METRIC_IDS,
  rateEnvelopeFor,
  type RateEnvelopeLimit,
  type RateEnvelopeLimits,
  type RateEnvelopeMetricId,
  type RateEnvelopeTable,
} from '@coinposh/economy';
import type { EpochMs } from '@coinposh/shared';

/**
 * What happens past the limit. `cap` refuses the charge with a retry time and nothing
 * else, for metrics that cost the player balance anyway; `flag` also records evidence
 * and moves the player to the unranked shadow pool (01-ARCHITECTURE.md, Layer 2).
 */
export type EnvelopePolicy = 'cap' | 'flag';

/**
 * Fixed here, not in the economy config: the numbers are tunable, the anti-cheat meaning
 * of each metric is not. A queued or offline drop flush must never unrank an honest player.
 * `fallValue` is coins credited off the front edge, so one fall claim charges both
 * `falls` (count) and `fallValue` (stored server value).
 */
export const ENVELOPE_POLICY: Readonly<Record<RateEnvelopeMetricId, EnvelopePolicy>> = {
  drops: 'cap',
  falls: 'flag',
  fallValue: 'flag',
  fusions: 'flag',
  crates: 'flag',
};

export interface EnvelopeCharge {
  readonly metric: RateEnvelopeMetricId;
  readonly amount: number;
}

export type EnvelopeVerdict =
  | { readonly admitted: true }
  | {
      readonly admitted: false;
      readonly metric: RateEnvelopeMetricId;
      /** Units of `metric` already admitted inside the window. */
      readonly used: number;
      readonly limit: RateEnvelopeLimit;
      /** Server ms from `now` until the charge would fit, or null when it exceeds the limit on its own. */
      readonly retryAfterMs: number | null;
      /** True when the metric's policy is `flag`, so this refusal counts against ranking. */
      readonly flagged: boolean;
    };

/**
 * One row per metric per window: the first refusal is kept as evidence, every repeat
 * inside the same window only bumps `count`, `lastAt` and `maxExcess`.
 */
export interface EnvelopeFlag {
  readonly at: EpochMs;
  readonly metric: RateEnvelopeMetricId;
  readonly amount: number;
  readonly used: number;
  readonly max: number;
  readonly windowMs: number;
  readonly ref: string | null;
  readonly lastAt: EpochMs;
  readonly count: number;
  /** The largest `used + amount - max` seen inside the window. */
  readonly maxExcess: number;
}

/**
 * Events age out of the window, so `envelope_events` is pruned. Flags are evidence for
 * the shadow pool and audits, so `envelope_flags` rows can never be deleted and their
 * evidence never rewritten; only the repeat counters may grow. A bot held at the limit
 * therefore adds at most one row per metric per window, however fast it sends.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS envelope_events (
    id     INTEGER PRIMARY KEY,
    metric TEXT NOT NULL,
    at     INTEGER NOT NULL,
    amount INTEGER NOT NULL CHECK (amount > 0)
  );
  CREATE INDEX IF NOT EXISTS envelope_events_metric_at ON envelope_events (metric, at);

  CREATE TABLE IF NOT EXISTS envelope_flags (
    id           INTEGER PRIMARY KEY,
    metric       TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    amount       INTEGER NOT NULL,
    used         INTEGER NOT NULL,
    max          REAL NOT NULL,
    window_ms    INTEGER NOT NULL,
    ref          TEXT,
    last_at      INTEGER NOT NULL,
    count        INTEGER NOT NULL CHECK (count >= 1),
    max_excess   REAL NOT NULL,
    UNIQUE (metric, window_start)
  );

  CREATE TRIGGER IF NOT EXISTS envelope_flags_no_update BEFORE UPDATE ON envelope_flags
  WHEN NEW.id IS NOT OLD.id
    OR NEW.metric IS NOT OLD.metric
    OR NEW.window_start IS NOT OLD.window_start
    OR NEW.amount IS NOT OLD.amount
    OR NEW.used IS NOT OLD.used
    OR NEW.max IS NOT OLD.max
    OR NEW.window_ms IS NOT OLD.window_ms
    OR NEW.ref IS NOT OLD.ref
    OR NEW.count <= OLD.count
    OR NEW.last_at < OLD.last_at
    OR NEW.max_excess < OLD.max_excess
  BEGIN
    SELECT RAISE(ABORT, 'envelope_flags is append-only');
  END;

  CREATE TRIGGER IF NOT EXISTS envelope_flags_no_delete BEFORE DELETE ON envelope_flags
  BEGIN
    SELECT RAISE(ABORT, 'envelope_flags is append-only');
  END;
`;

function assertLimits(limits: RateEnvelopeLimits): void {
  for (const metric of RATE_ENVELOPE_METRIC_IDS) {
    const { windowMs, max } = limits[metric];
    if (!Number.isSafeInteger(windowMs) || windowMs <= 0) {
      throw new RangeError(
        `Envelope ${metric}.windowMs must be a positive integer, got ${windowMs}.`,
      );
    }
    if (!Number.isFinite(max) || max <= 0) {
      throw new RangeError(`Envelope ${metric}.max must be a positive number, got ${max}.`);
    }
  }
}

function assertCharge(charge: EnvelopeCharge): void {
  if (!(RATE_ENVELOPE_METRIC_IDS as readonly string[]).includes(charge.metric)) {
    throw new RangeError(`Unknown envelope metric "${charge.metric}".`);
  }
  if (!Number.isSafeInteger(charge.amount) || charge.amount < 0) {
    throw new RangeError(
      `Envelope charge for ${charge.metric} must be a non-negative integer, got ${charge.amount}.`,
    );
  }
}

function assertTime(now: EpochMs): void {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new RangeError(`Envelope time must be a non-negative integer of ms, got ${now}.`);
  }
}

/**
 * A sliding-log rate envelope over one player's Durable Object SQLite. Every timestamp
 * is server time passed in by the caller; nothing the client sends moves the window.
 * Calls must run inside the Durable Object's storage transaction for the request.
 *
 * Events are stamped with the real `now`. One stamped after `now` (the server clock
 * stepped back, or was skewed forward and then corrected) still counts as inside the
 * window, so a step back never reopens it, and `admit` re-stamps it to `now`, so it ages
 * out one window later however large the skew was instead of freezing the window.
 */
export class RateEnvelope {
  /** The envelope for one table configuration, with limits from `rateEnvelopeFor`. */
  static forTable(sql: SqlStorage, table: RateEnvelopeTable): RateEnvelope {
    return new RateEnvelope(sql, rateEnvelopeFor(table));
  }

  constructor(
    private readonly sql: SqlStorage,
    private readonly limits: RateEnvelopeLimits,
  ) {
    assertLimits(limits);
    sql.exec(SCHEMA);
  }

  /** Units of `metric` admitted inside the window ending at `now`. */
  usage(metric: RateEnvelopeMetricId, now: EpochMs): number {
    assertTime(now);
    return this.used(metric, now);
  }

  /**
   * Admits every charge or none. On rejection nothing is admitted and the first charge
   * that does not fit decides the verdict: a `cap` metric is only refused, a `flag`
   * metric is also recorded and drops the player into the unranked shadow pool.
   * A caller that throws inside the same storage transaction rolls the flag back too, so
   * a refusal must be returned from the transaction, not thrown.
   */
  admit(charges: readonly EnvelopeCharge[], now: EpochMs, ref: string | null): EnvelopeVerdict {
    for (const charge of charges) assertCharge(charge);
    assertTime(now);
    const totals = new Map<RateEnvelopeMetricId, number>();
    for (const { metric, amount } of charges) {
      if (amount > 0) totals.set(metric, (totals.get(metric) ?? 0) + amount);
    }
    for (const [metric, amount] of totals) {
      this.settle(metric, now);
      const limit = this.limits[metric];
      const used = this.used(metric, now);
      if (used + amount > limit.max) {
        const flagged = ENVELOPE_POLICY[metric] === 'flag';
        if (flagged) this.flag(metric, amount, used, now, ref);
        return {
          admitted: false,
          metric,
          used,
          limit,
          retryAfterMs: this.retryAfter(metric, amount, now),
          flagged,
        };
      }
    }
    for (const [metric, amount] of totals) {
      this.sql.exec(
        'INSERT INTO envelope_events (metric, at, amount) VALUES (?, ?, ?)',
        metric,
        now,
        amount,
      );
    }
    return { admitted: true };
  }

  flags(): EnvelopeFlag[] {
    return this.sql
      .exec<{
        at: number;
        metric: RateEnvelopeMetricId;
        amount: number;
        used: number;
        max: number;
        window_ms: number;
        ref: string | null;
        last_at: number;
        count: number;
        max_excess: number;
      }>(
        `SELECT window_start AS at, metric, amount, used, max, window_ms, ref, last_at, count,
                max_excess
         FROM envelope_flags ORDER BY id`,
      )
      .toArray()
      .map(({ window_ms, last_at, max_excess, ...flag }) => ({
        ...flag,
        windowMs: window_ms,
        lastAt: last_at,
        maxExcess: max_excess,
      }));
  }

  /** A flagged player is silently kept off ranked leaderboards. */
  unranked(): boolean {
    return this.sql.exec('SELECT 1 FROM envelope_flags LIMIT 1').toArray().length > 0;
  }

  private used(metric: RateEnvelopeMetricId, now: EpochMs): number {
    const row = this.sql
      .exec<{ total: number | null }>(
        'SELECT SUM(amount) AS total FROM envelope_events WHERE metric = ? AND at > ?',
        metric,
        now - this.limits[metric].windowMs,
      )
      .one();
    return row.total ?? 0;
  }

  /** Drops events that left the window and pulls any stamped after `now` back to `now`. */
  private settle(metric: RateEnvelopeMetricId, now: EpochMs): void {
    this.sql.exec(
      'DELETE FROM envelope_events WHERE metric = ? AND at <= ?',
      metric,
      now - this.limits[metric].windowMs,
    );
    this.sql.exec(
      'UPDATE envelope_events SET at = ? WHERE metric = ? AND at > ?',
      now,
      metric,
      now,
    );
  }

  /** Walks the window oldest first until enough units age out for `amount` to fit. */
  private retryAfter(metric: RateEnvelopeMetricId, amount: number, now: EpochMs): number | null {
    const { windowMs, max } = this.limits[metric];
    if (amount > max) return null;
    let used = this.used(metric, now);
    // Drained with toArray: cursors abandoned mid-iteration stay open in workerd and made
    // each later statement slower, so a 10,000-refusal flood went quadratic.
    const events = this.sql
      .exec<{ at: number; amount: number }>(
        'SELECT at, amount FROM envelope_events WHERE metric = ? AND at > ? ORDER BY at, id',
        metric,
        now - windowMs,
      )
      .toArray();
    for (const event of events) {
      used -= event.amount;
      if (used + amount <= max) return event.at + windowMs - now;
    }
    return windowMs;
  }

  private flag(
    metric: RateEnvelopeMetricId,
    amount: number,
    used: number,
    now: EpochMs,
    ref: string | null,
  ): void {
    const { windowMs, max } = this.limits[metric];
    const excess = used + amount - max;
    const open = this.sql
      .exec<{ id: number }>(
        `SELECT id FROM envelope_flags WHERE metric = ? AND window_start > ?
         ORDER BY window_start DESC LIMIT 1`,
        metric,
        now - windowMs,
      )
      .toArray()[0];
    if (open !== undefined) {
      this.sql.exec(
        `UPDATE envelope_flags
         SET count = count + 1, last_at = MAX(last_at, ?), max_excess = MAX(max_excess, ?)
         WHERE id = ?`,
        now,
        excess,
        open.id,
      );
      return;
    }
    this.sql.exec(
      `INSERT INTO envelope_flags
         (metric, window_start, amount, used, max, window_ms, ref, last_at, count, max_excess)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      metric,
      now,
      amount,
      used,
      max,
      windowMs,
      ref,
      now,
      excess,
    );
  }
}
