import {
  crateIncomeCoins,
  crateRewards,
  dropTables,
  offlineRate,
  pity,
  type DropTableDef,
  type PityState,
} from '@coinposh/economy';
import {
  CollectibleIdSchema,
  endpoints,
  type Currency,
  type DropSourceId,
  type GachaPullRequest,
  type GachaPullResponse,
  type PityCounters,
  type PlayerId,
  type Reward,
  type Roll,
} from '@coinposh/shared';
import { Hono } from 'hono';
import { randomBase62 } from '../crypto.ts';
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
import { drawCrate } from './crates.ts';
import { measuredActiveRate } from './offline.ts';
import { readPity } from './safes.ts';

/**
 * PlayerDO table recording every capsule a pull rolled, one row per capsule. `batch_id` groups
 * the capsules one request paid for, `fair_ref` is the `fair_rolls.ref` of the capsule's roll,
 * and what the roll drew is kept for audit and for the album, which counts owned cards from
 * `collectible_id`. The triggers keep every record final.
 */
export const GACHA_SQL = `
  CREATE TABLE IF NOT EXISTS gacha_pulls (
    id             TEXT PRIMARY KEY,
    batch_id       TEXT NOT NULL,
    idx            INTEGER NOT NULL CHECK (idx >= 0),
    pulled_at      INTEGER NOT NULL CHECK (pulled_at >= 0),
    tickets_paid   INTEGER NOT NULL CHECK (tickets_paid > 0),
    rarity         TEXT NOT NULL,
    charm_type     TEXT,
    collectible_id TEXT,
    UNIQUE (batch_id, idx)
  );
  CREATE INDEX IF NOT EXISTS gacha_pulls_collectible ON gacha_pulls (collectible_id);

  CREATE TRIGGER IF NOT EXISTS gacha_pulls_no_update BEFORE UPDATE ON gacha_pulls
  BEGIN
    SELECT RAISE(ABORT, 'a gacha pull is rolled once and its record is final');
  END;

  CREATE TRIGGER IF NOT EXISTS gacha_pulls_no_delete BEFORE DELETE ON gacha_pulls
  BEGIN
    SELECT RAISE(ABORT, 'gacha_pulls is append-only');
  END;
`;

/**
 * The pull's Tickets move wallet → house and the mint pays each capsule's currencies to the
 * wallet and mints its album card into the inventory (`collectible`, ref = the card's id).
 */
export const GACHA_PULL_TX_KIND = 'gacha.pull' satisfies TxKind;
export const GACHA_DROP_SOURCE = 'gacha' satisfies DropSourceId;
// TODO(economy): read the pull price from packages/economy once it exports one (#15); it must
// stay equal to the Demo mock's MOCK_RULES.ticketsPerPull until then.
export const GACHA_TICKETS_PER_PULL = 1;

const PULL_ID_LENGTH = 20;

function gachaTable(): DropTableDef {
  const table = dropTables.find((candidate) => candidate.source === GACHA_DROP_SOURCE);
  if (table === undefined) {
    throw new Error(`Economy config has no "${GACHA_DROP_SOURCE}" drop table.`);
  }
  return table;
}

/** Same `pity_counters` rows the safes, scratch and crate routes keep, under the `gacha` source. */
function writeGachaPity(sql: SqlStorage, state: PityState): void {
  for (const rule of pity.rules) {
    sql.exec(
      `INSERT INTO pity_counters (source, rarity, misses) VALUES (?, ?, ?)
       ON CONFLICT (source, rarity) DO UPDATE SET misses = excluded.misses`,
      GACHA_DROP_SOURCE,
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

/**
 * Pulls `count` capsules inside the caller's storage transaction. The client names only how
 * many: the price is `GACHA_TICKETS_PER_PULL` Tickets each, refused whole when the wallet holds
 * fewer, and every capsule is its own provably fair roll on the `gacha` drop table with the
 * running pity counters, drawn as a crate draws (rarity, charm, album card) and paid as that
 * rarity's `crateRewards` currencies plus its album card, as Demo pays a pull. A capsule never
 * holds a safe. Charms are drawn and recorded but not granted until the server keeps a charm
 * inventory, as crates do.
 */
export function pullGacha(
  sql: SqlStorage,
  fair: FairSeeds,
  body: GachaPullRequest,
  context: CommitContext,
): Omit<GachaPullResponse, 'wallet'> {
  const price = GACHA_TICKETS_PER_PULL * body.count;
  const held = readWallet(sql).tickets;
  if (held < price) {
    throw new ApiFailure(
      'insufficient_funds',
      `${body.count} Gacha ${body.count === 1 ? 'pull costs' : 'pulls cost'} ${price} ${price === 1 ? 'Ticket' : 'Tickets'}; the wallet holds ${held}. Earn Tickets from crates or quests, then pull again.`,
    );
  }

  const batchId = `gacha_${randomBase62(PULL_ID_LENGTH)}`;
  const tx = new LedgerTx(GACHA_PULL_TX_KIND).move('wallet', 'house', 'tickets', price, batchId);
  const table = gachaTable();
  const rate = measuredActiveRate(sql);
  let pityState = readPity(sql, GACHA_DROP_SOURCE);
  const pulls: Roll[] = [];

  for (let idx = 0; idx < body.count; idx++) {
    const pullId = `${batchId}.${idx}`;
    const roll = fair.roll(`gacha.${GACHA_DROP_SOURCE}`, pullId, context.at);
    const drawn = drawCrate(table, pityState, roll.rng, false);
    pityState = drawn.pity;

    const reward = crateRewards[drawn.rarity];
    const payout: [Currency, number][] = [
      ['coins', crateIncomeCoins(reward.incomeSeconds, rate, offlineRate)],
      ['pearls', reward.pearls],
      ['keys', reward.keys],
      ['tickets', reward.tickets],
    ];
    const rewards: Reward[] = [];
    for (const [currency, amount] of payout) {
      if (amount <= 0) continue;
      tx.move('mint', 'wallet', currency, amount, pullId);
      rewards.push({ kind: 'currency', currency, amount });
    }
    if (drawn.collectibleId !== null) {
      const collectibleId = CollectibleIdSchema.parse(drawn.collectibleId);
      tx.move('mint', 'inventory', 'collectible', 1, collectibleId);
      rewards.push({ kind: 'collectible', collectibleId });
    }

    sql.exec(
      `INSERT INTO gacha_pulls (id, batch_id, idx, pulled_at, tickets_paid, rarity, charm_type, collectible_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      pullId,
      batchId,
      idx,
      context.at,
      GACHA_TICKETS_PER_PULL,
      drawn.rarity,
      drawn.charmType,
      drawn.collectibleId,
    );
    pulls.push({
      rarity: drawn.rarity,
      rewards,
      proof: {
        serverSeedHash: roll.serverSeedHash,
        clientSeed: roll.clientSeed,
        nonce: roll.nonce,
      },
      pity: pityCounters(drawn.pity),
    });
  }

  writeGachaPity(sql, pityState);
  commit(sql, tx, context);
  return { pulls };
}

/** Album cards gacha pulls have granted, one per capsule that drew a card. */
export function countGachaCollectibles(sql: SqlStorage): number {
  return sql
    .exec<{ n: number }>('SELECT COUNT(*) AS n FROM gacha_pulls WHERE collectible_id IS NOT NULL')
    .one().n;
}

export interface GachaHost {
  pullGacha(command: Command<GachaPullRequest>): Promise<DoResult<GachaPullResponse>>;
}

export type GachaHostResolver = (env: Env, playerId: PlayerId) => GachaHost;

/** The client sends only how many capsules to pull and an Idempotency-Key. */
export function createGachaRoutes(resolveHost: GachaHostResolver): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.post(endpoints.gachaPull.path, async (c) => {
    const request = await authenticate(c);
    const body = parseBody(endpoints.gachaPull.body, request.rawBody);
    const result = await resolveHost(c.env, request.grant.playerId).pullGacha({
      idempotencyKey: requireIdempotencyKey(request),
      fingerprint: fingerprint(request),
      body,
    });
    return respond(c, endpoints.gachaPull.response, result);
  });
  return routes;
}
