import {
  upgradeCost,
  upgradeLines,
  upgradeStat,
  type UpgradeLineDef,
  type UpgradeStatId,
} from '@coinposh/economy';
import {
  endpoints,
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
import { HOME_VENUE } from '../do/entities.ts';
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

/** The slice's upgrade tree; the other venue lines unlock with later mechanics. */
export const UPGRADE_LINE_IDS_V1 = [
  'pusherSpeed',
  'dropRate',
  'coinValue',
  'crateChance',
  'vaultCapacity',
  'offlineHours',
] as const;
export type UpgradeLineIdV1 = (typeof UPGRADE_LINE_IDS_V1)[number];

function venueLine(id: UpgradeLineIdV1): UpgradeLineDef {
  const line = upgradeLines.find((candidate) => candidate.id === id);
  if (line?.scope !== 'venue') {
    throw new Error(`Upgrade line "${id}" must be a venue line in packages/economy upgradeLines.`);
  }
  return line;
}

export const UPGRADE_LINES_V1: readonly UpgradeLineDef[] = UPGRADE_LINE_IDS_V1.map(venueLine);

/** The ledger kind for a purchase: the price moves wallet → house and is never refunded. */
export const UPGRADE_TX_KIND = 'upgrade.buy';

export const UPGRADE_LEVELS_SQL = `
  CREATE TABLE IF NOT EXISTS upgrade_levels (
    venue_id TEXT NOT NULL,
    line_id  TEXT NOT NULL,
    level    INTEGER NOT NULL CHECK (level >= 0),
    PRIMARY KEY (venue_id, line_id)
  );
`;

export interface UpgradeQuote {
  readonly venueId: VenueId;
  readonly lineId: UpgradeLineIdV1;
  /** The level being bought. */
  readonly level: number;
  readonly currency: Extract<Currency, 'coins' | 'goldBars'>;
  readonly cost: number;
}

function isLineV1(lineId: string): lineId is UpgradeLineIdV1 {
  return (UPGRADE_LINE_IDS_V1 as readonly string[]).includes(lineId);
}

function lineFor(lineId: UpgradeLineIdV1): UpgradeLineDef {
  const line = UPGRADE_LINES_V1.find((candidate) => candidate.id === lineId);
  if (line === undefined) throw new Error(`Upgrade line "${lineId}" is missing from the v1 tree.`);
  return line;
}

export function readUpgradeLevels(sql: SqlStorage, venueId: VenueId): UpgradeLevels {
  const levels: Record<string, number> = Object.fromEntries(
    UPGRADE_LINE_IDS_V1.map((id) => [id, 0]),
  );
  for (const row of sql.exec<{ line_id: string; level: number }>(
    'SELECT line_id, level FROM upgrade_levels WHERE venue_id = ?',
    venueId,
  )) {
    if (isLineV1(row.line_id)) levels[row.line_id] = row.level;
  }
  return levels;
}

/**
 * Prices `body` from economy config against the player's real levels and wallet. The client
 * names only the line and the level it expects to reach, so a stale or replayed tap that
 * asks for a level already owned gets `conflict` instead of paying twice.
 */
export function quoteUpgrade(
  levels: Readonly<Record<string, number>>,
  wallet: Wallet,
  body: UpgradeBuyRequest,
): UpgradeQuote {
  if (body.venueId !== HOME_VENUE.id) {
    throw new ApiFailure('forbidden', `Venue ${body.venueId} is not unlocked yet.`);
  }
  if (!isLineV1(body.lineId)) {
    throw new ApiFailure('not_found', `Upgrade line ${body.lineId} is not available.`);
  }
  const line = lineFor(body.lineId);
  const current = levels[body.lineId] ?? 0;
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
  if (wallet[line.currency] < cost) {
    throw new ApiFailure(
      'insufficient_funds',
      `${line.id} level ${body.level} costs ${cost} ${line.currency}; the wallet holds ${wallet[line.currency]}.`,
    );
  }
  return {
    venueId: body.venueId,
    lineId: body.lineId,
    level: body.level,
    currency: line.currency,
    cost,
  };
}

/** Stores the bought level; call it in the same storage transaction as the ledger spend. */
export function recordUpgrade(sql: SqlStorage, quote: UpgradeQuote): void {
  sql.exec(
    `INSERT INTO upgrade_levels (venue_id, line_id, level) VALUES (?, ?, ?)
     ON CONFLICT (venue_id, line_id) DO UPDATE SET level = excluded.level`,
    quote.venueId,
    quote.lineId,
    quote.level,
  );
}

/** The stat a v1 line grants at the stored level, e.g. `offlineHours` → cap in hours. */
export function upgradeEffect(
  levels: Readonly<Record<string, number>>,
  stat: UpgradeStatId,
): number {
  const line = UPGRADE_LINES_V1.find((candidate) => candidate.effect.stat === stat);
  if (line === undefined) throw new Error(`No v1 upgrade line grants the ${stat} stat.`);
  return upgradeStat(line, Math.min(levels[line.id] ?? 0, line.maxLevel));
}

export interface UpgradeHost {
  buyUpgrade(command: Command<UpgradeBuyRequest>): Promise<DoResult<UpgradeBuyResponse>>;
}

export type UpgradeHostResolver = (env: Env, playerId: PlayerId) => UpgradeHost;

/** The client sends only the line, the level it expects and an Idempotency-Key. */
export function createUpgradeRoutes(resolveHost: UpgradeHostResolver): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.post(endpoints.upgradesBuy.path, async (c) => {
    const request = await authenticate(c);
    const body = parseBody(endpoints.upgradesBuy.body, request.rawBody);
    const result = await resolveHost(c.env, request.grant.playerId).buyUpgrade({
      idempotencyKey: requireIdempotencyKey(request),
      fingerprint: fingerprint(request),
      body,
    });
    return respond(c, endpoints.upgradesBuy.response, result);
  });
  return routes;
}
