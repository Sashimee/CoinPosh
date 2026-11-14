import {
  album,
  crateIncomeCoins,
  crateRewards,
  crateSpawn,
  dropTables,
  offlineRate,
  pity,
  rollDrop,
  safes,
  type CrateRewardDef,
  type DropTableDef,
  type PityState,
  type RarityId,
  type Rng,
} from '@coinposh/economy';
import {
  CollectibleIdSchema,
  CrateIdSchema,
  endpoints,
  type CrateId,
  type CrateKind,
  type CrateOpenRequest,
  type CrateOpenResponse,
  type Currency,
  type DropSourceId,
  type PityCounters,
  type PlayerId,
  type Reward,
  type Roll,
} from '@coinposh/shared';
import { Hono } from 'hono';
import type { Command, DoResult } from '../do/PlayerDO.ts';
import {
  commit,
  ConservationError,
  LedgerTx,
  type CommitContext,
  type TxKind,
} from '../do/ledger.ts';
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
import { grantSafe, readPity } from './safes.ts';

/**
 * PlayerDO table recording each crate open. The primary key is the crate, so a crate opens at
 * most once even if every other check were bypassed, and the triggers keep the record final.
 * What the roll drew is kept for audit and for the album (T-3.03), which counts owned cards
 * from `collectible_id`.
 */
export const CRATES_SQL = `
  CREATE TABLE IF NOT EXISTS crate_opens (
    crate_id       TEXT PRIMARY KEY REFERENCES crates (id),
    opened_at      INTEGER NOT NULL CHECK (opened_at >= 0),
    rarity         TEXT NOT NULL,
    scripted       INTEGER NOT NULL CHECK (scripted IN (0, 1)),
    charm_type     TEXT,
    collectible_id TEXT,
    safe_id        TEXT UNIQUE
  );
  CREATE INDEX IF NOT EXISTS crate_opens_collectible ON crate_opens (collectible_id);

  CREATE TRIGGER IF NOT EXISTS crate_opens_no_update BEFORE UPDATE ON crate_opens
  BEGIN
    SELECT RAISE(ABORT, 'a crate opens once and its record is final');
  END;

  CREATE TRIGGER IF NOT EXISTS crate_opens_no_delete BEFORE DELETE ON crate_opens
  BEGIN
    SELECT RAISE(ABORT, 'crate_opens is append-only');
  END;
`;

/**
 * The crate leaves the inventory for the house, the mint pays its currencies to the wallet and
 * mints its album card into the inventory (`collectible`, ref = the card's id).
 */
export const CRATE_OPEN_TX_KIND = 'crate.open' satisfies TxKind;

export const CRATE_DROP_SOURCES = {
  vault: 'vaultCrate',
} as const satisfies Record<CrateKind, DropSourceId>;

/** Basis points: `charmChance` and `safeChance` are drawn as `rng.nextInt(BP) < chance`. */
const BP = 10_000;

interface AlbumItem {
  readonly id: string;
  readonly rarity: RarityId;
}

const ALBUM_ITEMS: readonly AlbumItem[] = album.flatMap((set): readonly AlbumItem[] => set.items);
/** Charm kinds are the album's charm entries until economy grows a charm drop catalog, as in Demo. */
export const CRATE_CHARM_TYPES: readonly string[] = ALBUM_ITEMS.filter((item) =>
  item.id.endsWith('Charm'),
).map((item) => item.id);
export const ALBUM_CARDS: readonly AlbumItem[] = ALBUM_ITEMS.filter(
  (item) => !item.id.endsWith('Charm'),
);

export interface CrateDraw {
  readonly rarity: RarityId;
  readonly pity: PityState;
  readonly charmType: string | null;
  readonly collectibleId: string | null;
  readonly safe: boolean;
}

/**
 * Everything a crate holds, drawn from one fair roll's stream in the order Demo draws it
 * (apps/web/src/net/mock/world.ts #grant): rarity on the drop table with pity, the charm
 * chance and then its kind, the album card of that rarity, and last the safe chance, which
 * only `safes.crateDrop.source` opens roll. Appending the safe keeps every earlier draw where
 * Demo already makes it. The scripted first-session crate skips the rarity and charm-chance
 * draws: its rarity and charm come from `crateSpawn`, and its pity counters stay untouched.
 */
export function drawCrate(
  table: DropTableDef,
  pityState: PityState,
  rng: Rng,
  scripted: boolean,
): CrateDraw {
  const drawn = scripted
    ? { rarity: crateSpawn.ftueScriptedRarity, state: pityState }
    : rollDrop(table, pity, pityState, rng);
  const reward: CrateRewardDef = crateRewards[drawn.rarity];

  let charmType: string | null = null;
  const forceCharm = scripted && crateSpawn.ftueScriptedCharm;
  if (CRATE_CHARM_TYPES.length > 0 && (forceCharm || rng.nextInt(BP) < reward.charmChance)) {
    charmType = CRATE_CHARM_TYPES[rng.nextInt(CRATE_CHARM_TYPES.length)] ?? null;
  }

  let collectibleId: string | null = null;
  if (reward.albumCard) {
    const cards = ALBUM_CARDS.filter((item) => item.rarity === drawn.rarity);
    collectibleId = cards[cards.length > 0 ? rng.nextInt(cards.length) : 0]?.id ?? null;
  }

  const safe = table.source === safes.crateDrop.source && rng.nextInt(BP) < reward.safeChance;
  return { rarity: drawn.rarity, pity: drawn.state, charmType, collectibleId, safe };
}

function dropTable(source: DropSourceId): DropTableDef {
  const table = dropTables.find((candidate) => candidate.source === source);
  if (table === undefined) throw new Error(`Economy config has no "${source}" drop table.`);
  return table;
}

/** Same `pity_counters` rows the safes and scratch routes keep, under the crate's source. */
function writeCratePity(sql: SqlStorage, source: DropSourceId, state: PityState): void {
  for (const rule of pity.rules) {
    sql.exec(
      `INSERT INTO pity_counters (source, rarity, misses) VALUES (?, ?, ?)
       ON CONFLICT (source, rarity) DO UPDATE SET misses = excluded.misses`,
      source,
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

interface CrateRow extends Record<string, SqlStorageValue> {
  readonly id: string;
  readonly kind: CrateKind;
  readonly state: 'table' | 'claimed' | 'lost';
  readonly opened: number;
  readonly held: number;
}

/**
 * The crate as the ledger and the crates table both see it. Only a crate that `claim.crate`
 * moved into the inventory and that no open has moved out again may open; a held crate the
 * ledger does not agree on is a broken invariant, not a player error.
 */
function heldCrate(sql: SqlStorage, crateId: CrateId): CrateRow {
  const row = sql
    .exec<CrateRow>(
      `SELECT crates.id AS id, crates.kind AS kind, crates.state AS state,
              EXISTS (SELECT 1 FROM crate_opens WHERE crate_id = crates.id) AS opened,
              (SELECT COALESCE(SUM(delta), 0) FROM ledger
                WHERE ref = crates.id AND account = 'inventory' AND unit = 'crate') AS held
       FROM crates WHERE crates.id = ?`,
      crateId,
    )
    .toArray()[0];
  if (row === undefined) {
    throw new ApiFailure('not_found', 'No crate with that ID belongs to this account.');
  }
  if (row.opened !== 0) {
    throw new ApiFailure('conflict', 'That crate is already open. Refresh state.');
  }
  if (row.state === 'table') {
    throw new ApiFailure(
      'not_ready',
      'That crate is still on the table. Push it off the front edge to claim it, then open it.',
    );
  }
  if (row.state === 'lost') {
    throw new ApiFailure(
      'conflict',
      'That crate fell off the side and went to the house, so it cannot be opened.',
    );
  }
  if (row.held !== 1) {
    throw new ConservationError(
      `Crate ${row.id} is claimed but the ledger holds ${row.held} of it in the inventory.`,
    );
  }
  return row;
}

/**
 * Opens one crate inside the caller's storage transaction. The client names only the crate:
 * the contents are a provably fair roll on the crate's drop table with its pity counters,
 * paid as that rarity's `crateRewards` currencies plus its album card, and a Gold Safe when
 * the roll's safe chance hits. `scripted` marks the first-session crate whose rarity and
 * charm `crateSpawn` fixes. Charms are drawn and recorded but not granted until the server
 * keeps a charm inventory.
 */
export function openCrate(
  sql: SqlStorage,
  fair: FairSeeds,
  body: CrateOpenRequest,
  context: CommitContext,
  scripted: boolean,
): Omit<CrateOpenResponse, 'wallet'> {
  const row = heldCrate(sql, body.crateId);
  const source = CRATE_DROP_SOURCES[row.kind];
  const roll = fair.roll(`crate.${source}`, row.id, context.at);
  const drawn = drawCrate(dropTable(source), readPity(sql, source), roll.rng, scripted);
  writeCratePity(sql, source, drawn.pity);

  const reward = crateRewards[drawn.rarity];
  const payout: [Currency, number][] = [
    ['coins', crateIncomeCoins(reward.incomeSeconds, measuredActiveRate(sql), offlineRate)],
    ['pearls', reward.pearls],
    ['keys', reward.keys],
    ['tickets', reward.tickets],
  ];
  const tx = new LedgerTx(CRATE_OPEN_TX_KIND).move('inventory', 'house', 'crate', 1, row.id);
  const rewards: Reward[] = [];
  for (const [currency, amount] of payout) {
    if (amount <= 0) continue;
    tx.move('mint', 'wallet', currency, amount, row.id);
    rewards.push({ kind: 'currency', currency, amount });
  }
  if (drawn.collectibleId !== null) {
    const collectibleId = CollectibleIdSchema.parse(drawn.collectibleId);
    tx.move('mint', 'inventory', 'collectible', 1, collectibleId);
    rewards.push({ kind: 'collectible', collectibleId });
  }
  commit(sql, tx, context);

  let safeId: string | null = null;
  if (drawn.safe) {
    const safe = grantSafe(sql, { type: safes.crateDrop.type, source: `crate:${row.id}` }, context);
    safeId = safe.id;
    rewards.push({ kind: 'safe', safe });
  }

  sql.exec(
    `INSERT INTO crate_opens (crate_id, opened_at, rarity, scripted, charm_type, collectible_id, safe_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    row.id,
    context.at,
    drawn.rarity,
    scripted ? 1 : 0,
    drawn.charmType,
    drawn.collectibleId,
    safeId,
  );

  const result: Roll = {
    rarity: drawn.rarity,
    rewards,
    proof: { serverSeedHash: roll.serverSeedHash, clientSeed: roll.clientSeed, nonce: roll.nonce },
    pity: pityCounters(drawn.pity),
  };
  return { crateId: CrateIdSchema.parse(row.id), roll: result };
}

/** Claimed crates no open has taken out of the inventory yet. */
export function countHeldCrates(sql: SqlStorage): number {
  return sql
    .exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM crates
       WHERE state = 'claimed' AND id NOT IN (SELECT crate_id FROM crate_opens)`,
    )
    .one().n;
}

/** Album cards crate opens have granted, one per open that drew a card. */
export function countCollectiblesGranted(sql: SqlStorage): number {
  return sql
    .exec<{ n: number }>('SELECT COUNT(*) AS n FROM crate_opens WHERE collectible_id IS NOT NULL')
    .one().n;
}

export interface CrateHost {
  openCrate(command: Command<CrateOpenRequest>): Promise<DoResult<CrateOpenResponse>>;
}

export type CrateHostResolver = (env: Env, playerId: PlayerId) => CrateHost;

/** The client sends only the crate and an Idempotency-Key. */
export function createCrateRoutes(resolveHost: CrateHostResolver): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.post(endpoints.cratesOpen.path, async (c) => {
    const request = await authenticate(c);
    const body = parseBody(endpoints.cratesOpen.body, request.rawBody);
    const result = await resolveHost(c.env, request.grant.playerId).openCrate({
      idempotencyKey: requireIdempotencyKey(request),
      fingerprint: fingerprint(request),
      body,
    });
    return respond(c, endpoints.cratesOpen.response, result);
  });
  return routes;
}
