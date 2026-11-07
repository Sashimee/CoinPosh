import {
  coinTiers,
  crateSpawn,
  fusion,
  fusionValue,
  upgradeLines,
  upgradeStat,
} from '@coinposh/economy';
import {
  DEFAULT_FEATURE_FLAGS,
  nextCoinTier,
  StateResponseSchema,
  type ApiError,
  type Claim,
  type ClaimResult,
  type ClaimsRequest,
  type ClaimsResponse,
  type CoinId,
  type DropRequest,
  type DropResponse,
  type EpochMs,
  type ErrorCode,
  type Locale,
  type PlayerId,
  type StateResponse,
  type TableCrate,
  type TableSnapshot,
} from '@coinposh/shared';
import { DurableObject } from 'cloudflare:workers';
import { randomBase62, randomBytes, sha256Hex } from '../crypto.ts';
import type { Env } from '../env.ts';
import { ApiFailure } from '../http/errors.ts';
import {
  Entities,
  HOME_VENUE,
  mintedValue,
  publicCoin,
  publicCrate,
  tierDef,
  type StoredCoin,
} from './entities.ts';
import { commit, ledgerBalance, LedgerTx, openWallet, readWallet } from './ledger.ts';
import { migrate } from './schema.ts';

/**
 * Coin IDs reserved ahead so play survives short network drops. A reservation holds no
 * value: the wallet pays when the coin is dropped, so the buffer never locks coins away.
 */
export const PREMINT_BUFFER_TARGET = 16;
export const FLUSH_INTERVAL_MS = 30_000;
export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;
const FLUSH_BATCH_ROWS = 100;

const DROP_TIER = coinTiers[0].id;

export interface PlayerInit {
  readonly playerId: PlayerId;
  readonly displayName: string;
  readonly locale: Locale;
  readonly createdAt: EpochMs;
}

export interface Command<B> {
  readonly idempotencyKey: string;
  /** Hash of route and body: a key reused for a different request is refused. */
  readonly fingerprint: string;
  readonly body: B;
}

export type DoResult<T> =
  | { readonly ok: true; readonly replayed: boolean; readonly body: T }
  | { readonly ok: false; readonly error: ApiError };

export interface ConservationReport {
  readonly walletCoins: number;
  readonly ledger: Readonly<Record<'wallet' | 'table' | 'house' | 'mint', number>>;
  readonly bufferCoins: number;
  readonly tableValue: number;
  readonly tableCrates: number;
  readonly ledgerCratesOnTable: number;
  readonly conserved: boolean;
}

type MetaKey =
  | 'player_id'
  | 'display_name'
  | 'locale'
  | 'created_at'
  | 'drop_count'
  | 'flushed_seq'
  | 'fair_server_seed'
  | 'fair_server_seed_hash'
  | 'fair_client_seed'
  | 'fair_nonce';

function startingCoins(): number {
  const line = upgradeLines.find((candidate) => candidate.effect.stat === 'startingCoins');
  if (line === undefined) throw new Error('Economy config has no startingCoins upgrade line.');
  return upgradeStat(line, 0);
}

export class PlayerDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly entities: Entities;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.entities = new Entities(this.sql);
    migrate(this.sql, (run) => ctx.storage.transactionSync(run));
  }

  /** Creates the table and starting grant once; calling it again is a no-op. */
  async init(input: PlayerInit): Promise<void> {
    if (this.meta('player_id') !== null) return;
    const serverSeed = Array.from(randomBytes(32), (b) => b.toString(16).padStart(2, '0')).join('');
    const serverSeedHash = await sha256Hex(serverSeed);
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      if (this.meta('player_id') !== null) return;
      this.setMeta('player_id', input.playerId);
      this.setMeta('display_name', input.displayName);
      this.setMeta('locale', input.locale);
      this.setMeta('created_at', String(input.createdAt));
      this.setMeta('drop_count', '0');
      this.setMeta('flushed_seq', '0');
      this.setMeta('fair_server_seed', serverSeed);
      this.setMeta('fair_server_seed_hash', serverSeedHash);
      this.setMeta('fair_client_seed', randomBase62(16));
      this.setMeta('fair_nonce', '0');
      openWallet(this.sql);
      commit(
        this.sql,
        new LedgerTx('grant.starting').move('mint', 'wallet', 'coins', startingCoins(), null),
        { at: now, idempotencyKey: null },
      );
      this.reserveBuffer(now);
    });
    await this.flush();
  }

  state(): DoResult<StateResponse> {
    const playerId = this.meta('player_id');
    if (playerId === null) return this.uninitialized();
    const loadout = Array.from({ length: HOME_VENUE.charmSockets }, (_, socket) => ({
      socket,
      charmId: null,
    }));
    const upgrades = Object.fromEntries(
      upgradeLines.filter((line) => line.scope === 'venue').map((line) => [line.id, 0]),
    );
    const state = {
      serverTime: Date.now(),
      player: {
        id: playerId,
        displayName: this.requireMeta('display_name'),
        locale: this.requireMeta('locale'),
        createdAt: Number(this.requireMeta('created_at')),
      },
      wallet: readWallet(this.sql),
      flags: DEFAULT_FEATURE_FLAGS,
      venue: { id: HOME_VENUE.id, unlocked: [HOME_VENUE.id], upgrades, loadout },
      table: this.snapshot(),
      inventory: { charms: [], safes: [], scratchCards: [] },
      offline: null,
      fair: {
        serverSeedHash: this.requireMeta('fair_server_seed_hash'),
        clientSeed: this.requireMeta('fair_client_seed'),
        nonce: Number(this.requireMeta('fair_nonce')),
      },
    };
    return { ok: true, replayed: false, body: StateResponseSchema.parse(state) };
  }

  async drop(command: Command<DropRequest>): Promise<DoResult<DropResponse>> {
    return this.mutate(command, (now) => this.applyDrop(command.body, command.idempotencyKey, now));
  }

  async claims(command: Command<ClaimsRequest>): Promise<DoResult<ClaimsResponse>> {
    return this.mutate(command, (now) => {
      const results = command.body.claims.map((claim) =>
        this.applyClaim(claim, command.idempotencyKey, now),
      );
      return { results, wallet: readWallet(this.sql) };
    });
  }

  /** Double-entry totals next to the entity tables they must agree with. */
  conservation(): ConservationReport {
    const ledger = {
      wallet: ledgerBalance(this.sql, 'wallet', 'coins'),
      table: ledgerBalance(this.sql, 'table', 'coins'),
      house: ledgerBalance(this.sql, 'house', 'coins'),
      mint: ledgerBalance(this.sql, 'mint', 'coins'),
    };
    const walletCoins = readWallet(this.sql).coins;
    const tableValue = this.entities
      .coinsIn('table')
      .reduce((total, coin) => total + coin.value, 0);
    const tableCrates = this.entities.cratesOnTable().length;
    const ledgerCratesOnTable = ledgerBalance(this.sql, 'table', 'crate');
    const conserved =
      ledger.wallet === walletCoins &&
      ledger.table === tableValue &&
      ledgerCratesOnTable === tableCrates &&
      ledger.wallet + ledger.table + ledger.house + ledger.mint === 0;
    return {
      walletCoins,
      ledger,
      bufferCoins: this.entities.countCoinsIn('buffer'),
      tableValue,
      tableCrates,
      ledgerCratesOnTable,
      conserved,
    };
  }

  override async alarm(): Promise<void> {
    this.sql.exec('DELETE FROM idempotency WHERE at < ?', Date.now() - IDEMPOTENCY_RETENTION_MS);
    const more = await this.flush();
    if (more) await this.ctx.storage.setAlarm(Date.now());
  }

  /** Copies unflushed ledger rows and the wallet snapshot to D1; true if rows remain. */
  private async flush(): Promise<boolean> {
    const playerId = this.meta('player_id');
    if (playerId === null) return false;
    const flushedSeq = Number(this.requireMeta('flushed_seq'));
    const rows = this.sql
      .exec<{
        seq: number;
        tx_id: string;
        at: number;
        kind: string;
        account: string;
        unit: string;
        delta: number;
        ref: string | null;
        idempotency_key: string | null;
      }>(
        'SELECT seq, tx_id, at, kind, account, unit, delta, ref, idempotency_key FROM ledger WHERE seq > ? ORDER BY seq LIMIT ?',
        flushedSeq,
        FLUSH_BATCH_ROWS,
      )
      .toArray();
    const last = rows.at(-1);
    if (last === undefined) return false;

    const insert = this.env.DB.prepare(
      `INSERT OR IGNORE INTO ledger
         (player_id, seq, tx_id, at, kind, account, unit, delta, ref, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const wallet = readWallet(this.sql);
    const statements = rows.map((row) =>
      insert.bind(
        playerId,
        row.seq,
        row.tx_id,
        row.at,
        row.kind,
        row.account,
        row.unit,
        row.delta,
        row.ref,
        row.idempotency_key,
      ),
    );
    const latestSeq = this.sql.exec<{ seq: number }>('SELECT MAX(seq) AS seq FROM ledger').one();
    const caughtUp = latestSeq.seq === last.seq;
    if (caughtUp) {
      statements.push(
        this.env.DB.prepare(
          `INSERT INTO wallets
             (player_id, coins, bullion, gold_bars, pearls, keys, tickets, stars, ledger_seq, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (player_id) DO UPDATE SET
             coins = excluded.coins, bullion = excluded.bullion, gold_bars = excluded.gold_bars,
             pearls = excluded.pearls, keys = excluded.keys, tickets = excluded.tickets,
             stars = excluded.stars, ledger_seq = excluded.ledger_seq, updated_at = excluded.updated_at
           WHERE excluded.ledger_seq >= wallets.ledger_seq`,
        ).bind(
          playerId,
          wallet.coins,
          wallet.bullion,
          wallet.goldBars,
          wallet.pearls,
          wallet.keys,
          wallet.tickets,
          wallet.stars,
          last.seq,
          Date.now(),
        ),
      );
    }
    await this.env.DB.batch(statements);
    this.setMeta('flushed_seq', String(last.seq));
    return !caughtUp;
  }

  private async mutate<T>(
    command: Command<unknown>,
    run: (now: EpochMs) => T,
  ): Promise<DoResult<T>> {
    if (this.meta('player_id') === null) return this.uninitialized();
    const now = Date.now();
    let result: DoResult<T>;
    try {
      result = this.ctx.storage.transactionSync((): DoResult<T> => {
        const previous = this.sql
          .exec<{ fingerprint: string; response: string }>(
            'SELECT fingerprint, response FROM idempotency WHERE key = ?',
            command.idempotencyKey,
          )
          .toArray()[0];
        if (previous !== undefined) {
          if (previous.fingerprint !== command.fingerprint) {
            throw new ApiFailure(
              'idempotency_key_reused',
              'This Idempotency-Key was already used for a different request. Use a new key per request.',
            );
          }
          return { ok: true, replayed: true, body: JSON.parse(previous.response) as T };
        }
        const body = run(now);
        this.sql.exec(
          'INSERT INTO idempotency (key, fingerprint, response, at) VALUES (?, ?, ?, ?)',
          command.idempotencyKey,
          command.fingerprint,
          JSON.stringify(body),
          now,
        );
        return { ok: true, replayed: false, body };
      });
    } catch (error) {
      if (error instanceof ApiFailure) {
        return { ok: false, error: { code: error.code, message: error.message, ...error.extra } };
      }
      throw error;
    }
    if (result.ok && !result.replayed) await this.scheduleFlush(now);
    return result;
  }

  private applyDrop(body: DropRequest, idempotencyKey: string, now: EpochMs): DropResponse {
    const context = { at: now, idempotencyKey };
    const cost = tierDef(DROP_TIER).value;
    const reserved = body.coinId === undefined ? null : this.bufferedCoin(body.coinId);
    const balance = readWallet(this.sql).coins;
    if (balance < cost) {
      throw new ApiFailure(
        'insufficient_funds',
        `A drop costs ${cost} coin and the wallet holds ${balance}. Collect coins before dropping again.`,
      );
    }
    let coin: StoredCoin;
    if (reserved !== null) {
      this.entities.placeOnTable(reserved.id, body.tick);
      coin = { ...reserved, state: 'table', droppedTick: body.tick };
    } else {
      coin = this.entities.mintCoin(DROP_TIER, mintedValue(DROP_TIER), 'table', body.tick, now);
    }
    commit(
      this.sql,
      new LedgerTx(reserved !== null ? 'drop.buffer' : 'drop.mint')
        .move('wallet', 'table', 'coins', cost, coin.id)
        .move('mint', 'table', 'coins', coin.value - cost, coin.id),
      context,
    );

    const dropCount = Number(this.requireMeta('drop_count')) + 1;
    this.setMeta('drop_count', String(dropCount));
    const spawnedCrates: TableCrate[] = [];
    if (dropCount === crateSpawn.ftueScriptedDrop || dropCount % crateSpawn.dropsPerCrate === 0) {
      const crate = this.entities.spawnCrate('vault', body.tick, now);
      commit(this.sql, new LedgerTx('crate.spawn').move('mint', 'table', 'crate', 1, crate.id), {
        at: now,
        idempotencyKey,
      });
      spawnedCrates.push(publicCrate(crate));
    }

    this.reserveBuffer(now);
    return {
      coin: publicCoin(coin),
      buffer: this.entities.coinsIn('buffer').map(publicCoin),
      spawnedCrates,
      wallet: readWallet(this.sql),
    };
  }

  private bufferedCoin(id: CoinId): StoredCoin {
    const coin = this.entities.coin(id);
    if (coin === null) {
      throw new ApiFailure('not_found', 'No pre-minted coin has that ID on this account.');
    }
    if (coin.state !== 'buffer') {
      throw new ApiFailure('conflict', 'That pre-minted coin was already dropped.');
    }
    return coin;
  }

  private applyClaim(claim: Claim, idempotencyKey: string, now: EpochMs): ClaimResult {
    const context = { at: now, idempotencyKey };
    switch (claim.kind) {
      case 'fall': {
        const coin = this.entities.coinOnTable(claim.coinId, claim.tick);
        if (typeof coin === 'string') return { status: 'rejected', reason: coin };
        const paid = claim.edge === 'front';
        this.entities.settleCoin(coin.id, paid ? 'claimed' : 'lost', now);
        commit(
          this.sql,
          new LedgerTx('claim.fall').move(
            'table',
            paid ? 'wallet' : 'house',
            'coins',
            coin.value,
            coin.id,
          ),
          context,
        );
        return { status: 'accepted', credited: paid ? coin.value : 0, cascade: null, minted: null };
      }
      case 'fusion': {
        const inputs: StoredCoin[] = [];
        for (const id of claim.coinIds) {
          const coin = this.entities.coinOnTable(id, claim.tick);
          if (typeof coin === 'string') return { status: 'rejected', reason: coin };
          inputs.push(coin);
        }
        const tier = inputs[0]?.tier;
        if (tier === undefined || inputs.some((coin) => coin.tier !== tier)) {
          return { status: 'rejected', reason: 'tier_mismatch' };
        }
        const next = nextCoinTier(tier);
        if (next === null) return { status: 'rejected', reason: 'max_tier' };
        const value = Math.floor(
          fusionValue(
            inputs.map((coin) => coin.value),
            fusion,
          ),
        );
        const fused = this.entities.mintCoin(next, value, 'table', claim.tick, now);
        const tx = new LedgerTx('claim.fusion');
        let inputValue = 0;
        for (const coin of inputs) {
          this.entities.settleCoin(coin.id, 'fused', now);
          tx.post('table', 'coins', -coin.value, coin.id);
          inputValue += coin.value;
        }
        tx.post('table', 'coins', fused.value, fused.id);
        tx.post('mint', 'coins', inputValue - fused.value, fused.id);
        commit(this.sql, tx, context);
        return { status: 'accepted', credited: 0, cascade: null, minted: publicCoin(fused) };
      }
      case 'crate': {
        const crate = this.entities.crateOnTable(claim.crateId, claim.tick);
        if (typeof crate === 'string') return { status: 'rejected', reason: crate };
        const kept = claim.edge === 'front';
        this.entities.settleCrate(crate.id, kept ? 'claimed' : 'lost', now);
        commit(
          this.sql,
          new LedgerTx('claim.crate').move(
            'table',
            kept ? 'inventory' : 'house',
            'crate',
            1,
            crate.id,
          ),
          context,
        );
        return { status: 'accepted', credited: 0, cascade: null, minted: null };
      }
    }
  }

  /** Reserves IDs up to the target, but never more than the wallet could pay to drop. */
  private reserveBuffer(now: EpochMs): void {
    const affordable = Math.floor(readWallet(this.sql).coins / tierDef(DROP_TIER).value);
    const target = Math.min(PREMINT_BUFFER_TARGET, affordable);
    for (let held = this.entities.countCoinsIn('buffer'); held < target; held++) {
      this.entities.mintCoin(DROP_TIER, mintedValue(DROP_TIER), 'buffer', null, now);
    }
  }

  private snapshot(): TableSnapshot {
    return {
      coins: this.entities.coinsIn('table').map(publicCoin),
      crates: this.entities.cratesOnTable().map(publicCrate),
      buffer: this.entities.coinsIn('buffer').map(publicCoin),
      decorum: 0,
      frozenUntil: null,
    };
  }

  private async scheduleFlush(now: EpochMs): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(now + FLUSH_INTERVAL_MS);
    }
  }

  private uninitialized<T>(): DoResult<T> {
    const code: ErrorCode = 'unauthorized';
    return {
      ok: false,
      error: { code, message: 'This player has no table yet. Sign in again as a guest.' },
    };
  }

  private meta(key: MetaKey): string | null {
    const row = this.sql
      .exec<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)
      .toArray()[0];
    return row?.value ?? null;
  }

  private requireMeta(key: MetaKey): string {
    const value = this.meta(key);
    if (value === null) throw new Error(`PlayerDO meta "${key}" is missing.`);
    return value;
  }

  private setMeta(key: MetaKey, value: string): void {
    this.sql.exec(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      key,
      value,
    );
  }
}
