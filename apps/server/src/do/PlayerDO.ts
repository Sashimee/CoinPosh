import {
  cascade,
  cascadeCreditMicros,
  cascadeTierFor,
  cascadeWindowTicks,
  coinTiers,
  creditMintMicros,
  dropBufferTarget,
  dropSpawnsCrate,
  extendCascade,
  fusion,
  fusionValue,
  mintedCoinMicros,
  openingHeap,
  repriceReserved,
  upgradeLines,
  type CascadeChain,
  type UpgradeLevelMap,
} from '@coinposh/economy';
import {
  DEFAULT_FEATURE_FLAGS,
  nextCoinTier,
  StateResponseSchema,
  type ApiError,
  type AscendRequest,
  type AscendResponse,
  type Claim,
  type ClaimResult,
  type ClaimsRequest,
  type ClaimsResponse,
  type CoinId,
  type CoinTier,
  type DropRequest,
  type DropResponse,
  type EpochMs,
  type ErrorCode,
  type Locale,
  type NudgeRequest,
  type NudgeResponse,
  type PlayerId,
  TableSessionIdSchema,
  VenueIdSchema,
  CURRENCIES,
  type VenueId,
  type StateQuery,
  type StateResponse,
  type CratePoseTuple,
  type PoseTuple,
  type TableCrate,
  type TableLayout,
  type TableSessionId,
  type TableSnapshot,
  type TableSnapshotRequest,
  type TableSnapshotResponse,
  type Tick,
  type UpgradeBuyRequest,
  type UpgradeBuyResponse,
} from '@coinposh/shared';
import {
  checkCratePose,
  DEFAULT_PUSHER_MOTION,
  SIM_SNAPSHOT_VERSION,
  validateSnapshot,
} from '@coinposh/sim/snapshot';
import { DurableObject } from 'cloudflare:workers';
import { randomBase62, randomBytes, sha256Hex } from '../crypto.ts';
import type { Env } from '../env.ts';
import { ApiFailure } from '../http/errors.ts';
import {
  Entities,
  newTableSessionId,
  publicCoin,
  publicCrate,
  storedMicros,
  tierDef,
  type StoredCoin,
} from './entities.ts';
import {
  ACCOUNTS,
  commit,
  ConservationError,
  ledgerBalance,
  LedgerTx,
  openWallet,
  readWallet,
  type CommitContext,
  type Leg,
} from './ledger.ts';
import {
  applyAscension,
  buyFamilyOffice,
  currentVenue,
  familyOfficeEffect,
  isFamilyOfficeLine,
  lifetimeBullion,
  readFamilyOfficeLevels,
  unlockedVenues,
  type AscendHost,
  type AscensionCommit,
} from '../routes/ascend.ts';
import {
  quoteUpgrade,
  readUpgradeLevels,
  recordUpgrade,
  UPGRADE_TX_KIND,
  type UpgradeHost,
} from '../routes/upgrades.ts';
import { migrate } from './schema.ts';
import {
  CHUTE_POSE,
  countSnapshotFlag,
  CRATE_MAX_RIDE_SECONDS,
  elapsedSeconds,
  readTableSnapshot,
  SIM_TICKS_PER_SECOND,
  takeSnapshotToken,
  toCoinPose,
  toCratePose,
  withinCoinTravel,
  withinCrateRide,
  writeTableSnapshot,
  type StoredTableSnapshot,
  type TokenBucket,
} from './snapshot.ts';

/**
 * Coin IDs reserved ahead so play survives short network drops, at dropRate level 0 (the
 * dropRate upgrade grows it, see dropBufferTarget). The wallet pays for each one as it is
 * reserved, as the snapshot contract promises, so an offline drop spends coins the player
 * really had when it was made.
 */
export const PREMINT_BUFFER_TARGET = 16;
export const FLUSH_INTERVAL_MS = 30_000;
export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;
const FLUSH_BATCH_ROWS = 100;

/** The coins fused into the coin bound to `?`: what a boot's refund walks, once per tree node. */
export const FUSION_INPUTS_SQL = `SELECT input.ref AS ref FROM ledger AS output
  JOIN ledger AS input ON input.tx_id = output.tx_id
  WHERE output.kind = 'claim.fusion' AND output.ref = ? AND output.account = 'table'
    AND output.delta > 0 AND input.account = 'table' AND input.delta < 0`;

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
  readonly ledger: Readonly<Record<'wallet' | 'buffer' | 'table' | 'house' | 'mint', number>>;
  readonly bufferCoins: number;
  readonly bufferPaid: number;
  readonly tableValue: number;
  readonly tableCrates: number;
  readonly ledgerCratesOnTable: number;
  /** Every currency's wallet balance equals its ledger legs, and its legs sum to zero. */
  readonly currenciesConserved: boolean;
  readonly conserved: boolean;
}

type MetaKey =
  | 'player_id'
  | 'display_name'
  | 'locale'
  | 'created_at'
  | 'drop_count'
  | 'drop_high_water'
  | 'flushed_seq'
  | 'fair_server_seed'
  | 'fair_server_seed_hash'
  | 'fair_client_seed'
  | 'fair_nonce'
  | 'heap_seeded'
  | 'mint_carry'
  | 'cascade_last_tick'
  | 'cascade_count'
  | 'cascade_carry'
  | 'table_session'
  | 'table_session_started_at'
  | 'table_session_max_tick'
  | 'table_session_origin'
  | 'snapshot_tokens'
  | 'snapshot_tokens_at';

const CASCADE_WINDOW_TICKS = cascadeWindowTicks(SIM_TICKS_PER_SECOND);

function present<T>(items: readonly (T | undefined)[]): T[] {
  return items.filter((item): item is T => item !== undefined);
}

function settleLegs(
  from: 'table' | 'buffer',
  unit: Leg['unit'],
  amount: number,
  ref: string,
): Leg[] {
  if (amount === 0) return [];
  return [
    { account: from, unit, delta: -amount, ref },
    { account: 'house', unit, delta: amount, ref },
  ];
}

export class PlayerDO extends DurableObject<Env> implements UpgradeHost, AscendHost {
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
      this.setMeta('drop_high_water', '0');
      this.setMeta('flushed_seq', '0');
      this.setMeta('fair_server_seed', serverSeed);
      this.setMeta('fair_server_seed_hash', serverSeedHash);
      this.setMeta('fair_client_seed', randomBase62(16));
      this.setMeta('fair_nonce', '0');
      this.setMeta('mint_carry', '0');
      this.setMeta('cascade_carry', '0');
      openWallet(this.sql);
      commit(
        this.sql,
        new LedgerTx('grant.starting').move('mint', 'wallet', 'coins', this.startingCoins(), null),
        { at: now, idempotencyKey: null },
      );
      this.seedOpeningHeap(now);
      this.reserveBuffer({ at: now, idempotencyKey: null });
    });
    if (await this.flush()) await this.ctx.storage.setAlarm(Date.now());
  }

  /**
   * The player's snapshot. A boot one (`hydrate=boot`) is what a freshly loaded client lays its
   * table from, so it starts a new table session and places every table coin and crate from the
   * stored poses (see bootTable), refunding only the coins that client cannot lay again. Every
   * one lays the opening heap for a player who never had one and settles the buffer against
   * the wallet.
   */
  async state(query: StateQuery): Promise<DoResult<StateResponse>> {
    const playerId = this.meta('player_id');
    if (playerId === null) return this.uninitialized();
    const now = Date.now();
    const { committed, layout } = this.ctx.storage.transactionSync(() => {
      const before = this.latestSeq();
      let layout: TableLayout | null = null;
      if (query.hydrate === 'boot') {
        layout = this.bootTable(now);
      } else {
        if (this.meta('table_session') === null) this.startTableSession(now);
        this.seedOpeningHeap(now);
        this.reserveBuffer({ at: now, idempotencyKey: null });
      }
      return { committed: this.latestSeq() !== before, layout };
    });
    if (committed) await this.scheduleFlush(now);
    const venue = currentVenue(this.sql);
    const loadout = Array.from({ length: venue.charmSockets }, (_, socket) => ({
      socket,
      charmId: null,
    }));
    const upgrades = {
      ...Object.fromEntries(
        upgradeLines.filter((line) => line.scope === 'venue').map((line) => [line.id, 0]),
      ),
      ...readUpgradeLevels(this.sql, this.venueId()),
    };
    const state = {
      serverTime: now,
      player: {
        id: playerId,
        displayName: this.requireMeta('display_name'),
        locale: this.requireMeta('locale'),
        createdAt: Number(this.requireMeta('created_at')),
      },
      wallet: readWallet(this.sql),
      flags: DEFAULT_FEATURE_FLAGS,
      venue: {
        id: venue.id,
        unlocked: unlockedVenues(this.sql),
        upgrades,
        loadout,
        lifetimeBullion: lifetimeBullion(this.sql),
      },
      table: { ...this.snapshot(), session: this.tableSession(), layout },
      inventory: { charms: [], safes: [], scratchCards: [] },
      offline: null,
      fair: {
        serverSeedHash: this.requireMeta('fair_server_seed_hash'),
        clientSeed: this.requireMeta('fair_client_seed'),
        nonce: Number(this.requireMeta('fair_nonce')),
      },
      familyOffice: readFamilyOfficeLevels(this.sql),
    };
    return { ok: true, replayed: false, body: StateResponseSchema.parse(state) };
  }

  async drop(command: Command<DropRequest>): Promise<DoResult<DropResponse>> {
    return this.mutate(command, (now) => this.applyDrop(command.body, command.idempotencyKey, now));
  }

  async claims(command: Command<ClaimsRequest>): Promise<DoResult<ClaimsResponse>> {
    return this.mutate(command, (now) => {
      this.requireLease(command.body.session);
      const results = command.body.claims.map((claim) => {
        const result = this.applyClaim(claim, command.idempotencyKey, now);
        if (result.status === 'accepted') this.raiseSessionTick(claim.tick);
        return result;
      });
      return { results, wallet: readWallet(this.sql) };
    });
  }

  /**
   * A nudge under the table's lease. The server meters no decorum until its numbers move into
   * packages/economy (#15), so it answers with the table's decorum and freeze as stored, and a
   * nudge never moves value.
   */
  async nudge(command: Command<NudgeRequest>): Promise<DoResult<NudgeResponse>> {
    return this.mutate(command, () => {
      this.requireLease(command.body.session);
      const { decorum, frozenUntil } = this.snapshot();
      return { decorum, frozenUntil };
    });
  }

  /** Stores where the client's sim says the table's coins and crates rest; never moves value. */
  async tableSnapshot(
    command: Command<TableSnapshotRequest>,
  ): Promise<DoResult<TableSnapshotResponse>> {
    return this.mutate(command, (now) => this.applySnapshot(command.body, now));
  }

  /**
   * Prices the next level from economy config; the wallet pays the house for it. The level
   * applies from the next action: reserved coins are re-minted at the new coin value, the
   * buffer is topped up to its new size so the returned wallet is final, and the next drop
   * spaces crates by the new levels.
   */
  async buyUpgrade(command: Command<UpgradeBuyRequest>): Promise<DoResult<UpgradeBuyResponse>> {
    return this.mutate(command, (now) => {
      const context = { at: now, idempotencyKey: command.idempotencyKey };
      if (isFamilyOfficeLine(command.body.lineId)) {
        return this.applyFamilyOffice(command.body, context);
      }
      const quote = quoteUpgrade(this.levels(), readWallet(this.sql), command.body, this.venueId());
      recordUpgrade(this.sql, quote);
      this.repriceBuffer();
      commit(
        this.sql,
        new LedgerTx(UPGRADE_TX_KIND).move('wallet', 'house', quote.currency, quote.cost, null),
        context,
      );
      this.reserveBuffer(context);
      return {
        venueId: quote.venueId,
        lineId: command.body.lineId,
        level: quote.level,
        wallet: readWallet(this.sql),
      };
    });
  }

  /**
   * Ascends the current venue (02-ECONOMY, Venue Ascension). The client names only the venue it
   * leaves; eligibility, Bullion and Gold Bars all come from the ledger and economy config. The
   * old venue's coins on the table and in the prepaid buffer, and its crates on the table, go to
   * the house in the same `ascend` transaction that resets its currencies (P-197), so nothing
   * minted at the old venue can be claimed or dropped at the next one. The next venue opens
   * with a fresh opening heap and a buffer prepaid from the Trust Fund's starting coins.
   */
  async ascend(command: Command<AscendRequest>): Promise<DoResult<AscendResponse>> {
    return this.mutate(command, (now) => {
      const context = { at: now, idempotencyKey: command.idempotencyKey };
      const post: AscensionCommit = (kind, legs) => {
        const tx = new LedgerTx(kind);
        for (const leg of [...this.settleTableForAscension(now), ...legs]) {
          tx.post(leg.account, leg.unit, leg.delta, leg.ref);
        }
        commit(this.sql, tx, context);
      };
      const result = applyAscension(this.sql, command.body, post, now);
      this.clearCascadeChain();
      this.sql.exec("DELETE FROM meta WHERE key = 'heap_seeded'");
      this.seedOpeningHeap(now);
      this.reserveBuffer(context);
      return { ...result, wallet: readWallet(this.sql) };
    });
  }

  /** Double-entry totals next to the entity tables they must agree with. */
  conservation(): ConservationReport {
    const wallet = readWallet(this.sql);
    const currenciesConserved = CURRENCIES.every(
      (currency) =>
        ledgerBalance(this.sql, 'wallet', currency) === wallet[currency] &&
        ACCOUNTS.reduce((sum, account) => sum + ledgerBalance(this.sql, account, currency), 0) ===
          0,
    );
    const ledger = {
      wallet: ledgerBalance(this.sql, 'wallet', 'coins'),
      buffer: ledgerBalance(this.sql, 'buffer', 'coins'),
      table: ledgerBalance(this.sql, 'table', 'coins'),
      house: ledgerBalance(this.sql, 'house', 'coins'),
      mint: ledgerBalance(this.sql, 'mint', 'coins'),
    };
    const walletCoins = wallet.coins;
    const buffer = this.entities.coinsIn('buffer');
    const bufferPaid = buffer.reduce((total, coin) => total + coin.paid, 0);
    const tableValue = this.entities
      .coinsIn('table')
      .reduce((total, coin) => total + coin.value, 0);
    const tableCrates = this.entities.cratesOnTable().length;
    const ledgerCratesOnTable = ledgerBalance(this.sql, 'table', 'crate');
    const conserved =
      ledger.wallet === walletCoins &&
      ledger.buffer === bufferPaid &&
      ledger.table === tableValue &&
      ledgerCratesOnTable === tableCrates &&
      ledger.wallet + ledger.buffer + ledger.table + ledger.house + ledger.mint === 0 &&
      currenciesConserved;
    return {
      walletCoins,
      ledger,
      bufferCoins: buffer.length,
      bufferPaid,
      tableValue,
      tableCrates,
      ledgerCratesOnTable,
      currenciesConserved,
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
    const caughtUp = this.latestSeq() === last.seq;
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
    const levels = this.levels();
    const cost = tierDef(DROP_TIER).value;
    this.requireLease(body.session);
    this.raiseSessionTick(body.tick);
    const reserved = body.coinId === undefined ? null : this.bufferedCoin(body.coinId);
    const prepaid = reserved?.paid ?? 0;
    const due = Math.max(0, cost - prepaid);
    const balance = readWallet(this.sql).coins;
    if (balance < due) {
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
      coin = this.mintFromCarry(DROP_TIER, levels, 'table', body.tick, now);
    }
    commit(
      this.sql,
      new LedgerTx(reserved !== null ? 'drop.buffer' : 'drop.mint')
        .move('buffer', 'table', 'coins', prepaid, coin.id)
        .move('wallet', 'table', 'coins', due, coin.id)
        .move('mint', 'table', 'coins', coin.value - prepaid - due, coin.id),
      context,
    );

    const spawnedCrates: TableCrate[] = [];
    if (this.countDrop(levels)) {
      const crate = this.entities.spawnCrate('vault', body.tick, now);
      commit(this.sql, new LedgerTx('crate.spawn').move('mint', 'table', 'crate', 1, crate.id), {
        at: now,
        idempotencyKey,
      });
      spawnedCrates.push(publicCrate(crate));
    }

    this.reserveBuffer(context);
    return {
      coin: publicCoin(coin),
      buffer: this.entities.coinsIn('buffer').map(publicCoin),
      spawnedCrates,
      wallet: readWallet(this.sql),
    };
  }

  /**
   * Counts a drop and says whether it spawns a crate. `drop_count` is the net of drops not
   * refunded and `drop_high_water` the most it ever reached, so only a drop that lifts the mark
   * reaches a new spawn index: re-spending refunded coins never earns the same crate twice.
   */
  private countDrop(levels: UpgradeLevelMap): boolean {
    const dropCount = Number(this.requireMeta('drop_count')) + 1;
    this.setMeta('drop_count', String(dropCount));
    if (dropCount <= Number(this.requireMeta('drop_high_water'))) return false;
    this.setMeta('drop_high_water', String(dropCount));
    return dropSpawnsCrate(dropCount, levels);
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
        if (claim.edge !== 'front') {
          this.entities.settleCoin(coin.id, 'lost', now);
          commit(
            this.sql,
            new LedgerTx('claim.fall').move('table', 'house', 'coins', coin.value, coin.id),
            context,
          );
          return { status: 'accepted', credited: 0, cascade: null, minted: null };
        }
        const chain = extendCascade(this.cascadeChain(), claim.tick, CASCADE_WINDOW_TICKS);
        this.setCascadeChain(chain);
        const credit = creditMintMicros(
          cascadeCreditMicros(coin.value, chain.count),
          Number(this.requireMeta('cascade_carry')),
        );
        this.setMeta('cascade_carry', String(credit.carry));
        this.entities.settleCoin(coin.id, 'claimed', now);
        commit(
          this.sql,
          new LedgerTx('claim.fall')
            .move('table', 'wallet', 'coins', coin.value, coin.id)
            .move('mint', 'wallet', 'coins', credit.value - coin.value, coin.id),
          context,
        );
        return {
          status: 'accepted',
          credited: credit.value,
          cascade: cascadeTierFor(chain.count, cascade)?.id ?? null,
          minted: null,
        };
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
        const fused = this.entities.mintCoin(next, value, null, 'table', claim.tick, now);
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

  /**
   * Tops the buffer up to the target with coins the wallet pays for now. A reservation made
   * before buffers were prepaid is paid for too, or let go when the wallet cannot cover it.
   */
  private reserveBuffer(context: CommitContext): void {
    const levels = this.levels();
    const cost = tierDef(DROP_TIER).value;
    const target = dropBufferTarget(PREMINT_BUFFER_TARGET, levels);
    const canPay = () => readWallet(this.sql).coins >= cost;
    for (const coin of this.entities.coinsIn('buffer')) {
      if (coin.paid > 0) continue;
      if (canPay()) this.prepay(coin.id, cost, context);
      else this.entities.discardUnpaid(coin.id);
    }
    for (let held = this.entities.countCoinsIn('buffer'); held < target; held++) {
      if (!canPay()) break;
      const coin = this.mintFromCarry(DROP_TIER, levels, 'buffer', null, context.at);
      this.prepay(coin.id, cost, context);
    }
  }

  /** Mints a coin worth its share of the multiplier: the fraction a floor drops is carried on. */
  private mintFromCarry(
    tier: CoinTier,
    levels: UpgradeLevelMap,
    state: 'buffer' | 'table',
    droppedTick: Tick | null,
    at: EpochMs,
  ): StoredCoin {
    const micros = this.mintedMicros(tier, levels);
    const credit = creditMintMicros(micros, this.mintCarry());
    this.setMeta('mint_carry', String(credit.carry));
    return this.entities.mintCoin(tier, credit.value, micros, state, droppedTick, at);
  }

  /**
   * Re-mints the reserved drop coins at the current levels, crediting each only the raise
   * through the carry, so the coins already minted are not counted twice.
   */
  private repriceBuffer(): void {
    const reserved = this.entities.coinsIn('buffer').filter((coin) => coin.tier === DROP_TIER);
    const repriced = repriceReserved(
      reserved.map((coin) => ({ value: coin.value, micros: storedMicros(coin) })),
      this.mintedMicros(DROP_TIER, this.levels()),
      this.mintCarry(),
    );
    reserved.forEach((coin, i) => {
      const next = repriced.reserved[i];
      if (next === undefined) throw new Error('repriceReserved returned fewer coins than it got.');
      this.entities.repriceBuffered(coin.id, next.value, next.micros);
    });
    this.setMeta('mint_carry', String(repriced.carry));
  }

  private cascadeChain(): CascadeChain | null {
    const lastTick = this.meta('cascade_last_tick');
    const count = this.meta('cascade_count');
    if (lastTick === null || count === null) return null;
    return { lastTick: Number(lastTick), count: Number(count) };
  }

  /** A booting client's sim restarts its ticks, so no fall after a boot may join a chain from before. */
  private clearCascadeChain(): void {
    this.sql.exec("DELETE FROM meta WHERE key IN ('cascade_last_tick', 'cascade_count')");
  }

  private setCascadeChain(chain: CascadeChain): void {
    this.setMeta('cascade_last_tick', String(chain.lastTick));
    this.setMeta('cascade_count', String(chain.count));
  }

  private mintCarry(): number {
    return Number(this.requireMeta('mint_carry'));
  }

  private prepay(id: CoinId, cost: number, context: CommitContext): void {
    this.entities.markPaid(id, cost);
    commit(
      this.sql,
      new LedgerTx('buffer.prepay').move('wallet', 'buffer', 'coins', cost, id),
      context,
    );
  }

  /**
   * A booting client lays a coin only from its stored pose or its heap slot, so a coin with
   * neither would sit on its table unclaimable. Mid-session snapshots (a resync or a tab
   * coming back) must not do this, or coins still in play would stop paying while their
   * refund buys new drops. Each one goes back: the wallet gets what it paid for the coin, or
   * for the drops fused into it, but never more than the coin is worth, and the house takes
   * the rest of its value. The coin leaves the table for good, so a second boot finds nothing
   * to refund and a late claim of it is refused as already claimed.
   */
  private refundStranded(stranded: readonly StoredCoin[], now: EpochMs): void {
    if (stranded.length === 0) return;
    const tx = new LedgerTx('refund.table');
    let refundedDrops = 0;
    for (const coin of stranded) {
      const spend = this.dropsBehind(coin.id);
      const refund = Math.min(spend.paid, coin.value);
      refundedDrops += spend.drops;
      this.entities.settleCoin(coin.id, 'refunded', now);
      tx.move('table', 'wallet', 'coins', refund, coin.id);
      tx.move('table', 'house', 'coins', coin.value - refund, coin.id);
    }
    commit(this.sql, tx, { at: now, idempotencyKey: null });
    const dropCount = Number(this.requireMeta('drop_count')) - refundedDrops;
    if (dropCount < 0) {
      throw new ConservationError(
        `Refunding ${refundedDrops} drops would take drop_count below zero; the drop counter is out of step with the ledger.`,
      );
    }
    this.setMeta('drop_count', String(dropCount));
  }

  /**
   * The drops behind this coin, its own or every drop fused into it, and what the wallet paid
   * for them.
   */
  private dropsBehind(id: string): { paid: number; drops: number } {
    const own = this.sql
      .exec<{ paid: number | null; drops: number }>(
        `SELECT -SUM(CASE WHEN account IN ('wallet', 'buffer') THEN delta END) AS paid,
                COUNT(DISTINCT tx_id) AS drops
         FROM ledger WHERE ref = ? AND kind IN ('drop.mint', 'drop.buffer')`,
        id,
      )
      .one();
    const inputs = this.sql.exec<{ ref: string }>(FUSION_INPUTS_SQL, id).toArray();
    return inputs.reduce(
      (total, input) => {
        const behind = this.dropsBehind(input.ref);
        return { paid: total.paid + behind.paid, drops: total.drops + behind.drops };
      },
      { paid: own.paid ?? 0, drops: own.drops },
    );
  }

  /**
   * Lays the opening heap once per player, staked by the house rather than the wallet. It
   * rests at the front lip, so its coins may fall from tick 0; the client's sim lays them
   * first, in this order, so they hold sim ids 0..n-1, and each keeps its slot for life. A
   * boot refunds every other unposed table coin first, so a player who signed up before the
   * heap existed gets theirs on the boot after this deploy.
   */
  private seedOpeningHeap(now: EpochMs): void {
    if (this.meta('heap_seeded') === '1') return;
    if (this.entities.countCoinsIn('table') > 0) return;
    const levels = this.levels();
    const tx = new LedgerTx('grant.heap');
    for (let i = 0; i < openingHeap.coins; i++) {
      const coin = this.mintFromCarry(openingHeap.tier, levels, 'table', 0, now);
      this.entities.setHeapSlot(coin.id, i);
      tx.move('house', 'table', 'coins', coin.value, coin.id);
    }
    commit(this.sql, tx, { at: now, idempotencyKey: null });
    this.setMeta('heap_seeded', '1');
  }

  /**
   * Starts a new table session and places every table coin and crate (92-table-persistence
   * 4.1): a coin from its stored pose when that still passes the sim's checks, a heap coin
   * without one at its heap slot, and any other coin refunded; a crate from its stored pose or
   * back at the chute. What was restored becomes the session's first snapshot and its audit
   * start state.
   */
  private bootTable(now: EpochMs): TableLayout {
    const stored = readTableSnapshot(this.sql);
    const usable =
      stored !== null && stored.pusherTick < DEFAULT_PUSHER_MOTION.periodTicks ? stored : null;
    const pusherTick = usable?.pusherTick ?? 0;
    const session = this.startTableSession(now);
    const before = this.entities.coinsIn('table');
    const poses = this.judgePoses(before, usable?.poses ?? [], pusherTick).ok;
    this.refundStranded(
      before.filter((coin) => coin.heapSlot === null && !poses.has(coin.id)),
      now,
    );
    this.clearCascadeChain();
    this.entities.rebaseTableTicks();
    this.seedOpeningHeap(now);
    this.reserveBuffer({ at: now, idempotencyKey: null });

    const coins = this.entities.coinsIn('table');
    const crates = this.entities.cratesOnTable();
    const cratePoses = new Map(
      (usable?.cratePoses ?? [])
        .filter((tuple) => checkCratePose(toCratePose(tuple), CRATE_MAX_RIDE_SECONDS).ok)
        .map((tuple) => [tuple[0], tuple]),
    );
    const layout: TableLayout = {
      pusher: { tickInCycle: pusherTick },
      coins: coins.map((coin) => {
        const pose = poses.get(coin.id);
        if (pose !== undefined) return { kind: 'pose', pose };
        if (coin.heapSlot !== null) return { kind: 'heapSlot', slot: coin.heapSlot };
        throw new Error(
          `Table coin ${coin.id} has neither a pose nor a heap slot after the refund.`,
        );
      }),
      crates: crates.map((crate) => {
        const pose = cratePoses.get(crate.id);
        return pose === undefined ? { kind: 'chute' } : { kind: 'pose', pose };
      }),
    };
    const restored: StoredTableSnapshot = {
      session,
      seq: 0,
      tick: 0,
      pusherTick,
      poses: present(coins.map((coin) => poses.get(coin.id))),
      cratePoses: present(crates.map((crate) => cratePoses.get(crate.id))),
      receivedAt: now,
    };
    writeTableSnapshot(this.sql, restored);
    this.setMeta('table_session_origin', JSON.stringify(restored));
    return layout;
  }

  /**
   * The table coins' poses a restore can take, run through the sim's own checks: each coin
   * goes by its rowid rank, the sim id a client laying `table.coins` in order gives it.
   */
  private judgePoses(
    tableCoins: readonly StoredCoin[],
    tuples: readonly PoseTuple[],
    pusherTick: number,
  ): { ok: Map<CoinId, PoseTuple>; dropped: number } {
    const simIds = new Map(tableCoins.map((coin, simId) => [coin.id, simId]));
    const posed = tuples.flatMap((pose) => {
      const simId = simIds.get(pose[0]);
      return simId === undefined ? [] : [{ simId, pose }];
    });
    const verdict = validateSnapshot({
      version: SIM_SNAPSHOT_VERSION,
      pusherTickInCycle: pusherTick,
      coins: posed.map(({ simId, pose }) => toCoinPose(pose, simId)),
    });
    const kept = new Set(verdict.ok.map((pose) => pose.id));
    return {
      ok: new Map(posed.filter(({ simId }) => kept.has(simId)).map(({ pose }) => [pose[0], pose])),
      dropped: verdict.dropped.length,
    };
  }

  /**
   * Stores the client's poses after the pipeline of 92-table-persistence 3.2. A pose that is
   * not this table's, not plausible, or moved further than the table can move it is dropped,
   * and what is on the table but not in this snapshot keeps its stored pose. It writes the
   * snapshot row and the anomaly counters only: never the wallet, ledger, coins or crates.
   */
  private applySnapshot(body: TableSnapshotRequest, now: EpochMs): TableSnapshotResponse {
    this.requireLease(body.session);
    const stored = readTableSnapshot(this.sql);
    const previous = stored?.session === body.session ? stored : null;
    const floorTick = Math.max(
      previous?.tick ?? 0,
      Number(this.meta('table_session_max_tick') ?? 0),
    );
    if (previous !== null && body.seq <= previous.seq) {
      throw new ApiFailure(
        'stale_snapshot',
        `Snapshot seq ${body.seq} is not after the stored ${previous.seq}. Send the next seq.`,
      );
    }
    if (body.tick < floorTick) {
      throw new ApiFailure(
        'stale_snapshot',
        `Snapshot tick ${body.tick} is before tick ${floorTick} the table already reached.`,
      );
    }
    const take = takeSnapshotToken(this.snapshotBucket(), now);
    if (!take.ok) {
      throw new ApiFailure('rate_limited', 'Table snapshots are sent too often. Retry later.', {
        retryAfterMs: take.retryAfterMs,
      });
    }
    if (body.pusher.tickInCycle >= DEFAULT_PUSHER_MOTION.periodTicks) {
      throw new ApiFailure(
        'bad_request',
        `pusher.tickInCycle must be below ${DEFAULT_PUSHER_MOTION.periodTicks}.`,
      );
    }
    if (
      new Set(body.coins.map(([id]) => id)).size !== body.coins.length ||
      new Set(body.crates.map(([id]) => id)).size !== body.crates.length
    ) {
      throw new ApiFailure('bad_request', 'Each coin and crate may be posed once per snapshot.');
    }
    this.setMeta('snapshot_tokens', String(take.bucket.tokens));
    this.setMeta('snapshot_tokens_at', String(take.bucket.at));

    let ignored = 0;
    let foreign = 0;
    let teleport = 0;
    const tableCoins = this.entities.coinsIn('table');
    const onTable = new Set(tableCoins.map((coin) => coin.id));
    const owned: PoseTuple[] = [];
    for (const pose of body.coins) {
      if (onTable.has(pose[0])) {
        owned.push(pose);
        continue;
      }
      ignored++;
      const coin = this.entities.coin(pose[0]);
      if (coin === null || coin.state === 'buffer') foreign++;
    }
    const judged = this.judgePoses(tableCoins, owned, body.pusher.tickInCycle);
    ignored += judged.dropped;
    const seconds =
      previous === null ? 0 : elapsedSeconds(body.tick - previous.tick, previous.receivedAt, now);
    const coinsBefore = new Map((previous?.poses ?? []).map((pose) => [pose[0], pose]));
    const accepted = new Map<CoinId, PoseTuple>();
    for (const [id, pose] of judged.ok) {
      const from = coinsBefore.get(id);
      if (from !== undefined && !withinCoinTravel(from, pose, seconds)) {
        teleport++;
        ignored++;
        continue;
      }
      accepted.set(id, pose);
    }

    let implausibleCrates = 0;
    const tableCrates = this.entities.cratesOnTable();
    const cratesOnTable = new Map(tableCrates.map((crate) => [crate.id, crate]));
    const cratesBefore = new Map((previous?.cratePoses ?? []).map((pose) => [pose[0], pose]));
    const startedAt = Number(this.requireMeta('table_session_started_at'));
    const acceptedCrates = new Map<string, CratePoseTuple>();
    for (const tuple of body.crates) {
      const crate = cratesOnTable.get(tuple[0]);
      if (crate === undefined) {
        ignored++;
        if (this.entities.crate(tuple[0]) === null) foreign++;
        continue;
      }
      const pose = toCratePose(tuple);
      if (!checkCratePose(pose, CRATE_MAX_RIDE_SECONDS).ok) {
        ignored++;
        implausibleCrates++;
        continue;
      }
      const from = cratesBefore.get(crate.id);
      const rides =
        from === undefined
          ? withinCrateRide(
              CHUTE_POSE,
              pose,
              elapsedSeconds(
                body.tick - crate.spawnedTick,
                Math.max(crate.spawnedAt, startedAt),
                now,
              ),
            )
          : withinCrateRide(toCratePose(from), pose, seconds);
      if (!rides) {
        ignored++;
        teleport++;
        continue;
      }
      acceptedCrates.set(crate.id, tuple);
    }

    writeTableSnapshot(this.sql, {
      session: body.session,
      seq: body.seq,
      tick: body.tick,
      pusherTick: body.pusher.tickInCycle,
      poses: present(tableCoins.map((coin) => accepted.get(coin.id) ?? coinsBefore.get(coin.id))),
      cratePoses: present(
        tableCrates.map((crate) => acceptedCrates.get(crate.id) ?? cratesBefore.get(crate.id)),
      ),
      receivedAt: now,
    });
    countSnapshotFlag(this.sql, 'snapshot.foreign', foreign, now);
    countSnapshotFlag(this.sql, 'snapshot.teleport', teleport, now);
    countSnapshotFlag(this.sql, 'snapshot.implausible', judged.dropped + implausibleCrates, now);
    return { seq: body.seq, stored: accepted.size + acceptedCrates.size, ignored };
  }

  private snapshotBucket(): TokenBucket | null {
    const tokens = this.meta('snapshot_tokens');
    const at = this.meta('snapshot_tokens_at');
    return tokens === null || at === null ? null : { tokens: Number(tokens), at: Number(at) };
  }

  /**
   * The latest boot owns the table. The snapshot rate bucket is the player's, not the
   * session's, so booting again never buys more snapshots.
   */
  private startTableSession(now: EpochMs): TableSessionId {
    const session = newTableSessionId();
    this.setMeta('table_session', session);
    this.setMeta('table_session_started_at', String(now));
    this.setMeta('table_session_max_tick', '0');
    return session;
  }

  private tableSession(): TableSessionId {
    return TableSessionIdSchema.parse(this.requireMeta('table_session'));
  }

  /**
   * The newest boot holds the table's lease (#85): two sims writing one table would each
   * claim, drop and pose coins the other had already moved. A table op from any other session
   * is refused before it writes anything, and so is one naming no session, so a client that
   * leaves the field out cannot slip past the fence while the contract still allows it.
   */
  private requireLease(session: TableSessionId | undefined): void {
    const current = this.meta('table_session');
    if (session !== undefined && session === current) return;
    throw new ApiFailure(
      'session_superseded',
      session === undefined
        ? 'This table op names no table session. Send the session from the latest GET /v1/state?hydrate=boot.'
        : 'Another tab or device has booted this table since. Reload to play here.',
    );
  }

  /** A snapshot may never be older than a drop or claim the server already settled in this session. */
  private raiseSessionTick(tick: Tick): void {
    if (tick > Number(this.meta('table_session_max_tick') ?? 0)) {
      this.setMeta('table_session_max_tick', String(tick));
    }
  }

  /**
   * Buys a Family Office level for Gold Bars. Old Money raises the value of every coin minted
   * from now on, so the reserved buffer is re-minted at it, and the buffer is topped up so the
   * returned wallet is final.
   */
  private applyFamilyOffice(body: UpgradeBuyRequest, context: CommitContext): UpgradeBuyResponse {
    const venueId = this.venueId();
    if (body.venueId !== venueId) {
      throw new ApiFailure(
        'forbidden',
        `The Family Office is reached from the current venue ${venueId}, not ${body.venueId}.`,
      );
    }
    const bought = buyFamilyOffice(this.sql, body, context);
    this.repriceBuffer();
    this.reserveBuffer(context);
    return { ...bought, wallet: readWallet(this.sql) };
  }

  /**
   * Settles the venue being left: every coin on the table and in the buffer and every crate on
   * the table goes to the house. Returns the legs for the ascension's transaction.
   */
  private settleTableForAscension(now: EpochMs): Leg[] {
    const legs: Leg[] = [];
    for (const coin of this.entities.coinsIn('table')) {
      this.entities.settleCoin(coin.id, 'lost', now);
      legs.push(...settleLegs('table', 'coins', coin.value, coin.id));
    }
    for (const coin of this.entities.coinsIn('buffer')) {
      legs.push(...settleLegs('buffer', 'coins', coin.paid, coin.id));
    }
    this.sql.exec("UPDATE coins SET state = 'lost', settled_at = ? WHERE state = 'buffer'", now);
    for (const crate of this.entities.cratesOnTable()) {
      this.entities.settleCrate(crate.id, 'lost', now);
      legs.push(...settleLegs('table', 'crate', 1, crate.id));
    }
    return legs;
  }

  private venueId(): VenueId {
    return VenueIdSchema.parse(currentVenue(this.sql).id);
  }

  /** The current venue's levels plus the Family Office's, which apply at every venue. */
  private levels(): UpgradeLevelMap {
    return {
      ...readUpgradeLevels(this.sql, this.venueId()),
      ...readFamilyOfficeLevels(this.sql),
    };
  }

  /** A coin of `tier` minted now at the current venue, in millionths. */
  private mintedMicros(tier: CoinTier, levels: UpgradeLevelMap): number {
    return mintedCoinMicros(tierDef(tier), currentVenue(this.sql), levels);
  }

  private startingCoins(): number {
    return Math.floor(familyOfficeEffect(readFamilyOfficeLevels(this.sql), 'startingCoins'));
  }

  private latestSeq(): number | null {
    return this.sql.exec<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM ledger').one().seq;
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
