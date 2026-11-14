import {
  crateIncomeCoins,
  crateRewards,
  dropTables,
  offlineRate,
  pity,
  rollDrop,
  type DropTableDef,
  type PityState,
  type Rng,
} from '@coinposh/economy';
import {
  endpoints,
  RARITY_IDS,
  SCRATCH_GRID_SIZE,
  ScratchCardIdSchema,
  type Currency,
  type DropSourceId,
  type PityCounters,
  type PlayerId,
  type Rarity,
  type Reward,
  type Roll,
  type ScratchCardId,
  type ScratchRevealRequest,
  type ScratchRevealResponse,
} from '@coinposh/shared';
import { Hono } from 'hono';
import { newScratchCardId } from '../do/entities.ts';
import type { Command, DoResult } from '../do/PlayerDO.ts';
import { commit, LedgerTx, readWallet, type CommitContext, type TxKind } from '../do/ledger.ts';
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
import type { FairSeeds } from '../rng/fair.ts';
import { measuredActiveRate } from './offline.ts';
import { readPity } from './safes.ts';

/**
 * PlayerDO table for scratch cards. A card is granted `held` and revealed exactly once: the
 * trigger refuses any other change, so a bug elsewhere cannot un-reveal a card, rewrite its
 * grid or reveal it twice. The grid is kept so the reveal can be audited against its roll.
 */
export const SCRATCH_SQL = `
  CREATE TABLE IF NOT EXISTS scratch_cards (
    id          TEXT PRIMARY KEY,
    state       TEXT NOT NULL CHECK (state IN ('held', 'revealed')),
    source      TEXT NOT NULL,
    granted_at  INTEGER NOT NULL CHECK (granted_at >= 0),
    revealed_at INTEGER CHECK (revealed_at >= granted_at),
    rarity      TEXT,
    grid        TEXT,
    CHECK ((state = 'held') = (revealed_at IS NULL AND rarity IS NULL AND grid IS NULL)),
    CHECK ((state = 'revealed') = (revealed_at IS NOT NULL AND rarity IS NOT NULL AND grid IS NOT NULL))
  );
  CREATE INDEX IF NOT EXISTS scratch_cards_state ON scratch_cards (state, granted_at);

  CREATE TRIGGER IF NOT EXISTS scratch_cards_reveal_once BEFORE UPDATE ON scratch_cards
  WHEN OLD.state IS NOT 'held'
    OR NEW.state IS NOT 'revealed'
    OR NEW.id IS NOT OLD.id
    OR NEW.source IS NOT OLD.source
    OR NEW.granted_at IS NOT OLD.granted_at
  BEGIN
    SELECT RAISE(ABORT, 'a scratch card reveals once and its grant is fixed');
  END;

  CREATE TRIGGER IF NOT EXISTS scratch_cards_no_delete BEFORE DELETE ON scratch_cards
  BEGIN
    SELECT RAISE(ABORT, 'scratch_cards is append-only');
  END;
`;

/** A card enters the inventory as new value: one `scratchCard` unit moves mint → inventory. */
export const SCRATCH_GRANT_TX_KIND = 'scratch.grant' satisfies TxKind;
/** The card leaves the inventory for the house and the mint pays its match to the wallet. */
export const SCRATCH_REVEAL_TX_KIND = 'scratch.reveal' satisfies TxKind;
export const SCRATCH_DROP_SOURCE = 'scratch' satisfies DropSourceId;
/** How many of the rolled rarity the grid shows; every other rarity shows fewer. */
export const SCRATCH_MATCH = 3;

interface ScratchCardRow extends Record<string, SqlStorageValue> {
  readonly id: string;
  readonly state: 'held' | 'revealed';
}

export interface ScratchCardGrant {
  /** What granted it, e.g. `quest:<id>` or `goldenHour:<id>`; kept for audit, never shown. */
  readonly source: string;
}

/** Grants one scratch card inside the caller's storage transaction, stamped on the DO clock. */
export function grantScratchCard(
  sql: SqlStorage,
  grant: ScratchCardGrant,
  context: CommitContext,
): ScratchCardId {
  if (grant.source.length === 0) {
    throw new Error('grantScratchCard: name the source that granted the card.');
  }
  const id = newScratchCardId();
  sql.exec(
    "INSERT INTO scratch_cards (id, state, source, granted_at) VALUES (?, 'held', ?, ?)",
    id,
    grant.source,
    context.at,
  );
  commit(
    sql,
    new LedgerTx(SCRATCH_GRANT_TX_KIND).move('mint', 'inventory', 'scratchCard', 1, id),
    context,
  );
  return id;
}

/** The cards the player holds unrevealed, oldest first, as `GET /v1/state` lists them. */
export function readScratchCards(sql: SqlStorage): ScratchCardId[] {
  return sql
    .exec<{ id: string }>(
      "SELECT id FROM scratch_cards WHERE state = 'held' ORDER BY granted_at, rowid",
    )
    .toArray()
    .map((row) => ScratchCardIdSchema.parse(row.id));
}

export function countHeldScratchCards(sql: SqlStorage): number {
  return sql
    .exec<{ n: number }>("SELECT COUNT(*) AS n FROM scratch_cards WHERE state = 'held'")
    .one().n;
}

/**
 * Lays the 3×3 grid from the roll's own stream: exactly `SCRATCH_MATCH` of the winning rarity
 * and every other rarity at most `SCRATCH_MATCH - 1` times, shuffled, so the only match on the
 * card is the one the roll paid. Losing gems may be rarer than the win: the near miss is the tease.
 */
export function scratchGrid(winner: Rarity, rng: Rng): Rarity[] {
  const grid: Rarity[] = Array.from({ length: SCRATCH_MATCH }, () => winner);
  const fillers = RARITY_IDS.filter((rarity) => rarity !== winner).flatMap((rarity) =>
    Array.from({ length: SCRATCH_MATCH - 1 }, () => rarity),
  );
  while (grid.length < SCRATCH_GRID_SIZE) {
    const [picked] = fillers.splice(rng.nextInt(fillers.length), 1);
    if (picked === undefined) throw new Error('scratchGrid: ran out of filler gems.');
    grid.push(picked);
  }
  for (let i = grid.length - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    const a = grid[i];
    const b = grid[j];
    if (a === undefined || b === undefined) throw new Error('scratchGrid: shuffle out of range.');
    grid[i] = b;
    grid[j] = a;
  }
  return grid;
}

function scratchTable(): DropTableDef {
  const table = dropTables.find((candidate) => candidate.source === SCRATCH_DROP_SOURCE);
  if (table === undefined) {
    throw new Error(`Economy config has no "${SCRATCH_DROP_SOURCE}" drop table.`);
  }
  return table;
}

/** Same `pity_counters` rows the safes route keeps, under the `scratch` source. */
function writeScratchPity(sql: SqlStorage, state: PityState): void {
  for (const rule of pity.rules) {
    sql.exec(
      `INSERT INTO pity_counters (source, rarity, misses) VALUES (?, ?, ?)
       ON CONFLICT (source, rarity) DO UPDATE SET misses = excluded.misses`,
      SCRATCH_DROP_SOURCE,
      rule.rarity,
      state[rule.rarity] ?? 0,
    );
  }
}

function pityCounters(state: PityState): PityCounters {
  return {
    rare: state.rare ?? 0,
    exquisite: state.exquisite ?? 0,
    legendary: state.legendary ?? 0,
  };
}

function heldCard(sql: SqlStorage, cardId: ScratchCardId): ScratchCardRow {
  const row = sql
    .exec<ScratchCardRow>('SELECT id, state FROM scratch_cards WHERE id = ?', cardId)
    .toArray()[0];
  if (row === undefined) {
    throw new ApiFailure('not_found', 'No scratch card with that ID belongs to this account.');
  }
  if (row.state !== 'held') {
    throw new ApiFailure('conflict', 'That scratch card is already revealed. Refresh state.');
  }
  return row;
}

/**
 * Reveals one card inside the caller's storage transaction. The client names only the card:
 * the result is a provably fair roll on the `scratch` drop table with its pity counters, paid
 * as that rarity's `crateRewards` currencies, and the grid is drawn from the same roll stream
 * so anyone holding the revealed seed can rebuild the card.
 */
export function revealScratchCard(
  sql: SqlStorage,
  fair: FairSeeds,
  body: ScratchRevealRequest,
  context: CommitContext,
): ScratchRevealResponse {
  const row = heldCard(sql, body.cardId);
  const roll = fair.roll(`scratch.${SCRATCH_DROP_SOURCE}`, row.id, context.at);
  const drawn = rollDrop(scratchTable(), pity, readPity(sql, SCRATCH_DROP_SOURCE), roll.rng);
  writeScratchPity(sql, drawn.state);
  const grid = scratchGrid(drawn.rarity, roll.rng);

  const reward = crateRewards[drawn.rarity];
  const payout: [Currency, number][] = [
    ['coins', crateIncomeCoins(reward.incomeSeconds, measuredActiveRate(sql), offlineRate)],
    ['pearls', reward.pearls],
    ['keys', reward.keys],
    ['tickets', reward.tickets],
  ];
  const tx = new LedgerTx(SCRATCH_REVEAL_TX_KIND).move(
    'inventory',
    'house',
    'scratchCard',
    1,
    row.id,
  );
  const rewards: Reward[] = [];
  for (const [currency, amount] of payout) {
    if (amount <= 0) continue;
    tx.move('mint', 'wallet', currency, amount, row.id);
    rewards.push({ kind: 'currency', currency, amount });
  }

  sql.exec(
    "UPDATE scratch_cards SET state = 'revealed', revealed_at = ?, rarity = ?, grid = ? WHERE id = ?",
    context.at,
    drawn.rarity,
    JSON.stringify(grid),
    row.id,
  );
  commit(sql, tx, context);

  const result: Roll = {
    rarity: drawn.rarity,
    rewards,
    proof: { serverSeedHash: roll.serverSeedHash, clientSeed: roll.clientSeed, nonce: roll.nonce },
    pity: pityCounters(drawn.state),
  };
  return {
    cardId: ScratchCardIdSchema.parse(row.id),
    grid,
    roll: result,
    wallet: readWallet(sql),
  };
}

export interface ScratchHost {
  revealScratch(command: Command<ScratchRevealRequest>): Promise<DoResult<ScratchRevealResponse>>;
}

export type ScratchHostResolver = (env: Env, playerId: PlayerId) => ScratchHost;

/** The client sends only the card and an Idempotency-Key. */
export function createScratchRoutes(resolveHost: ScratchHostResolver): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.post(endpoints.scratchReveal.path, async (c) => {
    const request = await authenticate(c);
    const body = parseBody(endpoints.scratchReveal.body, request.rawBody);
    const result = await resolveHost(c.env, request.grant.playerId).revealScratch({
      idempotencyKey: requireIdempotencyKey(request),
      fingerprint: fingerprint(request),
      body,
    });
    return respond(c, endpoints.scratchReveal.response, result);
  });
  return routes;
}
