import {
  album,
  ascension,
  ascensionGoldBars,
  bullion,
  bullionFromValue,
  cascade,
  cascadeTierFor,
  coinTiers,
  crateRewards,
  crateIncomeCoins,
  crateSpawn,
  currencies,
  dropBufferTarget,
  dropSpacingTicks,
  dropSpawnsCrate,
  dropTables,
  fusion,
  fusionValue,
  initialPityState,
  measuredActiveRatePerHour,
  mintedCoinValue,
  offline,
  offlineCapHours,
  offlineRate,
  offlineVaultCoins,
  openingHeap,
  pity,
  pushTravelTicks,
  playStretchOf,
  rateEnvelope,
  rateEnvelopeScale,
  playWindowStart,
  rollDrop,
  season,
  upgradeCost,
  upgradeLines,
  upgradeStatAt,
  venues,
  type CrateRewardDef,
  type DropSourceId,
  type PityState,
  type PlayEntry,
  type RarityId,
  type Rng,
  type UpgradeLevelMap,
  type UpgradeLineDef,
  type UpgradeStatId,
  type VenueDef,
} from '@coinposh/economy';
import {
  CharmIdSchema,
  CharmTypeIdSchema,
  CoinIdSchema,
  CollectibleIdSchema,
  CrateIdSchema,
  DEFAULT_FEATURE_FLAGS,
  ENTITY_ID_PREFIXES,
  RARITIES,
  SCRATCH_GRID_SIZE,
  SeasonIdSchema,
  UpgradeLineIdSchema,
  VenueIdSchema,
  nextCoinTier,
  type CharmId,
  type CharmSlot,
  type Claim,
  type ClaimResult,
  type CoinId,
  type CoinTier,
  type CrateId,
  type Currency,
  type DevicePublicKey,
  type EndpointBody,
  type EndpointName,
  type EndpointParams,
  type EndpointResponseInput,
  type ErrorCode,
  type Locale,
  type MintedCoin,
  type OwnedCharm,
  type PlayerId,
  type Rarity,
  type Reward,
  type RevealedSeed,
  type Roll,
  type Safe,
  type ScratchCardId,
  type TableCrate,
  type UpgradeLevels,
  type VenueId,
  type Wallet,
} from '@coinposh/shared';
import { randomBase62 } from '../encoding.ts';
import { newSeed, nextRoll, reveal, type FairSeedState } from './fair.ts';
import { MOCK_RULES } from './rules.ts';

/** A refusal the mock answers with an error envelope, exactly like the real server would. */
export class MockFailure extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'MockFailure';
    this.code = code;
  }
}

export interface LedgerEntry {
  readonly seq: number;
  readonly at: number;
  readonly playerId: PlayerId;
  readonly reason: string;
  readonly delta: Readonly<Partial<Record<Currency, number>>>;
  readonly ref: string | null;
}

interface CoinRecord {
  coin: MintedCoin;
  place: 'buffer' | 'table';
  spawnTick: number | null;
  origin: 'drop' | 'fusion' | 'heap';
}

interface TickAnchor {
  tick: number;
  at: number;
  earliestAt: number;
  /** Highest tick this anchor has admitted. */
  maxTick: number;
  /** Set on a re-anchor: lower ticks belong to the anchor this one replaced. */
  floorTick: number | null;
}

interface CrateRecord {
  crate: TableCrate;
  ftue: boolean;
  state: 'table' | 'openable';
  spawnTick: number;
}

export interface MockPlayer {
  readonly id: PlayerId;
  readonly deviceKey: CryptoKey;
  readonly deviceThumbprint: string;
  readonly createdAt: number;
  displayName: string;
  locale: Locale;
  wallet: Wallet;
  venueId: VenueDef['id'];
  unlocked: VenueDef['id'][];
  levels: Map<string, number>;
  loadouts: Map<VenueDef['id'], (CharmId | null)[]>;
  charms: OwnedCharm[];
  safes: Safe[];
  scratchCards: ScratchCardId[];
  album: Map<string, number>;
  coins: Map<CoinId, CoinRecord>;
  /** Coins that left play, with the server time they left, for `claimExpiryMs`. */
  gone: Map<CoinId, number>;
  crates: Map<CrateId, CrateRecord>;
  openedCrates: Set<CrateId>;
  decorumPoints: number;
  decorumAt: number;
  frozenUntil: number | null;
  drops: number;
  lastDropTick: number | null;
  tickAnchor: TickAnchor | null;
  /** The anchor a resume replaced, which still judges the ticks seen before it. */
  previousAnchor: TickAnchor | null;
  /** Server time of a resume whose new anchor waits for the first tick past the old maximum. */
  resumedAt: number | null;
  /**
   * The last silence of at least `minOfflineMs`, kept until `state` settles it: a resuming client
   * sends its queued play first, which must not erase the absence before the snapshot.
   */
  absence: { since: number; until: number } | null;
  /** Highest tick of an accepted claim: claim ticks only move forward. */
  lastClaimTick: number | null;
  /** Ticks of recently accepted falls (any edge) and fusions, oldest first. */
  recentFalls: number[];
  recentFusions: number[];
  cascadeChain: { lastTick: number; count: number } | null;
  lifetimeValue: number;
  lifetimeBullion: number;
  /**
   * Wallet coin movements from play (drops paid, falls won) inside the active-rate window, the
   * same ledger kinds the server measures the Velvet Vault's rate from.
   */
  playLog: PlayEntry[];
  lastActiveAt: number;
  fair: FairSeedState;
  revealed: RevealedSeed[];
  pity: Map<DropSourceId, PityState>;
}

const DROP_TIER = coinTiers[0];
/** Ledger reasons that move wallet coins through play, matching the server's play kinds. */
const PLAY_REASONS: ReadonlySet<string> = new Set(['drop.debit', 'drop.prepay', 'claim.fall']);
const MS_PER_TICK = 1000 / MOCK_RULES.ticksPerSecond;

function ticksFor(ms: number): number {
  return Math.ceil(ms / MS_PER_TICK);
}

const CASCADE_WINDOW_TICKS = ticksFor(cascade.windowMs);
const MIN_FALL_TICKS = {
  drop: ticksFor(MOCK_RULES.minFallMsAfterDrop),
  fusion: ticksFor(MOCK_RULES.minFallMsAfterFusion),
  heap: 0,
} as const;
const MIN_FUSION_TICKS = ticksFor(MOCK_RULES.minFusionMsAfterSpawn);
const FALL_WINDOW_TICKS = ticksFor(MOCK_RULES.fallEnvelope.windowMs);
const FUSION_WINDOW_TICKS = ticksFor(MOCK_RULES.fusionEnvelope.windowMs);

type TickVerdict = 'ok' | 'ahead' | 'expired';

function judgeTick(anchor: TickAnchor, tick: number, now: number): TickVerdict {
  const implied = anchor.at + (tick - anchor.tick) * MS_PER_TICK;
  if (implied > now + MOCK_RULES.tickSlackMs) {
    const at = anchor.at - (implied - now - MOCK_RULES.tickSlackMs);
    if (at < anchor.earliestAt) return 'ahead';
    anchor.at = at;
  } else if (implied < now - MOCK_RULES.claimExpiryMs) {
    return 'expired';
  }
  anchor.maxTick = Math.max(anchor.maxTick, tick);
  return 'ok';
}

/**
 * Drops ticks that slid out of the window ending at `tick`, then says whether one more event
 * still fits under `max`. Claim ticks only move forward, so `recent` stays sorted.
 */
function admitToWindow(recent: number[], tick: number, windowTicks: number, max: number): boolean {
  const firstInWindow = recent.findIndex((seen) => seen > tick - windowTicks);
  recent.splice(0, firstInWindow === -1 ? recent.length : firstInWindow);
  return recent.length < max;
}
/** Charm kinds are the album's charm entries until the economy config grows a charm catalog. */
const ALBUM_ITEMS: readonly AlbumItem[] = album.flatMap((set): readonly AlbumItem[] => set.items);
const CHARM_TYPES = ALBUM_ITEMS.filter((item) => item.id.endsWith('Charm'));
const ALBUM_CARDS = ALBUM_ITEMS.filter((item) => !item.id.endsWith('Charm'));

interface AlbumItem {
  readonly id: string;
  readonly rarity: RarityId;
}

export type WorldEndpoint = Exclude<EndpointName, 'authGuest' | 'authRefresh'>;

function entityId(prefix: string): string {
  return `${prefix}_${randomBase62(16)}`;
}

function venueDef(id: VenueDef['id']): VenueDef {
  const venue = venues.find((candidate) => candidate.id === id);
  if (venue === undefined) throw new Error(`Mock: unknown venue "${id}" in player state.`);
  return venue;
}

function findVenue(id: VenueId): VenueDef {
  const venue = venues.find((candidate) => candidate.id === id);
  if (venue === undefined) throw new MockFailure('not_found', `No venue "${id}".`);
  return venue;
}

function line(id: string): UpgradeLineDef {
  const found = upgradeLines.find((candidate) => candidate.id === id);
  if (found === undefined) throw new MockFailure('not_found', `No upgrade line "${id}".`);
  return found;
}

function levelKey(player: MockPlayer, def: UpgradeLineDef): string {
  return def.scope === 'global' ? def.id : `${player.venueId}:${def.id}`;
}

/** The levels in play at the player's current venue, global lines included. */
function levelMap(player: MockPlayer): UpgradeLevelMap {
  const levels: Record<string, number> = {};
  for (const def of upgradeLines) levels[def.id] = player.levels.get(levelKey(player, def)) ?? 0;
  return levels;
}

function stat(player: MockPlayer, statId: UpgradeStatId): number {
  return upgradeStatAt(levelMap(player), statId);
}

/** The base envelope `max` stretched by the player's upgrades, as the server's envelope does. */
function envelopeMax(
  player: MockPlayer,
  base: number,
  metric: (typeof rateEnvelope)['falls' | 'fusions'],
): number {
  const scale = rateEnvelopeScale(metric, {
    levels: levelMap(player),
    venue: player.venueId,
    charms: 0,
    albumBonus: 0,
  });
  return Math.ceil(base * scale - 1e-9);
}

function emptyWallet(): Wallet {
  return { coins: 0, bullion: 0, goldBars: 0, pearls: 0, keys: 0, tickets: 0, stars: 0 };
}

export class MockWorld {
  readonly #ledger: LedgerEntry[] = [];
  /** Per player, the sum of every ledger entry evicted from memory. */
  readonly #checkpoints = new Map<PlayerId, Wallet>();
  #nextSeq = 0;
  readonly #players = new Map<PlayerId, MockPlayer>();
  readonly #byDevice = new Map<string, PlayerId>();

  /** The most recent `ledgerRetained` entries; older ones live on in {@link ledgerCheckpoint}. */
  get ledger(): readonly LedgerEntry[] {
    return this.#ledger;
  }

  /** What a player's evicted ledger entries add up to: replaying the ledger starts here. */
  ledgerCheckpoint(id: PlayerId): Wallet {
    return { ...(this.#checkpoints.get(id) ?? emptyWallet()) };
  }

  player(id: PlayerId): MockPlayer | undefined {
    return this.#players.get(id);
  }

  playerByDevice(thumbprint: string): MockPlayer | undefined {
    const id = this.#byDevice.get(thumbprint);
    return id === undefined ? undefined : this.#players.get(id);
  }

  async createPlayer(
    id: PlayerId,
    publicKey: DevicePublicKey,
    deviceKey: CryptoKey,
    locale: Locale,
    now: number,
  ): Promise<MockPlayer> {
    const thumbprint = deviceThumbprint(publicKey);
    const player: MockPlayer = {
      id,
      deviceKey,
      deviceThumbprint: thumbprint,
      createdAt: now,
      displayName: `Guest ${randomBase62(4)}`,
      locale,
      wallet: emptyWallet(),
      venueId: venues[0].id,
      unlocked: [venues[0].id],
      levels: new Map(),
      loadouts: new Map(),
      charms: [],
      safes: [],
      scratchCards: [],
      album: new Map(),
      coins: new Map(),
      gone: new Map(),
      crates: new Map(),
      openedCrates: new Set(),
      decorumPoints: 0,
      decorumAt: now,
      frozenUntil: null,
      drops: 0,
      lastDropTick: null,
      tickAnchor: null,
      previousAnchor: null,
      resumedAt: null,
      absence: null,
      lastClaimTick: null,
      recentFalls: [],
      recentFusions: [],
      cascadeChain: null,
      lifetimeValue: 0,
      lifetimeBullion: 0,
      playLog: [],
      lastActiveAt: now,
      fair: await newSeed(),
      revealed: [],
      pity: new Map(dropTables.map((table) => [table.source, initialPityState(pity)])),
    };
    this.#players.set(id, player);
    this.#byDevice.set(thumbprint, id);
    this.#credit(player, now, 'signup.startingCoins', {
      coins: Math.floor(stat(player, 'startingCoins')),
    });
    this.#seedOpeningHeap(player);
    this.#refillBuffer(player, now);
    return player;
  }

  /** The only way any balance changes: checked for overdraft, then written to the append-only ledger. */
  #credit(
    player: MockPlayer,
    now: number,
    reason: string,
    delta: Partial<Record<Currency, number>>,
    ref: string | null = null,
  ): void {
    const next = { ...player.wallet };
    for (const [currency, amount] of Object.entries(delta) as [Currency, number][]) {
      if (!Number.isSafeInteger(amount)) {
        throw new Error(`Mock ledger: ${reason} tried to move a non-integer ${currency} amount.`);
      }
      next[currency] += amount;
      if (next[currency] < 0) {
        throw new MockFailure(
          'insufficient_funds',
          `Not enough ${currency}: need ${-amount}, have ${player.wallet[currency]}.`,
        );
      }
    }
    const moved = Object.fromEntries(
      Object.entries(delta).filter(([, amount]) => amount !== 0),
    ) as Partial<Record<Currency, number>>;
    if (Object.keys(moved).length === 0) return;
    player.wallet = next;
    const playCoins = moved.coins;
    if (playCoins !== undefined && PLAY_REASONS.has(reason)) this.#logPlay(player, now, playCoins);
    this.#ledger.push({
      seq: this.#nextSeq++,
      at: now,
      playerId: player.id,
      reason,
      delta: moved,
      ref,
    });
    const excess = this.#ledger.length - MOCK_RULES.ledgerRetained;
    if (excess > 0) for (const entry of this.#ledger.splice(0, excess)) this.#checkpoint(entry);
  }

  #checkpoint(entry: LedgerEntry): void {
    const totals = this.#checkpoints.get(entry.playerId) ?? emptyWallet();
    for (const [currency, amount] of Object.entries(entry.delta) as [Currency, number][]) {
      totals[currency] += amount;
    }
    this.#checkpoints.set(entry.playerId, totals);
  }

  #coinValue(player: MockPlayer, tier: CoinTier): number {
    const def = coinTiers.find((candidate) => candidate.id === tier);
    if (def === undefined)
      throw new Error(`Mock: coin tier "${tier}" missing from economy config.`);
    return mintedCoinValue(def, venueDef(player.venueId), levelMap(player));
  }

  #mint(
    player: MockPlayer,
    tier: CoinTier,
    value: number,
    place: CoinRecord['place'],
    spawnTick: number | null,
    origin: CoinRecord['origin'] = 'drop',
  ) {
    const coin: MintedCoin = {
      id: CoinIdSchema.parse(entityId(ENTITY_ID_PREFIXES.coin)),
      tier,
      value,
    };
    player.coins.set(coin.id, { coin, place, spawnTick, origin });
    return coin;
  }

  #buffer(player: MockPlayer): MintedCoin[] {
    return [...player.coins.values()]
      .filter((record) => record.place === 'buffer')
      .map((record) => record.coin);
  }

  #tableCoins(player: MockPlayer): MintedCoin[] {
    return [...player.coins.values()]
      .filter((record) => record.place === 'table')
      .map((record) => record.coin);
  }

  /**
   * The opening heap is minted on the house and already rests at the front lip, so its coins
   * may fall from tick 0. The sim lays them first, so they hold sim ids 0..n-1.
   */
  #seedOpeningHeap(player: MockPlayer): void {
    const value = this.#coinValue(player, openingHeap.tier);
    for (let i = 0; i < openingHeap.coins; i++) {
      this.#mint(player, openingHeap.tier, value, 'table', 0, 'heap');
    }
  }

  /**
   * Buffered coins are paid for but their value is minted on drop, so a coinValue purchase
   * reprices them and the very next drop carries the bought level, as on the server.
   */
  #revalueBuffer(player: MockPlayer): void {
    const value = this.#coinValue(player, DROP_TIER.id);
    for (const record of player.coins.values()) {
      if (record.place === 'buffer' && record.coin.tier === DROP_TIER.id) {
        record.coin = { ...record.coin, value };
      }
    }
  }

  /** Tops the buffer up with coins paid for now, so an offline drop never creates value later. */
  #refillBuffer(player: MockPlayer, now: number): void {
    let buffered = this.#buffer(player).length;
    const target = dropBufferTarget(MOCK_RULES.bufferSize, levelMap(player));
    while (buffered < target && player.wallet.coins >= DROP_TIER.value) {
      const coin = this.#mint(
        player,
        DROP_TIER.id,
        this.#coinValue(player, DROP_TIER.id),
        'buffer',
        null,
      );
      this.#credit(player, now, 'drop.prepay', { coins: -DROP_TIER.value }, coin.id);
      buffered++;
    }
  }

  /**
   * Maps a tick to server time. The first tick ever seen may have waited in an offline queue, but
   * it cannot predate the player's first buffer nor be older than the claim expiry. The anchor
   * starts at its arrival and may only move earlier, within that bound, as later ticks of the
   * same backlog show how long it waited. It never moves later, so a stale queue cannot re-anchor
   * itself as fresh, and a sped-up client is caught as soon as the bound is used up.
   *
   * The sim stops while the tab is hidden, so after a resume (see `state`) the first tick past
   * everything seen before starts a new anchor no earlier than the resume. Ticks the old anchor
   * could have seen are still judged by it, so a held-back queue stays expired.
   */
  #tickClock(player: MockPlayer, tick: number, now: number): TickVerdict {
    const anchor = player.tickAnchor;
    if (anchor === null) {
      player.tickAnchor = {
        tick,
        at: now,
        earliestAt: Math.max(player.createdAt, now - MOCK_RULES.claimExpiryMs),
        maxTick: tick,
        floorTick: null,
      };
      return 'ok';
    }
    if (player.resumedAt !== null && tick > anchor.maxTick) {
      player.previousAnchor = anchor;
      player.tickAnchor = {
        tick,
        at: now,
        earliestAt: player.resumedAt,
        maxTick: tick,
        floorTick: tick,
      };
      player.resumedAt = null;
      return 'ok';
    }
    if (anchor.floorTick !== null && tick < anchor.floorTick) {
      const previous = player.previousAnchor;
      if (previous === null || (previous.floorTick !== null && tick < previous.floorTick)) {
        return 'expired';
      }
      return judgeTick(previous, tick, now);
    }
    return judgeTick(anchor, tick, now);
  }

  #checkActionTick(player: MockPlayer, action: string, tick: number, now: number): void {
    const verdict = this.#tickClock(player, tick, now);
    if (verdict === 'ahead') {
      throw new MockFailure('bad_request', `${action} tick runs ahead of the server clock.`);
    }
    if (verdict === 'expired') {
      throw new MockFailure(
        'conflict',
        `${action} tick is older than the ${MOCK_RULES.claimExpiryMs / 60_000}-minute expiry.`,
      );
    }
  }

  #decorum(player: MockPlayer, now: number): number {
    const elapsed = Math.max(0, now - player.decorumAt) / 1000;
    player.decorumPoints = Math.max(
      0,
      player.decorumPoints - elapsed * MOCK_RULES.decorumDecayPerSecond,
    );
    player.decorumAt = now;
    if (player.frozenUntil !== null && now >= player.frozenUntil) player.frozenUntil = null;
    return Math.min(1, player.decorumPoints / stat(player, 'decorumCapacity'));
  }

  #upgradeLevels(player: MockPlayer): UpgradeLevels {
    const levels: UpgradeLevels = {};
    for (const def of upgradeLines) {
      levels[UpgradeLineIdSchema.parse(def.id)] = player.levels.get(levelKey(player, def)) ?? 0;
    }
    return levels;
  }

  #loadout(player: MockPlayer, venueId: VenueDef['id']): (CharmId | null)[] {
    let loadout = player.loadouts.get(venueId);
    if (loadout === undefined) {
      loadout = Array.from({ length: venueDef(venueId).charmSockets }, () => null);
      player.loadouts.set(venueId, loadout);
    }
    return loadout;
  }

  #slots(player: MockPlayer, venueId: VenueDef['id']): CharmSlot[] {
    return this.#loadout(player, venueId).map((charmId, socket) => ({ socket, charmId }));
  }

  #logPlay(player: MockPlayer, now: number, coins: number): void {
    player.playLog.push({ at: now, coins });
    const start = playWindowStart(now, offlineRate);
    const stale = player.playLog.findIndex((entry) => entry.at >= start);
    if (stale > 0) player.playLog.splice(0, stale);
  }

  /** Net coins per active hour over the last stretch of play, as the server measures it. */
  #measuredActiveRate(player: MockPlayer): number {
    return measuredActiveRatePerHour(playStretchOf(player.playLog, offlineRate), offlineRate);
  }

  #settleOffline(player: MockPlayer, awayMs: number, now: number) {
    const capHours = offlineCapHours(levelMap(player));
    const coins = offlineVaultCoins(
      awayMs / 3_600_000,
      capHours,
      this.#measuredActiveRate(player),
      offlineRate,
      offline,
    );
    if (coins < 1) return null;
    const creditedMs = Math.min(awayMs, Math.round(capHours * 3_600_000));
    this.#credit(player, now, 'offline.vault', { coins });
    return { awayMs, creditedMs, coins };
  }

  #earn(player: MockPlayer, now: number, reason: string, coins: number, ref: string): void {
    const before = bullionFromValue(player.lifetimeValue, bullion);
    player.lifetimeValue += coins;
    const minted = bullionFromValue(player.lifetimeValue, bullion) - before;
    player.lifetimeBullion += minted;
    this.#credit(player, now, reason, { coins, bullion: minted }, ref);
  }

  touch(player: MockPlayer, now: number): void {
    player.lastActiveAt = now;
  }

  #forget(player: MockPlayer, id: CoinId, now: number): void {
    player.coins.delete(id);
    player.gone.set(id, now);
  }

  /** A claim or drop naming a coin gone longer than the expiry is refused as unknown instead. */
  #pruneGone(player: MockPlayer, now: number): void {
    for (const [id, at] of player.gone) {
      if (at > now - MOCK_RULES.claimExpiryMs) return;
      player.gone.delete(id);
    }
  }

  async handle<N extends WorldEndpoint>(
    player: MockPlayer,
    name: N,
    body: EndpointBody<N>,
    params: EndpointParams<N>,
    now: number,
  ): Promise<EndpointResponseInput<N>> {
    this.#pruneGone(player, now);
    if (now - player.lastActiveAt >= MOCK_RULES.minOfflineMs) {
      player.absence = { since: player.lastActiveAt, until: now };
    }
    const handler: Handler<N> = this.#handlers[name];
    return handler(player, body, params, now);
  }

  readonly #handlers: { [N in WorldEndpoint]: Handler<N> } = {
    state: (player, _body, _params, now) => {
      const absence = player.absence;
      player.absence = null;
      if (absence !== null && player.tickAnchor !== null) player.resumedAt = now;
      const settlement =
        absence === null ? null : this.#settleOffline(player, absence.until - absence.since, now);
      this.#refillBuffer(player, now);
      return {
        serverTime: now,
        player: {
          id: player.id,
          displayName: player.displayName,
          locale: player.locale,
          createdAt: player.createdAt,
        },
        wallet: player.wallet,
        flags: DEFAULT_FEATURE_FLAGS,
        venue: {
          id: VenueIdSchema.parse(player.venueId),
          unlocked: player.unlocked.map((id) => VenueIdSchema.parse(id)),
          upgrades: this.#upgradeLevels(player),
          loadout: this.#slots(player, player.venueId),
        },
        table: {
          coins: this.#tableCoins(player),
          crates: [...player.crates.values()]
            .filter((record) => record.state === 'table')
            .map((record) => record.crate),
          buffer: this.#buffer(player),
          decorum: this.#decorum(player, now),
          frozenUntil: player.frozenUntil,
        },
        inventory: {
          charms: player.charms,
          safes: player.safes,
          scratchCards: player.scratchCards,
        },
        offline: settlement,
        fair: {
          serverSeedHash: player.fair.serverSeedHash,
          clientSeed: player.fair.clientSeed,
          nonce: player.fair.nonce,
        },
      };
    },

    tableDrop: (player, body, _params, now) => {
      this.#checkActionTick(player, 'Drop', body.tick, now);
      if (
        player.lastDropTick !== null &&
        body.tick <
          player.lastDropTick + dropSpacingTicks(MOCK_RULES.minTicksBetweenDrops, levelMap(player))
      ) {
        throw new MockFailure('bad_request', 'Drops arrive faster than the table allows.');
      }
      let coin: MintedCoin;
      if (body.coinId === undefined) {
        this.#credit(player, now, 'drop.debit', { coins: -DROP_TIER.value });
        coin = this.#mint(
          player,
          DROP_TIER.id,
          this.#coinValue(player, DROP_TIER.id),
          'table',
          body.tick,
        );
      } else {
        const record = player.coins.get(body.coinId);
        if (record === undefined) {
          throw new MockFailure(
            player.gone.has(body.coinId) ? 'conflict' : 'not_found',
            player.gone.has(body.coinId)
              ? 'That coin was already played.'
              : 'No such coin was minted for you.',
          );
        }
        if (record.place !== 'buffer')
          throw new MockFailure('conflict', 'That coin is already on the table.');
        record.place = 'table';
        record.spawnTick = body.tick;
        coin = record.coin;
      }
      player.lastDropTick = body.tick;
      player.drops += 1;
      if (player.drops % season.dropsPerStar === 0) {
        this.#credit(player, now, 'season.drops', { stars: 1 });
      }
      const spawnedCrates: TableCrate[] = [];
      const ftue = player.drops === crateSpawn.ftueScriptedDrop;
      if (dropSpawnsCrate(player.drops, levelMap(player))) {
        const crate: TableCrate = {
          id: CrateIdSchema.parse(entityId(ENTITY_ID_PREFIXES.crate)),
          kind: 'vault',
        };
        player.crates.set(crate.id, { crate, ftue, state: 'table', spawnTick: body.tick });
        spawnedCrates.push(crate);
      }
      this.#refillBuffer(player, now);
      return { coin, buffer: this.#buffer(player), spawnedCrates, wallet: player.wallet };
    },

    tableClaims: (player, body, _params, now) => {
      const results = body.claims.map((claim) => this.#claim(player, claim, now));
      return { results, wallet: player.wallet };
    },

    tableNudge: (player, body, _params, now) => {
      this.#decorum(player, now);
      if (player.frozenUntil !== null) {
        throw new MockFailure('table_frozen', 'The Concierge has frozen the table for a moment.');
      }
      this.#checkActionTick(player, 'Nudge', body.tick, now);
      player.decorumPoints += MOCK_RULES.decorumPerNudge;
      const capacity = stat(player, 'decorumCapacity');
      if (player.decorumPoints >= capacity) {
        player.decorumPoints = capacity;
        player.frozenUntil = now + MOCK_RULES.conciergeFreezeMs;
      }
      return {
        decorum: Math.min(1, player.decorumPoints / capacity),
        frozenUntil: player.frozenUntil,
      };
    },

    tableInputs: (_player, body) => ({
      receivedEvents: body.events.length,
      receivedCheckpoints: body.checkpoints.length,
    }),

    upgradesBuy: (player, body, _params, now) => {
      const def = line(body.lineId);
      const venue = findVenue(body.venueId);
      if (def.scope === 'venue' && venue.id !== player.venueId) {
        throw new MockFailure(
          'conflict',
          'Venue upgrades can only be bought at the current venue.',
        );
      }
      const key = levelKey(player, def);
      const current = player.levels.get(key) ?? 0;
      if (body.level !== current + 1) {
        throw new MockFailure(
          'conflict',
          `Line ${def.id} is at level ${current}; buy level ${current + 1}.`,
        );
      }
      if (current >= def.maxLevel)
        throw new MockFailure('conflict', `Line ${def.id} is maxed out.`);
      this.#credit(
        player,
        now,
        `upgrade.${def.id}`,
        { [def.currency]: -upgradeCost(def, current) },
        `${body.level}`,
      );
      player.levels.set(key, body.level);
      this.#revalueBuffer(player);
      this.#refillBuffer(player, now);
      return {
        venueId: body.venueId,
        lineId: body.lineId,
        level: body.level,
        wallet: player.wallet,
      };
    },

    charmsEquip: (player, body) => {
      const venue = findVenue(body.venueId);
      if (!player.unlocked.includes(venue.id))
        throw new MockFailure('forbidden', 'That venue is still locked.');
      const loadout = this.#loadout(player, venue.id);
      if (body.socket >= loadout.length) {
        throw new MockFailure('bad_request', `${venue.id} has ${loadout.length} charm sockets.`);
      }
      if (body.charmId !== null) {
        const charmId = body.charmId;
        if (!player.charms.some((charm) => charm.id === charmId)) {
          throw new MockFailure('not_found', 'You do not own that charm.');
        }
        loadout.forEach((slotted, socket) => {
          if (slotted === charmId) loadout[socket] = null;
        });
      }
      loadout[body.socket] = body.charmId;
      return { venueId: body.venueId, loadout: this.#slots(player, venue.id) };
    },

    cratesOpen: async (player, body, _params, now) => {
      const record = player.crates.get(body.crateId);
      if (record === undefined) {
        throw new MockFailure(
          player.openedCrates.has(body.crateId) ? 'conflict' : 'not_found',
          player.openedCrates.has(body.crateId) ? 'That crate is already open.' : 'No such crate.',
        );
      }
      if (record.state !== 'openable')
        throw new MockFailure('not_ready', 'Push the crate off the ledge first.');
      player.crates.delete(body.crateId);
      player.openedCrates.add(body.crateId);
      const roll = await this.#roll(player, 'vaultCrate', now, body.crateId, record.ftue);
      return { crateId: body.crateId, roll, wallet: player.wallet };
    },

    safesOpen: async (player, body, _params, now) => {
      const safe = player.safes.find((candidate) => candidate.id === body.safeId);
      if (safe === undefined) throw new MockFailure('not_found', 'No such safe.');
      if (body.method === 'timer' && now < safe.unlocksAt) {
        throw new MockFailure('not_ready', 'The safe timer is still running.');
      }
      if (body.method === 'key') {
        this.#credit(player, now, 'safe.key', { keys: -MOCK_RULES.keysPerSafe }, safe.id);
      }
      player.safes = player.safes.filter((candidate) => candidate.id !== safe.id);
      const roll = await this.#roll(player, 'goldSafe', now, safe.id, false);
      return { safeId: body.safeId, roll, wallet: player.wallet };
    },

    gachaPull: async (player, body, _params, now) => {
      this.#credit(player, now, 'gacha.tickets', {
        tickets: -MOCK_RULES.ticketsPerPull * body.count,
      });
      const pulls: Roll[] = [];
      for (let i = 0; i < body.count; i++)
        pulls.push(await this.#roll(player, 'gacha', now, `pull:${i}`, false));
      return { pulls, wallet: player.wallet };
    },

    scratchReveal: async (player, body, _params, now) => {
      if (!player.scratchCards.includes(body.cardId))
        throw new MockFailure('not_found', 'No such scratch card.');
      player.scratchCards = player.scratchCards.filter((card) => card !== body.cardId);
      const { roll, rng } = await this.#rollWithRng(player, 'scratch', now, body.cardId, false);
      return {
        cardId: body.cardId,
        grid: scratchGrid(roll.rarity, rng),
        roll,
        wallet: player.wallet,
      };
    },

    ascend: (player, body, _params, now) => {
      const venue = findVenue(body.venueId);
      if (venue.id !== player.venueId)
        throw new MockFailure('conflict', 'You can only ascend your current venue.');
      if (player.lifetimeBullion < venue.bullionThreshold) {
        throw new MockFailure(
          'not_ready',
          `Ascension needs ${venue.bullionThreshold} lifetime Bullion.`,
        );
      }
      const goldBarsGranted = ascensionGoldBars(
        player.lifetimeBullion,
        venue.bullionThreshold,
        ascension,
      );
      const reset: Partial<Record<Currency, number>> = { goldBars: goldBarsGranted };
      for (const currency of currencies) {
        if (currency.resetsOnAscension)
          reset[currency.id] = (reset[currency.id] ?? 0) - player.wallet[currency.id];
      }
      this.#credit(player, now, 'ascend', reset, venue.id);
      for (const id of player.coins.keys()) this.#forget(player, id, now);
      player.crates.clear();
      for (const def of upgradeLines)
        if (def.scope === 'venue') player.levels.delete(`${venue.id}:${def.id}`);
      const next = venues.find((candidate) => candidate.order === venue.order + 1) ?? null;
      if (next !== null && !player.unlocked.includes(next.id)) player.unlocked.push(next.id);
      if (next !== null) player.venueId = next.id;
      player.lifetimeBullion = 0;
      player.lifetimeValue = 0;
      player.cascadeChain = null;
      player.recentFalls = [];
      player.recentFusions = [];
      this.#credit(player, now, 'ascend.startingCoins', {
        coins: Math.floor(stat(player, 'startingCoins')),
      });
      this.#refillBuffer(player, now);
      return {
        venueId: body.venueId,
        goldBarsGranted,
        unlockedVenueId: next === null ? null : VenueIdSchema.parse(next.id),
        wallet: player.wallet,
      };
    },

    album: (player) => ({
      sets: album.map((set) => {
        const entries = set.items.map((item) => {
          const count = player.album.get(item.id) ?? 0;
          return {
            id: CollectibleIdSchema.parse(item.id),
            kind: item.id.endsWith('Charm')
              ? ('charm' as const)
              : item.rarity === 'heirloom'
                ? ('heirloom' as const)
                : ('coinSkin' as const),
            owned: count > 0,
            count,
          };
        });
        return { id: set.id, entries, completed: entries.every((entry) => entry.owned) };
      }),
    }),

    fairSeeds: (player) => ({
      active: {
        serverSeedHash: player.fair.serverSeedHash,
        clientSeed: player.fair.clientSeed,
        nonce: player.fair.nonce,
      },
      revealed: player.revealed,
    }),

    fairRotate: async (player, body, _params, now) => {
      const revealed = reveal(player.fair, now);
      player.revealed.push(revealed);
      player.fair = await newSeed(body.clientSeed ?? player.fair.clientSeed);
      return {
        active: {
          serverSeedHash: player.fair.serverSeedHash,
          clientSeed: player.fair.clientSeed,
          nonce: player.fair.nonce,
        },
        revealed,
      };
    },

    quests: () => ({ quests: [], streak: { days: 0, freezes: 0 } }),

    questsClaim: () => {
      throw new MockFailure('not_found', 'Demo Mode has no quests yet.');
    },

    season: (player) => ({
      id: SeasonIdSchema.parse(`${ENTITY_ID_PREFIXES.season}_demo${player.createdAt.toString(36)}`),
      startsAt: player.createdAt,
      endsAt: player.createdAt + season.weeks * 7 * 86_400_000,
      stars: player.wallet.stars,
      tiers: Array.from({ length: season.freeTiers }, (_, i) => ({
        tier: i + 1,
        starsRequired: (i + 1) * season.starsPerTier,
        free: [],
        premium: [],
      })),
      claimedFree: [],
      claimedPremium: [],
      premiumUnlocked: false,
    }),

    leaderboard: (_player, _body, params, now) => {
      const week = 7 * 86_400_000;
      const startsAt = now - (now % week);
      return { board: params.board, startsAt, endsAt: startsAt + week, entries: [], me: null };
    },

    eventsCurrent: (_player, _body, _params, now) => ({
      serverTime: now,
      goldenHour: null,
      heist: null,
    }),
  };

  /**
   * Claims are checked against server state only: the tick must map to fresh server time and
   * move forward, the coin must have had time to reach the edge since it spawned, and falls and
   * fusions stay inside a sliding window of plausible throughput (01-ARCHITECTURE.md Layer 2).
   */
  #claim(player: MockPlayer, claim: Claim, now: number): ClaimResult {
    const reject = (
      reason: Extract<ClaimResult, { status: 'rejected' }>['reason'],
    ): ClaimResult => ({
      status: 'rejected',
      reason,
    });
    const verdict = this.#tickClock(player, claim.tick, now);
    if (verdict === 'ahead') return reject('over_envelope');
    if (verdict === 'expired') return reject('expired');
    if (player.lastClaimTick !== null && claim.tick < player.lastClaimTick) {
      return reject('over_envelope');
    }
    switch (claim.kind) {
      case 'fall': {
        const record = player.coins.get(claim.coinId);
        if (record === undefined)
          return reject(player.gone.has(claim.coinId) ? 'already_claimed' : 'unknown_entity');
        if (
          record.place !== 'table' ||
          record.spawnTick === null ||
          claim.tick < record.spawnTick
        ) {
          return reject('not_on_table');
        }
        const travel = pushTravelTicks(MIN_FALL_TICKS[record.origin], levelMap(player));
        if (claim.tick < record.spawnTick + travel) return reject('over_envelope');
        const { maxPerTick } = MOCK_RULES.fallEnvelope;
        const max = envelopeMax(player, MOCK_RULES.fallEnvelope.max, rateEnvelope.falls);
        const sameTick = player.recentFalls.filter((tick) => tick === claim.tick).length;
        if (
          sameTick >= maxPerTick ||
          !admitToWindow(player.recentFalls, claim.tick, FALL_WINDOW_TICKS, max)
        ) {
          return reject('over_envelope');
        }
        player.recentFalls.push(claim.tick);
        player.lastClaimTick = claim.tick;
        this.#forget(player, claim.coinId, now);
        if (claim.edge !== 'front')
          return { status: 'accepted', credited: 0, cascade: null, minted: null };
        const chain = player.cascadeChain;
        const count =
          chain !== null && claim.tick - chain.lastTick <= CASCADE_WINDOW_TICKS
            ? chain.count + 1
            : 1;
        player.cascadeChain = { lastTick: claim.tick, count };
        const tier = cascadeTierFor(count, cascade);
        const credited = Math.floor(record.coin.value * (tier?.multiplier ?? 1));
        this.#earn(player, now, 'claim.fall', credited, claim.coinId);
        return { status: 'accepted', credited, cascade: tier?.id ?? null, minted: null };
      }
      case 'fusion': {
        const records: CoinRecord[] = [];
        let unsettled = false;
        for (const id of claim.coinIds) {
          const record = player.coins.get(id);
          if (record === undefined)
            return reject(player.gone.has(id) ? 'already_claimed' : 'unknown_entity');
          if (
            record.place !== 'table' ||
            record.spawnTick === null ||
            claim.tick < record.spawnTick
          ) {
            return reject('not_on_table');
          }
          if (claim.tick < record.spawnTick + MIN_FUSION_TICKS) unsettled = true;
          records.push(record);
        }
        const tier = records[0]?.coin.tier;
        if (tier === undefined) return reject('unknown_entity');
        if (records.some((record) => record.coin.tier !== tier)) return reject('tier_mismatch');
        const next = nextCoinTier(tier);
        if (next === null) return reject('max_tier');
        if (
          unsettled ||
          !admitToWindow(
            player.recentFusions,
            claim.tick,
            FUSION_WINDOW_TICKS,
            envelopeMax(player, MOCK_RULES.fusionEnvelope.max, rateEnvelope.fusions),
          )
        ) {
          return reject('over_envelope');
        }
        player.recentFusions.push(claim.tick);
        player.lastClaimTick = claim.tick;
        for (const id of claim.coinIds) this.#forget(player, id, now);
        const value = Math.floor(
          fusionValue(
            records.map((record) => record.coin.value),
            fusion,
          ),
        );
        const minted = this.#mint(player, next, value, 'table', claim.tick, 'fusion');
        return { status: 'accepted', credited: 0, cascade: null, minted };
      }
      case 'crate': {
        const record = player.crates.get(claim.crateId);
        if (record === undefined) {
          return reject(
            player.openedCrates.has(claim.crateId) ? 'already_claimed' : 'unknown_entity',
          );
        }
        if (record.state !== 'table') return reject('already_claimed');
        if (claim.tick < record.spawnTick) return reject('not_on_table');
        player.lastClaimTick = claim.tick;
        if (claim.edge === 'front') {
          record.state = 'openable';
          this.#credit(player, now, 'season.crate', { stars: season.starsPerCrate }, claim.crateId);
        } else {
          player.crates.delete(claim.crateId);
          player.openedCrates.add(claim.crateId);
        }
        return { status: 'accepted', credited: 0, cascade: null, minted: null };
      }
    }
  }

  async #roll(
    player: MockPlayer,
    source: DropSourceId,
    now: number,
    ref: string,
    ftue: boolean,
  ): Promise<Roll> {
    return (await this.#rollWithRng(player, source, now, ref, ftue)).roll;
  }

  async #rollWithRng(
    player: MockPlayer,
    source: DropSourceId,
    now: number,
    ref: string,
    ftue: boolean,
  ): Promise<{ roll: Roll; rng: Rng }> {
    const table = dropTables.find((candidate) => candidate.source === source);
    if (table === undefined)
      throw new Error(`Mock: drop table "${source}" missing from economy config.`);
    const { rng, proof } = await nextRoll(player.fair);
    const state = player.pity.get(source) ?? initialPityState(pity);
    const drawn = ftue
      ? { rarity: crateSpawn.ftueScriptedRarity as RarityId, state }
      : rollDrop(table, pity, state, rng);
    player.pity.set(source, drawn.state);
    const rewards = this.#grant(
      player,
      drawn.rarity,
      rng,
      now,
      `${source}:${ref}`,
      ftue && crateSpawn.ftueScriptedCharm,
    );
    return {
      roll: {
        rarity: drawn.rarity,
        rewards,
        proof,
        pity: {
          rare: drawn.state.rare ?? 0,
          exquisite: drawn.state.exquisite ?? 0,
          legendary: drawn.state.legendary ?? 0,
        },
      },
      rng,
    };
  }

  #grant(
    player: MockPlayer,
    rarity: RarityId,
    rng: Rng,
    now: number,
    ref: string,
    forceCharm: boolean,
  ): Reward[] {
    const def: CrateRewardDef = crateRewards[rarity];
    const rewards: Reward[] = [];
    const coins = crateIncomeCoins(
      def.incomeSeconds,
      this.#measuredActiveRate(player),
      offlineRate,
    );
    const currencyRewards: [Currency, number][] = [
      ['coins', coins],
      ['pearls', def.pearls],
      ['keys', def.keys],
      ['tickets', def.tickets],
    ];
    for (const [currency, amount] of currencyRewards) {
      if (amount <= 0) continue;
      if (currency === 'coins') this.#earn(player, now, 'loot.coins', amount, ref);
      else this.#credit(player, now, `loot.${currency}`, { [currency]: amount }, ref);
      rewards.push({ kind: 'currency', currency, amount });
    }
    if (CHARM_TYPES.length > 0 && (forceCharm || rng.nextInt(10_000) < def.charmChance)) {
      const type = CHARM_TYPES[rng.nextInt(CHARM_TYPES.length)];
      if (type !== undefined) rewards.push(this.#grantCharm(player, type.id));
    }
    if (def.albumCard) {
      const cards = ALBUM_CARDS.filter((item) => item.rarity === rarity);
      const card = cards[cards.length > 0 ? rng.nextInt(cards.length) : 0];
      if (card !== undefined) {
        player.album.set(card.id, (player.album.get(card.id) ?? 0) + 1);
        rewards.push({ kind: 'collectible', collectibleId: CollectibleIdSchema.parse(card.id) });
      }
    }
    return rewards;
  }

  #grantCharm(player: MockPlayer, typeId: string): Reward {
    const charmType = CharmTypeIdSchema.parse(typeId);
    player.album.set(typeId, (player.album.get(typeId) ?? 0) + 1);
    const owned = player.charms.find((charm) => charm.type === charmType);
    if (owned !== undefined) {
      owned.level += 1;
      return { kind: 'charm', charmId: owned.id, charmType, level: owned.level, duplicate: true };
    }
    const charm: OwnedCharm = {
      id: CharmIdSchema.parse(entityId(ENTITY_ID_PREFIXES.charm)),
      type: charmType,
      level: 1,
    };
    player.charms.push(charm);
    return { kind: 'charm', charmId: charm.id, charmType, level: 1, duplicate: false };
  }
}

type Handler<N extends EndpointName> = (
  player: MockPlayer,
  body: EndpointBody<N>,
  params: EndpointParams<N>,
  now: number,
) => EndpointResponseInput<N> | Promise<EndpointResponseInput<N>>;

export function deviceThumbprint(key: DevicePublicKey): string {
  return `${key.x}.${key.y}`;
}

/** Three of the winning rarity; every other rarity at most twice, so the grid has one match. */
function scratchGrid(winner: Rarity, rng: Rng): Rarity[] {
  const grid: Rarity[] = [winner, winner, winner];
  const fillers = RARITIES.filter((rarity) => rarity !== winner).flatMap((rarity) => [
    rarity,
    rarity,
  ]);
  while (grid.length < SCRATCH_GRID_SIZE) {
    const [picked] = fillers.splice(rng.nextInt(fillers.length), 1);
    if (picked !== undefined) grid.push(picked);
  }
  for (let i = grid.length - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    const a = grid[i];
    const b = grid[j];
    if (a !== undefined && b !== undefined) {
      grid[i] = b;
      grid[j] = a;
    }
  }
  return grid;
}
