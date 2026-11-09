import {
  coinTiers,
  MINT_MICROS_PER_COIN,
  mintedCoinMicros,
  mintedCoinValue,
  venues,
  type UpgradeLevelMap,
} from '@coinposh/economy';
import {
  CoinIdSchema,
  CrateIdSchema,
  ENTITY_ID_PREFIXES,
  type ClaimRejection,
  type CoinId,
  type CoinTier,
  type CrateId,
  type CrateKind,
  type EpochMs,
  type MintedCoin,
  type TableCrate,
  type Tick,
} from '@coinposh/shared';
import { randomBase62 } from '../crypto.ts';

/** 20 base62 characters ≈ 119 bits, so a forged ID cannot hit a real coin by guessing. */
const ENTITY_ID_LENGTH = 20;

export type CoinState = 'buffer' | 'table' | 'claimed' | 'lost' | 'fused' | 'refunded';
export type CrateState = 'table' | 'claimed' | 'lost';

interface CoinRow extends Record<string, SqlStorageValue> {
  id: string;
  tier: CoinTier;
  value: number;
  state: CoinState;
  dropped_tick: number | null;
  paid: number;
  mint_micros: number | null;
}

interface CrateRow extends Record<string, SqlStorageValue> {
  id: string;
  kind: CrateKind;
  state: CrateState;
  spawned_tick: number;
}

export interface StoredCoin extends MintedCoin {
  readonly state: CoinState;
  readonly droppedTick: Tick | null;
  /** What the wallet prepaid to reserve this coin in the buffer; 0 for every other coin. */
  readonly paid: number;
  /**
   * The millionths of a coin this coin drew from the player's mint carry, or null when it was
   * not minted from the carry (a fusion, or a coin stored before the carry existed).
   */
  readonly mintMicros: number | null;
}

export interface StoredCrate extends TableCrate {
  readonly state: CrateState;
  readonly spawnedTick: Tick;
}

export function newCoinId(): CoinId {
  return CoinIdSchema.parse(`${ENTITY_ID_PREFIXES.coin}_${randomBase62(ENTITY_ID_LENGTH)}`);
}

export function newCrateId(): CrateId {
  return CrateIdSchema.parse(`${ENTITY_ID_PREFIXES.crate}_${randomBase62(ENTITY_ID_LENGTH)}`);
}

export const HOME_VENUE = venues[0];

export function tierDef(tier: CoinTier) {
  const def = coinTiers.find((candidate) => candidate.id === tier);
  if (def === undefined) throw new Error(`Coin tier "${tier}" is missing from economy config.`);
  return def;
}

/** What one coin of `tier` minted at `levels` is worth on its own, before the mint carry. */
export function mintedValue(tier: CoinTier, levels: UpgradeLevelMap): number {
  return mintedCoinValue(tierDef(tier), HOME_VENUE, levels);
}

/** The millionths of a coin a coin of `tier` minted at `levels` adds to the mint carry. */
export function mintedMicros(tier: CoinTier, levels: UpgradeLevelMap): number {
  return mintedCoinMicros(tierDef(tier), HOME_VENUE, levels);
}

/** The millionths a stored coin was minted at; a coin from before the carry held its whole value. */
export function storedMicros(coin: StoredCoin): number {
  return coin.mintMicros ?? coin.value * MINT_MICROS_PER_COIN;
}

function toStoredCoin(row: CoinRow): StoredCoin {
  return {
    id: CoinIdSchema.parse(row.id),
    tier: row.tier,
    value: row.value,
    state: row.state,
    droppedTick: row.dropped_tick,
    paid: row.paid,
    mintMicros: row.mint_micros,
  };
}

function toStoredCrate(row: CrateRow): StoredCrate {
  return {
    id: CrateIdSchema.parse(row.id),
    kind: row.kind,
    state: row.state,
    spawnedTick: row.spawned_tick,
  };
}

export function publicCoin(coin: MintedCoin): MintedCoin {
  return { id: coin.id, tier: coin.tier, value: coin.value };
}

export function publicCrate(crate: TableCrate): TableCrate {
  return { id: crate.id, kind: crate.kind };
}

export class Entities {
  constructor(private readonly sql: SqlStorage) {}

  coin(id: CoinId): StoredCoin | null {
    const row = this.sql
      .exec<CoinRow>(
        'SELECT id, tier, value, state, dropped_tick, paid, mint_micros FROM coins WHERE id = ?',
        id,
      )
      .toArray()[0];
    return row === undefined ? null : toStoredCoin(row);
  }

  coinsIn(state: CoinState): StoredCoin[] {
    return this.sql
      .exec<CoinRow>(
        'SELECT id, tier, value, state, dropped_tick, paid, mint_micros FROM coins WHERE state = ? ORDER BY rowid',
        state,
      )
      .toArray()
      .map(toStoredCoin);
  }

  countCoinsIn(state: CoinState): number {
    return this.sql
      .exec<{ n: number }>('SELECT COUNT(*) AS n FROM coins WHERE state = ?', state)
      .one().n;
  }

  mintCoin(
    tier: CoinTier,
    value: number,
    mintMicros: number | null,
    state: 'buffer' | 'table',
    droppedTick: Tick | null,
    at: EpochMs,
  ): StoredCoin {
    const coin: StoredCoin = {
      id: newCoinId(),
      tier,
      value,
      state,
      droppedTick,
      paid: 0,
      mintMicros,
    };
    this.sql.exec(
      'INSERT INTO coins (id, tier, value, mint_micros, state, dropped_tick, minted_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      coin.id,
      tier,
      value,
      mintMicros,
      state,
      droppedTick,
      at,
    );
    return coin;
  }

  markPaid(id: CoinId, paid: number): void {
    this.sql.exec("UPDATE coins SET paid = ? WHERE id = ? AND state = 'buffer'", paid, id);
  }

  /**
   * Re-mints a reserved coin at `value`. A buffered coin's value is not on the ledger until it
   * is dropped (the buffer account holds only what was paid), so this moves nothing; the drop
   * then mints the difference.
   */
  repriceBuffered(id: CoinId, value: number, mintMicros: number): void {
    this.sql.exec(
      "UPDATE coins SET value = ?, mint_micros = ? WHERE id = ? AND state = 'buffer'",
      value,
      mintMicros,
      id,
    );
  }

  /** Only for a reservation nothing paid for: it holds no value and has no ledger legs. */
  discardUnpaid(id: CoinId): void {
    this.sql.exec("DELETE FROM coins WHERE id = ? AND state = 'buffer' AND paid = 0", id);
  }

  placeOnTable(id: CoinId, tick: Tick): void {
    this.sql.exec(
      "UPDATE coins SET state = 'table', dropped_tick = ? WHERE id = ? AND state = 'buffer'",
      tick,
      id,
    );
  }

  settleCoin(id: CoinId, state: 'claimed' | 'lost' | 'fused' | 'refunded', at: EpochMs): void {
    this.sql.exec(
      "UPDATE coins SET state = ?, settled_at = ? WHERE id = ? AND state = 'table'",
      state,
      at,
      id,
    );
  }

  /** A coin may only leave the table once, and never before the tick it was dropped on. */
  coinOnTable(id: CoinId, tick: Tick): StoredCoin | ClaimRejection {
    const coin = this.coin(id);
    if (coin === null) return 'unknown_entity';
    if (coin.state === 'buffer') return 'not_on_table';
    if (coin.state !== 'table') return 'already_claimed';
    if (coin.droppedTick !== null && tick < coin.droppedTick) return 'not_on_table';
    return coin;
  }

  crate(id: CrateId): StoredCrate | null {
    const row = this.sql
      .exec<CrateRow>('SELECT id, kind, state, spawned_tick FROM crates WHERE id = ?', id)
      .toArray()[0];
    return row === undefined ? null : toStoredCrate(row);
  }

  cratesOnTable(): StoredCrate[] {
    return this.sql
      .exec<CrateRow>(
        "SELECT id, kind, state, spawned_tick FROM crates WHERE state = 'table' ORDER BY rowid",
      )
      .toArray()
      .map(toStoredCrate);
  }

  spawnCrate(kind: CrateKind, tick: Tick, at: EpochMs): StoredCrate {
    const crate: StoredCrate = { id: newCrateId(), kind, state: 'table', spawnedTick: tick };
    this.sql.exec(
      'INSERT INTO crates (id, kind, state, spawned_tick, spawned_at) VALUES (?, ?, ?, ?, ?)',
      crate.id,
      kind,
      'table',
      tick,
      at,
    );
    return crate;
  }

  crateOnTable(id: CrateId, tick: Tick): StoredCrate | ClaimRejection {
    const crate = this.crate(id);
    if (crate === null) return 'unknown_entity';
    if (crate.state !== 'table') return 'already_claimed';
    if (tick < crate.spawnedTick) return 'not_on_table';
    return crate;
  }

  settleCrate(id: CrateId, state: 'claimed' | 'lost', at: EpochMs): void {
    this.sql.exec(
      "UPDATE crates SET state = ?, settled_at = ? WHERE id = ? AND state = 'table'",
      state,
      at,
      id,
    );
  }
}
