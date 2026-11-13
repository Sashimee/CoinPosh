import {
  ascension,
  ascensionGoldBars,
  bullion,
  bullionFromValue,
  currencies,
  upgradeCost,
  upgradeLines,
  upgradeStat,
  venues,
  type UpgradeLineDef,
  type UpgradeStatId,
  type VenueDef,
} from '@coinposh/economy';
import {
  endpoints,
  VenueIdSchema,
  type AscendRequest,
  type AscendResponse,
  type Currency,
  type PlayerId,
  type UpgradeBuyRequest,
  type UpgradeBuyResponse,
  type UpgradeLevels,
  type VenueId,
  type Wallet,
} from '@coinposh/shared';
import { Hono } from 'hono';
import type { Command, DoResult } from '../do/PlayerDO.ts';
import { commit, LedgerTx, readWallet, type CommitContext, type Leg } from '../do/ledger.ts';
import type { Env } from '../env.ts';
import type { AppEnv } from '../http/context.ts';
import { ApiFailure } from '../http/errors.ts';
import {
  authenticate,
  fingerprint,
  parseBody,
  requireIdempotencyKey,
  respond,
} from '../http/signed.ts';
import { UPGRADE_TX_KIND } from './upgrades.ts';

/**
 * PlayerDO tables for Venue Ascension and The Family Office. `ascensions` is append-only: one
 * row per ascension, carrying the ledger position it closed, so Bullion for the next run only
 * counts winnings after it. The final venue can be ascended again and again, so a venue may
 * appear more than once. Family Office levels are global and never reset.
 */
export const ASCENSION_SQL = `
  CREATE TABLE IF NOT EXISTS ascensions (
    seq              INTEGER PRIMARY KEY,
    venue_id         TEXT NOT NULL,
    ledger_seq       INTEGER NOT NULL CHECK (ledger_seq >= 0),
    lifetime_bullion INTEGER NOT NULL CHECK (lifetime_bullion >= 0),
    gold_bars        INTEGER NOT NULL CHECK (gold_bars >= 0),
    at               INTEGER NOT NULL
  );

  CREATE TRIGGER IF NOT EXISTS ascensions_no_update BEFORE UPDATE ON ascensions
  BEGIN
    SELECT RAISE(ABORT, 'ascensions is append-only');
  END;

  CREATE TRIGGER IF NOT EXISTS ascensions_no_delete BEFORE DELETE ON ascensions
  BEGIN
    SELECT RAISE(ABORT, 'ascensions is append-only');
  END;

  CREATE TABLE IF NOT EXISTS family_office_levels (
    line_id TEXT PRIMARY KEY,
    level   INTEGER NOT NULL CHECK (level >= 0)
  );
`;

/**
 * The single ledger transaction an ascension commits: the venue's resetting currencies go to
 * the house, the mint pays the Gold Bars and the Trust Fund's starting coins.
 * TODO(lead-architect): add 'ascend' to TX_KINDS in do/ledger.ts with the PlayerDO wiring.
 */
export const ASCEND_TX_KIND = 'ascend';

/** Winnings are coins a claim moved into the wallet; Bullion is minted from them. */
const WINNINGS_KIND = 'claim.fall';

const FAMILY_OFFICE_LINES: readonly UpgradeLineDef[] = upgradeLines.filter(
  (line) => line.scope === 'global',
);

const RESETTING_CURRENCIES: readonly Currency[] = currencies
  .filter((currency) => currency.resetsOnAscension)
  .map((currency) => currency.id);

const ORDERED_VENUES: readonly VenueDef[] = [...venues].sort((a, b) => a.order - b.order);

export function isFamilyOfficeLine(lineId: string): boolean {
  return FAMILY_OFFICE_LINES.some((line) => line.id === lineId);
}

function familyOfficeLine(lineId: string): UpgradeLineDef {
  const line = FAMILY_OFFICE_LINES.find((candidate) => candidate.id === lineId);
  if (line === undefined) {
    throw new ApiFailure('not_found', `${lineId} is not a Family Office upgrade.`);
  }
  return line;
}

interface AscensionRow extends Record<string, SqlStorageValue> {
  readonly venue_id: string;
  readonly ledger_seq: number;
}

function ascendedRows(sql: SqlStorage): AscensionRow[] {
  return sql
    .exec<AscensionRow>('SELECT venue_id, ledger_seq FROM ascensions ORDER BY seq')
    .toArray();
}

function finalVenue(): VenueDef {
  const last = ORDERED_VENUES.at(-1);
  if (last === undefined) throw new Error('Economy config lists no venues.');
  return last;
}

/**
 * The venue the player is pushing toward: the first one, in unlock order, not yet ascended.
 * Once every venue is ascended the final venue stays current and starts anew on each ascension.
 */
export function currentVenue(sql: SqlStorage): VenueDef {
  const ascended = new Set(ascendedRows(sql).map((row) => row.venue_id));
  return ORDERED_VENUES.find((venue) => !ascended.has(venue.id)) ?? finalVenue();
}

/** Venues the player can open: every one ascended plus the current one. */
export function unlockedVenues(sql: SqlStorage): VenueId[] {
  const ascended = new Set(ascendedRows(sql).map((row) => row.venue_id));
  const current = currentVenue(sql);
  return ORDERED_VENUES.filter((venue) => venue === current || ascended.has(venue.id)).map(
    (venue) => VenueIdSchema.parse(venue.id),
  );
}

/** Bullion earned at the current venue, from the ledger's winnings since the last ascension. */
export function lifetimeBullion(sql: SqlStorage): number {
  const since = ascendedRows(sql).at(-1)?.ledger_seq ?? 0;
  const row = sql
    .exec<{ total: number | null }>(
      `SELECT SUM(delta) AS total FROM ledger
       WHERE kind = ? AND account = 'wallet' AND unit = 'coins' AND delta > 0 AND seq > ?`,
      WINNINGS_KIND,
      since,
    )
    .one();
  return bullionFromValue(row.total ?? 0, bullion);
}

export function readFamilyOfficeLevels(sql: SqlStorage): UpgradeLevels {
  const levels: Record<string, number> = Object.fromEntries(
    FAMILY_OFFICE_LINES.map((line) => [line.id, 0]),
  );
  for (const row of sql.exec<{ line_id: string; level: number }>(
    'SELECT line_id, level FROM family_office_levels',
  )) {
    if (isFamilyOfficeLine(row.line_id)) levels[row.line_id] = row.level;
  }
  return levels;
}

/** The stat a Family Office line grants at its stored level, e.g. `startingCoins`. */
export function familyOfficeEffect(
  levels: Readonly<Record<string, number>>,
  stat: UpgradeStatId,
): number {
  const line = FAMILY_OFFICE_LINES.find((candidate) => candidate.effect.stat === stat);
  if (line === undefined) throw new Error(`No Family Office line grants the ${stat} stat.`);
  return upgradeStat(line, Math.min(levels[line.id] ?? 0, line.maxLevel));
}

export interface AscensionQuote {
  readonly venue: VenueDef;
  readonly next: VenueDef | null;
  readonly lifetimeBullion: number;
  readonly goldBars: number;
  readonly startingCoins: number;
}

/**
 * Decides from server state alone whether the player may ascend `body.venueId`. The client
 * names only the venue; Bullion, the threshold and the Gold Bars all come from the ledger and
 * economy config, so a replayed or forged request cannot ascend twice or early.
 */
export function quoteAscension(sql: SqlStorage, body: AscendRequest): AscensionQuote {
  const venue = currentVenue(sql);
  if (body.venueId !== venue.id) {
    const ascended = ascendedRows(sql).some((row) => row.venue_id === body.venueId);
    throw new ApiFailure(
      ascended ? 'conflict' : 'forbidden',
      ascended
        ? `${body.venueId} is already ascended; the current venue is ${venue.id}. Refresh state.`
        : `${body.venueId} is not unlocked yet; ascend ${venue.id} first.`,
    );
  }
  const earned = lifetimeBullion(sql);
  if (earned < venue.bullionThreshold) {
    throw new ApiFailure(
      'not_ready',
      `Ascending ${venue.id} needs ${venue.bullionThreshold} Bullion; ${earned} earned so far.`,
    );
  }
  return {
    venue,
    next: ORDERED_VENUES.find((candidate) => candidate.order === venue.order + 1) ?? null,
    lifetimeBullion: earned,
    goldBars: ascensionGoldBars(earned, venue.bullionThreshold, ascension),
    startingCoins: Math.floor(familyOfficeEffect(readFamilyOfficeLevels(sql), 'startingCoins')),
  };
}

function move(
  from: Leg['account'],
  to: Leg['account'],
  unit: Currency,
  amount: number,
  ref: string,
): Leg[] {
  if (amount === 0) return [];
  return [
    { account: from, unit, delta: -amount, ref },
    { account: to, unit, delta: amount, ref },
  ];
}

/**
 * The ascension's legs: balanced per currency, wallet balances never go negative.
 * TODO(economy-designer, lead-architect): grant the 1,000 Repute an ascension earns (02-ECONOMY)
 * here once economy config defines the award and the ledger has a Repute unit.
 */
export function ascensionLegs(quote: AscensionQuote, wallet: Wallet): Leg[] {
  const ref = quote.venue.id;
  return [
    ...RESETTING_CURRENCIES.flatMap((currency) =>
      move('wallet', 'house', currency, wallet[currency], ref),
    ),
    ...move('mint', 'wallet', 'goldBars', quote.goldBars, ref),
    ...move('mint', 'wallet', 'coins', quote.startingCoins, ref),
  ];
}

/** Commits one balanced transaction of `kind`; PlayerDO wraps `LedgerTx` + `commit`. */
export type AscensionCommit = (kind: typeof ASCEND_TX_KIND, legs: readonly Leg[]) => void;

export interface AscensionResult {
  readonly venueId: VenueId;
  readonly goldBarsGranted: number;
  readonly unlockedVenueId: VenueId | null;
}

/**
 * Ascends the current venue inside the caller's storage transaction: checks eligibility,
 * resets the venue's currencies and upgrade tree, credits the Gold Bars and the Trust Fund's
 * starting coins, and records the ascension so the next venue's Bullion starts from zero.
 * Family Office levels and Gold Bars carry over. Coins on the table and in the prepaid drop
 * buffer are the host's to settle afterwards (P-197).
 */
export function applyAscension(
  sql: SqlStorage,
  body: AscendRequest,
  post: AscensionCommit,
  at: number,
): AscensionResult {
  const quote = quoteAscension(sql, body);
  post(ASCEND_TX_KIND, ascensionLegs(quote, readWallet(sql)));
  sql.exec('DELETE FROM upgrade_levels WHERE venue_id = ?', quote.venue.id);
  const seq = sql.exec<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM ledger').one().seq;
  sql.exec(
    `INSERT INTO ascensions (venue_id, ledger_seq, lifetime_bullion, gold_bars, at)
     VALUES (?, ?, ?, ?, ?)`,
    quote.venue.id,
    seq ?? 0,
    quote.lifetimeBullion,
    quote.goldBars,
    at,
  );
  return {
    venueId: VenueIdSchema.parse(quote.venue.id),
    goldBarsGranted: quote.goldBars,
    unlockedVenueId: quote.next === null ? null : VenueIdSchema.parse(quote.next.id),
  };
}

export interface FamilyOfficeQuote {
  readonly lineId: string;
  /** The level being bought. */
  readonly level: number;
  readonly cost: number;
}

/**
 * Prices a Family Office level from economy config against the stored level and the Gold
 * Bars in the wallet. Like venue upgrades the client names only the level it expects, so a
 * stale or replayed tap for a level already owned gets `conflict` instead of paying twice.
 */
export function quoteFamilyOffice(
  levels: Readonly<Record<string, number>>,
  wallet: Wallet,
  body: UpgradeBuyRequest,
): FamilyOfficeQuote {
  const line = familyOfficeLine(body.lineId);
  const current = levels[line.id] ?? 0;
  if (current >= line.maxLevel) {
    throw new ApiFailure(
      'conflict',
      `${line.id} is already at its maximum level ${line.maxLevel}.`,
    );
  }
  if (body.level !== current + 1) {
    throw new ApiFailure(
      'conflict',
      `${line.id} is at level ${current}; request level ${current + 1}. Refresh state and retry.`,
    );
  }
  const cost = upgradeCost(line, current);
  if (wallet.goldBars < cost) {
    throw new ApiFailure(
      'insufficient_funds',
      `${line.id} level ${body.level} costs ${cost} Gold Bars; the wallet holds ${wallet.goldBars}.`,
    );
  }
  return { lineId: line.id, level: body.level, cost };
}

/**
 * Buys a Family Office level inside the caller's storage transaction: the Gold Bars go to the
 * house and the level is stored for every venue from now on.
 */
export function buyFamilyOffice(
  sql: SqlStorage,
  body: UpgradeBuyRequest,
  context: CommitContext,
): UpgradeBuyResponse {
  const quote = quoteFamilyOffice(readFamilyOfficeLevels(sql), readWallet(sql), body);
  commit(
    sql,
    new LedgerTx(UPGRADE_TX_KIND).move('wallet', 'house', 'goldBars', quote.cost, quote.lineId),
    context,
  );
  sql.exec(
    `INSERT INTO family_office_levels (line_id, level) VALUES (?, ?)
     ON CONFLICT (line_id) DO UPDATE SET level = excluded.level`,
    quote.lineId,
    quote.level,
  );
  return {
    venueId: body.venueId,
    lineId: body.lineId,
    level: quote.level,
    wallet: readWallet(sql),
  };
}

export interface AscendHost {
  ascend(command: Command<AscendRequest>): Promise<DoResult<AscendResponse>>;
}

export type AscendHostResolver = (env: Env, playerId: PlayerId) => AscendHost;

/** The client sends only the venue it is leaving and an Idempotency-Key. */
export function createAscendRoutes(resolveHost: AscendHostResolver): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.post(endpoints.ascend.path, async (c) => {
    const request = await authenticate(c);
    const body = parseBody(endpoints.ascend.body, request.rawBody);
    const result = await resolveHost(c.env, request.grant.playerId).ascend({
      idempotencyKey: requireIdempotencyKey(request),
      fingerprint: fingerprint(request),
      body,
    });
    return respond(c, endpoints.ascend.response, result);
  });
  return routes;
}
