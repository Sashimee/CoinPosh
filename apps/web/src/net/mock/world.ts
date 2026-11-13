import {
  album,
  ascension,
  ascensionGoldBars,
  bullion,
  bullionFromValue,
  cascade,
  cascadeCreditMicros,
  cascadeTierFor,
  cascadeWindowTicks,
  coinTiers,
  crateRewards,
  crateIncomeCoins,
  crateSpawn,
  currencies,
  dropBufferTarget,
  dropSpacingTicks,
  dropSpawnsCrate,
  dropTables,
  extendCascade,
  fusion,
  fusionValue,
  initialPityState,
  creditMintMicros,
  measuredActiveRatePerHour,
  mintedCoinMicros,
  offline,
  offlineCapHours,
  offlineRate,
  offlineVaultCoins,
  openingHeap,
  pity,
  pushTravelTicks,
  playStretchOf,
  repriceReserved,
  rateEnvelope,
  rateEnvelopeScale,
  playWindowStart,
  rollDrop,
  season,
  upgradeCost,
  upgradeLines,
  upgradeStatAt,
  venues,
  type CascadeChain,
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
  TableSessionIdSchema,
  UpgradeLineIdSchema,
  VenueIdSchema,
  nextCoinTier,
  type CharmId,
  type CharmSlot,
  type Claim,
  type ClientSeed,
  type ClaimResult,
  type CoinId,
  type CoinTier,
  type CrateId,
  type CratePoseTuple,
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
  type PoseTuple,
  type Rarity,
  type Reward,
  type RevealedSeed,
  type Roll,
  type Safe,
  type ScratchCardId,
  type StateQuery,
  type TableCrate,
  type TableLayout,
  type TableSessionId,
  type TableSnapshotRequest,
  type TableSnapshotResponse,
  type UpgradeLevels,
  type VenueId,
  type Wallet,
} from '@coinposh/shared';
import {
  checkCratePose,
  CRATE_RIDE,
  DEFAULT_PUSHER_MOTION,
  POSITION_UNIT,
} from '@coinposh/sim/snapshot';
import { randomBase62 } from '../encoding.ts';
import { newSeed, nextRoll, reveal, type FairSeedState } from './fair.ts';
import type { PersistedPlayer, PersistedWorld } from './persist.ts';
import { MOCK_RULES } from './rules.ts';
import {
  CHUTE_POSE,
  CRATE_MAX_RIDE_SECONDS,
  elapsedSeconds,
  judgePoses,
  present,
  takeSnapshotToken,
  toCratePose,
  withinCoinTravel,
  withinCrateRide,
  type SnapshotFlagKind,
  type StoredSnapshot,
  type TokenBucket,
} from './snapshot.ts';

/** A refusal the mock answers with an error envelope, exactly like the real server would. */
export class MockFailure extends Error {
  readonly code: ErrorCode;
  readonly retryAfterMs: number | undefined;

  constructor(code: ErrorCode, message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'MockFailure';
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

/** A stored world that does not hold together; the caller drops it for a fresh session. */
export class RestoreError extends Error {
  constructor(reason: string) {
    super(`Mock: the stored Demo world is inconsistent: ${reason}.`);
    this.name = 'RestoreError';
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
  /** Millionths of a coin this coin drew from the mint carry; null for a fused coin. */
  mintMicros: number | null;
  /** The opening heap slot a boot lays this coin at when it has no stored pose. */
  heapSlot: number | null;
  /** What the wallet paid for the drops behind this coin, its own or every one fused into it. */
  paid: number;
  dropsBehind: number;
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
  spawnedAt: number;
  /**
   * The table session a boot laid this openable crate back at the lip in: its claim never
   * reached an open, so that session may claim it once more, and only that session.
   */
  relaidIn: TableSessionId | null;
}

export interface MockPlayer {
  readonly id: PlayerId;
  /** Null for a player restored from the tab's storage until a device signs in as them. */
  deviceKey: CryptoKey | null;
  deviceThumbprint: string;
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
  /** The most `drops` ever reached: a drop refunded by a boot and made again spawns nothing new. */
  dropHighWater: number;
  lastDropTick: number | null;
  tickAnchor: TickAnchor | null;
  /** The anchor a resume replaced, which still judges the ticks seen before it. */
  previousAnchor: TickAnchor | null;
  /** Server time of a resume whose new anchor waits for the first tick past the old maximum. */
  resumedAt: number | null;
  /** The last boot: the sim restarts at tick 0 then, so no tick may map to before it. */
  bootedAt: number | null;
  tableSession: TableSessionId | null;
  tableSessionStartedAt: number;
  /** Highest tick of a drop or accepted claim this session: no snapshot may go back before it. */
  tableSessionMaxTick: number;
  tableSnapshot: StoredSnapshot | null;
  /** The player's, not the session's, so booting again never buys more snapshots. */
  snapshotBucket: TokenBucket | null;
  snapshotFlags: Record<SnapshotFlagKind, number>;
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
  cascadeChain: CascadeChain | null;
  /** The fraction of a coin, in millionths, the cascade bonus carries to the next front fall. */
  cascadeCarry: number;
  /** The fraction of a coin, in millionths, the next minted coin starts from (as the server). */
  mintCarry: number;
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

const CASCADE_WINDOW_TICKS = cascadeWindowTicks(MOCK_RULES.ticksPerSecond);
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

/**
 * Where a boot lays an openable crate: on the teeter line, so it rocks at the lip for a beat
 * and goes over again, with its ride clock near the cap so it cannot hang there.
 */
const LIP_POSE_Z = Math.ceil(CRATE_RIDE.teeterZ / POSITION_UNIT);
const LIP_POSE_ELAPSED_MS = CRATE_MAX_RIDE_SECONDS * 1000 - 1_500;

export function lipPose(id: CrateId): CratePoseTuple {
  return [id, 0, LIP_POSE_Z, LIP_POSE_ELAPSED_MS, 'teeter'];
}

function persistPlayer(player: MockPlayer): PersistedPlayer {
  return {
    id: player.id,
    deviceThumbprint: player.deviceThumbprint,
    createdAt: player.createdAt,
    displayName: player.displayName,
    locale: player.locale,
    wallet: { ...player.wallet },
    venueId: VenueIdSchema.parse(player.venueId),
    unlocked: player.unlocked.map((id) => VenueIdSchema.parse(id)),
    levels: [...player.levels],
    loadouts: [...player.loadouts].map(([id, slots]) => [VenueIdSchema.parse(id), [...slots]]),
    charms: player.charms.map((charm) => ({ ...charm })),
    safes: player.safes.map((safe) => ({ ...safe })),
    scratchCards: [...player.scratchCards],
    album: [...player.album],
    coins: [...player.coins.values()].map((record) => ({ ...record, coin: { ...record.coin } })),
    gone: [...player.gone],
    crates: [...player.crates.values()].map((record) => ({
      ...record,
      crate: { ...record.crate },
    })),
    openedCrates: [...player.openedCrates],
    decorumPoints: player.decorumPoints,
    decorumAt: player.decorumAt,
    frozenUntil: player.frozenUntil,
    drops: player.drops,
    dropHighWater: player.dropHighWater,
    lastDropTick: player.lastDropTick,
    tickAnchor: player.tickAnchor === null ? null : { ...player.tickAnchor },
    previousAnchor: player.previousAnchor === null ? null : { ...player.previousAnchor },
    resumedAt: player.resumedAt,
    bootedAt: player.bootedAt,
    tableSession: player.tableSession,
    tableSessionStartedAt: player.tableSessionStartedAt,
    tableSessionMaxTick: player.tableSessionMaxTick,
    tableSnapshot:
      player.tableSnapshot === null
        ? null
        : {
            ...player.tableSnapshot,
            poses: player.tableSnapshot.poses.map((pose) => [...pose] as PoseTuple),
            cratePoses: player.tableSnapshot.cratePoses.map((pose) => [...pose] as CratePoseTuple),
          },
    snapshotBucket: player.snapshotBucket === null ? null : { ...player.snapshotBucket },
    snapshotFlags: { ...player.snapshotFlags },
    absence: player.absence === null ? null : { ...player.absence },
    lastClaimTick: player.lastClaimTick,
    recentFalls: [...player.recentFalls],
    recentFusions: [...player.recentFusions],
    cascadeChain: player.cascadeChain === null ? null : { ...player.cascadeChain },
    cascadeCarry: player.cascadeCarry,
    mintCarry: player.mintCarry,
    lifetimeValue: player.lifetimeValue,
    lifetimeBullion: player.lifetimeBullion,
    playLog: player.playLog.map((entry) => ({ ...entry })),
    lastActiveAt: player.lastActiveAt,
    fair: { ...player.fair },
    revealed: player.revealed.map((seed) => ({ ...seed })),
    pity: [...player.pity].map(([source, state]) => [source, { ...state }]),
  };
}

function restorePlayer(saved: PersistedPlayer): MockPlayer {
  const coins = new Map<CoinId, CoinRecord>();
  for (const record of saved.coins) {
    if (coins.has(record.coin.id)) throw new RestoreError(`coin ${record.coin.id} is stored twice`);
    if (record.place === 'buffer' && record.mintMicros === null) {
      throw new RestoreError(`buffered coin ${record.coin.id} has no mint micros`);
    }
    coins.set(record.coin.id, { ...record, coin: { ...record.coin } });
  }
  const crates = new Map<CrateId, CrateRecord>();
  for (const record of saved.crates) {
    if (crates.has(record.crate.id)) {
      throw new RestoreError(`crate ${record.crate.id} is stored twice`);
    }
    crates.set(record.crate.id, { ...record, crate: { ...record.crate } });
  }
  const openedCrates = new Set(saved.openedCrates);
  for (const id of crates.keys()) {
    if (openedCrates.has(id)) throw new RestoreError(`crate ${id} is both pending and opened`);
  }
  if (!saved.unlocked.includes(saved.venueId)) {
    throw new RestoreError(
      `player ${saved.id} stands at venue ${saved.venueId} without unlocking it`,
    );
  }
  return {
    ...saved,
    deviceKey: null,
    wallet: { ...saved.wallet },
    unlocked: [...saved.unlocked],
    levels: new Map(saved.levels),
    loadouts: new Map(saved.loadouts.map(([id, slots]) => [id, [...slots]])),
    charms: saved.charms.map((charm) => ({ ...charm })),
    safes: saved.safes.map((safe) => ({ ...safe })),
    scratchCards: [...saved.scratchCards],
    album: new Map(saved.album),
    coins,
    gone: new Map(saved.gone),
    crates,
    openedCrates,
    snapshotFlags: {
      'snapshot.foreign': saved.snapshotFlags['snapshot.foreign'],
      'snapshot.teleport': saved.snapshotFlags['snapshot.teleport'],
      'snapshot.implausible': saved.snapshotFlags['snapshot.implausible'],
    },
    recentFalls: [...saved.recentFalls],
    recentFusions: [...saved.recentFusions],
    playLog: saved.playLog.map((entry) => ({ ...entry })),
    fair: { ...saved.fair },
    revealed: saved.revealed.map((seed) => ({ ...seed })),
    pity: new Map(saved.pity.map(([source, state]) => [source, { ...state }])),
  };
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
  /** Page lives this world was restored through; 0 for a world that started in this page. */
  #epoch = 0;
  /**
   * Openable crates whose claim this page life accepted. The client that holds that claim may
   * still have its open in flight, so an in-page re-boot must not lay the crate back at the lip.
   * Never stored: after a reload every open that was in flight died with the page.
   */
  readonly #claimedThisPage = new Set<CrateId>();
  /** Table snapshots accepted per player in this page life; never stored, like the claims above. */
  readonly #acceptedSnapshots = new Map<PlayerId, number>();

  /**
   * A seeded Demo page replays the same `crypto` stream after every reload, so ids minted in a
   * restored world carry its epoch: none can repeat one minted before the reload.
   */
  #entityId(prefix: string): string {
    const epoch = this.#epoch === 0 ? '' : this.#epoch.toString(36).padStart(3, '0');
    return `${prefix}_${randomBase62(16)}${epoch}`;
  }

  /** Everything the rules own, as plain data for the tab's storage. Device keys never leave WebCrypto. */
  serialize(): PersistedWorld {
    return {
      epoch: this.#epoch,
      nextSeq: this.#nextSeq,
      ledger: this.#ledger.map((entry) => ({ ...entry, delta: { ...entry.delta } })),
      checkpoints: [...this.#checkpoints].map(([id, wallet]) => [id, { ...wallet }]),
      players: [...this.#players.values()].map(persistPlayer),
    };
  }

  /**
   * Rebuilds a world from {@link serialize}. The blob sits in storage the page can edit, so it
   * must also add up: every wallet has to equal its checkpoint plus its ledger entries, or the
   * whole blob is refused. Restored players are unbound until {@link bindDevice}.
   */
  static restore(data: PersistedWorld): MockWorld {
    const world = new MockWorld();
    world.#epoch = data.epoch + 1;
    world.#nextSeq = data.nextSeq;
    for (const [id, wallet] of data.checkpoints) world.#checkpoints.set(id, { ...wallet });
    for (const saved of data.players) {
      if (world.#players.has(saved.id)) {
        throw new RestoreError(`player ${saved.id} is stored twice`);
      }
      if (world.#byDevice.has(saved.deviceThumbprint)) {
        throw new RestoreError(`two players share the device ${saved.deviceThumbprint}`);
      }
      world.#players.set(saved.id, restorePlayer(saved));
      world.#byDevice.set(saved.deviceThumbprint, saved.id);
    }
    let lastSeq = -1;
    for (const entry of data.ledger) {
      if (entry.seq <= lastSeq || entry.seq >= data.nextSeq) {
        throw new RestoreError(`ledger entry ${entry.seq} is out of sequence`);
      }
      if (!world.#players.has(entry.playerId)) {
        throw new RestoreError(`ledger entry ${entry.seq} names an unknown player`);
      }
      lastSeq = entry.seq;
      world.#ledger.push({ ...entry, delta: { ...entry.delta } });
    }
    for (const player of world.#players.values()) {
      const replayed = world.ledgerCheckpoint(player.id);
      for (const entry of world.#ledger) {
        if (entry.playerId !== player.id) continue;
        for (const [currency, amount] of Object.entries(entry.delta) as [Currency, number][]) {
          replayed[currency] += amount;
        }
      }
      for (const currency of Object.keys(replayed) as Currency[]) {
        if (replayed[currency] !== player.wallet[currency]) {
          throw new RestoreError(
            `player ${player.id} holds ${player.wallet[currency]} ${currency} but the ledger adds up to ${replayed[currency]}`,
          );
        }
      }
    }
    return world;
  }

  /**
   * Signs `key` in as a player. A device the world knows gets its own player back. In a
   * restored world the tab's first new device takes over the most recently active player that
   * no device holds yet: the client's key lived in page memory and died with the reload, and
   * sessionStorage scopes this world to the one tab that played it.
   */
  bindDevice(publicKey: DevicePublicKey, key: CryptoKey): MockPlayer | undefined {
    const thumbprint = deviceThumbprint(publicKey);
    const known = this.playerByDevice(thumbprint);
    const player =
      known ??
      [...this.#players.values()]
        .filter((candidate) => candidate.deviceKey === null)
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
    if (player === undefined) return undefined;
    this.#byDevice.delete(player.deviceThumbprint);
    player.deviceKey = key;
    player.deviceThumbprint = thumbprint;
    this.#byDevice.set(thumbprint, player.id);
    return player;
  }

  /**
   * A seed pair no player of this world has used. A seeded Demo source restarts its sequence
   * on reload and would otherwise hand back a server seed that was already revealed.
   */
  async #freshSeed(player: MockPlayer, clientSeed: ClientSeed): Promise<FairSeedState> {
    const used = new Set([
      player.fair.serverSeedHash,
      ...player.revealed.map((seed) => seed.serverSeedHash),
    ]);
    for (let attempt = 0; attempt <= used.size; attempt++) {
      const seed = await newSeed(clientSeed);
      if (!used.has(seed.serverSeedHash)) return seed;
    }
    throw new Error(
      `Mock: the seed source returned only used server seeds in ${used.size + 1} tries; check the Demo seed fixture.`,
    );
  }

  /** The most recent `ledgerRetained` entries; older ones live on in {@link ledgerCheckpoint}. */
  get ledger(): readonly LedgerEntry[] {
    return this.#ledger;
  }

  /** What a player's evicted ledger entries add up to: replaying the ledger starts here. */
  ledgerCheckpoint(id: PlayerId): Wallet {
    return { ...(this.#checkpoints.get(id) ?? emptyWallet()) };
  }

  /** How many table snapshots this page life accepted from the player, for the Demo test handle. */
  acceptedSnapshots(id: PlayerId): number {
    return this.#acceptedSnapshots.get(id) ?? 0;
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
      dropHighWater: 0,
      lastDropTick: null,
      tickAnchor: null,
      previousAnchor: null,
      resumedAt: null,
      bootedAt: null,
      tableSession: null,
      tableSessionStartedAt: now,
      tableSessionMaxTick: 0,
      tableSnapshot: null,
      snapshotBucket: null,
      snapshotFlags: { 'snapshot.foreign': 0, 'snapshot.teleport': 0, 'snapshot.implausible': 0 },
      absence: null,
      lastClaimTick: null,
      recentFalls: [],
      recentFusions: [],
      cascadeChain: null,
      cascadeCarry: 0,
      mintCarry: 0,
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
    this.#append(player, now, reason, moved, ref);
  }

  #append(
    player: MockPlayer,
    now: number,
    reason: string,
    delta: Partial<Record<Currency, number>>,
    ref: string | null,
  ): void {
    this.#ledger.push({
      seq: this.#nextSeq++,
      at: now,
      playerId: player.id,
      reason,
      delta,
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

  #coinMicros(player: MockPlayer, tier: CoinTier): number {
    const def = coinTiers.find((candidate) => candidate.id === tier);
    if (def === undefined)
      throw new Error(`Mock: coin tier "${tier}" missing from economy config.`);
    return mintedCoinMicros(def, venueDef(player.venueId), levelMap(player));
  }

  #mint(
    player: MockPlayer,
    tier: CoinTier,
    value: number,
    mintMicros: number | null,
    place: CoinRecord['place'],
    spawnTick: number | null,
    origin: CoinRecord['origin'] = 'drop',
  ) {
    const coin: MintedCoin = {
      id: CoinIdSchema.parse(this.#entityId(ENTITY_ID_PREFIXES.coin)),
      tier,
      value,
    };
    player.coins.set(coin.id, {
      coin,
      place,
      spawnTick,
      origin,
      mintMicros,
      heapSlot: null,
      paid: 0,
      dropsBehind: 0,
    });
    return coin;
  }

  /** Mints a coin worth its share of the multiplier: the fraction a floor drops is carried on. */
  #mintFromCarry(
    player: MockPlayer,
    tier: CoinTier,
    place: CoinRecord['place'],
    spawnTick: number | null,
    origin: CoinRecord['origin'] = 'drop',
  ) {
    const micros = this.#coinMicros(player, tier);
    const credit = creditMintMicros(micros, player.mintCarry);
    player.mintCarry = credit.carry;
    return this.#mint(player, tier, credit.value, micros, place, spawnTick, origin);
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
    for (let i = 0; i < openingHeap.coins; i++) {
      const coin = this.#mintFromCarry(player, openingHeap.tier, 'table', 0, 'heap');
      this.#record(player, coin.id).heapSlot = i;
    }
  }

  /**
   * Buffered coins are paid for but their value is minted on drop, so a coinValue purchase
   * reprices them and the very next drop carries the bought level, as on the server. Each is
   * credited only the raise, through the carry, so what was already minted is not counted twice.
   */
  #revalueBuffer(player: MockPlayer): void {
    const reserved = [...player.coins.values()].filter(
      (record) => record.place === 'buffer' && record.coin.tier === DROP_TIER.id,
    );
    const repriced = repriceReserved(
      reserved.map((record) => {
        if (record.mintMicros === null)
          throw new Error('Mock: a buffered coin has no mint micros.');
        return { value: record.coin.value, micros: record.mintMicros };
      }),
      this.#coinMicros(player, DROP_TIER.id),
      player.mintCarry,
    );
    reserved.forEach((record, i) => {
      const next = repriced.reserved[i];
      if (next === undefined) throw new Error('Mock: repriceReserved returned fewer coins.');
      record.coin = { ...record.coin, value: next.value };
      record.mintMicros = next.micros;
    });
    player.mintCarry = repriced.carry;
  }

  /** Tops the buffer up with coins paid for now, so an offline drop never creates value later. */
  #refillBuffer(player: MockPlayer, now: number): void {
    let buffered = this.#buffer(player).length;
    const target = dropBufferTarget(MOCK_RULES.bufferSize, levelMap(player));
    while (buffered < target && player.wallet.coins >= DROP_TIER.value) {
      const coin = this.#mintFromCarry(player, DROP_TIER.id, 'buffer', null);
      this.#credit(player, now, 'drop.prepay', { coins: -DROP_TIER.value }, coin.id);
      this.#record(player, coin.id).paid = DROP_TIER.value;
      buffered++;
    }
  }

  #record(player: MockPlayer, id: CoinId): CoinRecord {
    const record = player.coins.get(id);
    if (record === undefined) throw new Error(`Mock: coin ${id} was just minted but is missing.`);
    return record;
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
        earliestAt: Math.max(
          player.createdAt,
          player.bootedAt ?? player.createdAt,
          now - MOCK_RULES.claimExpiryMs,
        ),
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

  /** The global lines alone: they survive an ascension, so they are reported apart from the venue's. */
  #familyOfficeLevels(player: MockPlayer): UpgradeLevels {
    const levels: UpgradeLevels = {};
    for (const def of upgradeLines) {
      if (def.scope !== 'global') continue;
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
    query: StateQuery = {},
  ): Promise<EndpointResponseInput<N>> {
    this.#pruneGone(player, now);
    if (now - player.lastActiveAt >= MOCK_RULES.minOfflineMs) {
      player.absence = { since: player.lastActiveAt, until: now };
    }
    const handler: Handler<N> = this.#handlers[name];
    return handler(player, body, params, now, query);
  }

  /**
   * Stores where the client's sim says the table rests, through the server's pipeline
   * (92-table-persistence 3.2). A pose that is not this table's, not plausible, or moved
   * further than the table can move it is dropped. Never touches the wallet, ledger or coins.
   */
  snapshot(player: MockPlayer, body: TableSnapshotRequest, now: number): TableSnapshotResponse {
    if (player.tableSession !== body.session) {
      throw new MockFailure(
        'session_superseded',
        'Another tab or device has booted this table since. Reload to play here.',
      );
    }
    const stored = player.tableSnapshot;
    const previous = stored?.session === body.session ? stored : null;
    const floorTick = Math.max(previous?.tick ?? 0, player.tableSessionMaxTick);
    if (previous !== null && body.seq <= previous.seq) {
      throw new MockFailure(
        'stale_snapshot',
        `Snapshot seq ${body.seq} is not after the stored ${previous.seq}. Send the next seq.`,
      );
    }
    if (body.tick < floorTick) {
      throw new MockFailure(
        'stale_snapshot',
        `Snapshot tick ${body.tick} is before tick ${floorTick} the table already reached.`,
      );
    }
    const take = takeSnapshotToken(player.snapshotBucket, now);
    if (!take.ok) {
      throw new MockFailure(
        'rate_limited',
        'Table snapshots are sent too often. Retry later.',
        take.retryAfterMs,
      );
    }
    if (body.pusher.tickInCycle >= DEFAULT_PUSHER_MOTION.periodTicks) {
      throw new MockFailure(
        'bad_request',
        `pusher.tickInCycle must be below ${DEFAULT_PUSHER_MOTION.periodTicks}.`,
      );
    }
    player.snapshotBucket = take.bucket;

    let ignored = 0;
    let foreign = 0;
    let teleport = 0;
    const tableCoins = this.#tableCoins(player).map((coin) => coin.id);
    const onTable = new Set(tableCoins);
    const owned: PoseTuple[] = [];
    for (const pose of body.coins) {
      if (onTable.has(pose[0])) {
        owned.push(pose);
        continue;
      }
      ignored++;
      if (player.coins.get(pose[0])?.place !== 'table' && !player.gone.has(pose[0])) foreign++;
    }
    const judged = judgePoses(tableCoins, owned, body.pusher.tickInCycle);
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

    // A pose kept from the last snapshot was judged against that pusher tick and those
    // neighbours: it is stored only if a boot would still lay it beside the fresh poses, which
    // go first so a stale pose never displaces one. A boot then refunds no coin it was handed.
    const carried = tableCoins.filter((id) => !accepted.has(id) && coinsBefore.has(id));
    const restorable = judgePoses(
      [...accepted.keys(), ...carried],
      present([...accepted.values(), ...carried.map((id) => coinsBefore.get(id))]),
      body.pusher.tickInCycle,
    ).ok;

    let implausibleCrates = 0;
    const tableCrates = this.#tableCrates(player);
    const cratesOnTable = new Map(tableCrates.map((record) => [record.crate.id, record]));
    const cratesBefore = new Map((previous?.cratePoses ?? []).map((pose) => [pose[0], pose]));
    const acceptedCrates = new Map<CrateId, CratePoseTuple>();
    for (const tuple of body.crates) {
      const record = cratesOnTable.get(tuple[0]);
      if (record === undefined) {
        ignored++;
        if (!player.crates.has(tuple[0]) && !player.openedCrates.has(tuple[0])) foreign++;
        continue;
      }
      const pose = toCratePose(tuple);
      if (!checkCratePose(pose, CRATE_MAX_RIDE_SECONDS).ok) {
        ignored++;
        implausibleCrates++;
        continue;
      }
      const from = cratesBefore.get(record.crate.id);
      const rides =
        from === undefined
          ? withinCrateRide(
              CHUTE_POSE,
              pose,
              elapsedSeconds(
                body.tick - record.spawnTick,
                Math.max(record.spawnedAt, player.tableSessionStartedAt),
                now,
              ),
            )
          : withinCrateRide(toCratePose(from), pose, seconds);
      if (!rides) {
        ignored++;
        teleport++;
        continue;
      }
      acceptedCrates.set(record.crate.id, tuple);
    }

    player.tableSnapshot = {
      session: body.session,
      seq: body.seq,
      tick: body.tick,
      pusherTick: body.pusher.tickInCycle,
      poses: present(tableCoins.map((id) => restorable.get(id))),
      cratePoses: present(
        tableCrates.map(
          (record) => acceptedCrates.get(record.crate.id) ?? cratesBefore.get(record.crate.id),
        ),
      ),
      receivedAt: now,
    };
    player.snapshotFlags['snapshot.foreign'] += foreign;
    player.snapshotFlags['snapshot.teleport'] += teleport;
    player.snapshotFlags['snapshot.implausible'] += judged.dropped + implausibleCrates;
    this.#acceptedSnapshots.set(player.id, this.acceptedSnapshots(player.id) + 1);
    return { seq: body.seq, stored: accepted.size + acceptedCrates.size, ignored };
  }

  #tableCrates(player: MockPlayer): CrateRecord[] {
    return [...player.crates.values()].filter((record) => record.state === 'table');
  }

  #startTableSession(player: MockPlayer, now: number): TableSessionId {
    const session = TableSessionIdSchema.parse(this.#entityId(ENTITY_ID_PREFIXES.tableSession));
    player.tableSession = session;
    player.tableSessionStartedAt = now;
    player.tableSessionMaxTick = 0;
    return session;
  }

  /** A table op naming another session leaves the mark alone. */
  #raiseSessionTick(player: MockPlayer, session: TableSessionId | undefined, tick: number): void {
    if (player.tableSession === null) return;
    if (session !== undefined && session !== player.tableSession) return;
    player.tableSessionMaxTick = Math.max(player.tableSessionMaxTick, tick);
  }

  /**
   * Starts a new table session and places every table coin and crate, as the server's
   * bootTable: a coin from its stored pose when the sim's checks still pass it, a heap coin
   * without one at its heap slot, any other coin refunded at most what was paid for it.
   */
  #bootTable(player: MockPlayer, now: number): { layout: TableLayout; crates: TableCrate[] } {
    const stored = player.tableSnapshot;
    const usable =
      stored !== null && stored.pusherTick < DEFAULT_PUSHER_MOTION.periodTicks ? stored : null;
    const pusherTick = usable?.pusherTick ?? 0;
    const session = this.#startTableSession(player, now);
    const before = this.#tableCoins(player).map((coin) => coin.id);
    const poses = judgePoses(before, usable?.poses ?? [], pusherTick).ok;
    for (const id of before) {
      const record = this.#record(player, id);
      if (record.heapSlot !== null || poses.has(id)) continue;
      const refund = Math.min(record.paid, record.coin.value);
      this.#forget(player, id, now);
      player.drops -= record.dropsBehind;
      if (player.drops < 0) {
        throw new Error('Mock: a boot refunded more drops than were ever made.');
      }
      // The live server books the house's share too, so a coin nothing was paid for still
      // leaves a ledger entry instead of vanishing from the table unrecorded.
      if (refund > 0) this.#credit(player, now, 'refund.table', { coins: refund }, id);
      else this.#append(player, now, 'refund.table', {}, id);
    }
    player.cascadeChain = null;
    this.#rebaseTicks(player, now);
    this.#refillBuffer(player, now);

    const coins = this.#tableCoins(player);
    const crates = this.#tableCrates(player);
    const relaid = this.#openableCrates(player);
    for (const record of relaid) record.relaidIn = session;
    const cratePoses = new Map(
      (usable?.cratePoses ?? [])
        .filter((tuple) => checkCratePose(toCratePose(tuple), CRATE_MAX_RIDE_SECONDS).ok)
        .map((tuple) => [tuple[0], tuple]),
    );
    player.tableSnapshot = {
      session,
      seq: 0,
      tick: 0,
      pusherTick,
      poses: present(coins.map((coin) => poses.get(coin.id))),
      cratePoses: present(crates.map((record) => cratePoses.get(record.crate.id))),
      receivedAt: now,
    };
    const layout: TableLayout = {
      pusher: { tickInCycle: pusherTick },
      coins: coins.map((coin) => {
        const pose = poses.get(coin.id);
        if (pose !== undefined) return { kind: 'pose', pose };
        const slot = this.#record(player, coin.id).heapSlot;
        if (slot !== null) return { kind: 'heapSlot', slot };
        throw new Error(`Mock: table coin ${coin.id} has neither a pose nor a heap slot.`);
      }),
      crates: [
        ...crates.map((record) => {
          const pose = cratePoses.get(record.crate.id);
          return pose === undefined ? { kind: 'chute' as const } : { kind: 'pose' as const, pose };
        }),
        ...relaid.map((record) => ({ kind: 'pose' as const, pose: lipPose(record.crate.id) })),
      ],
    };
    return { layout, crates: [...crates, ...relaid].map((record) => record.crate) };
  }

  /** Crates won over the lip whose open never reached the server, oldest first. */
  #openableCrates(player: MockPlayer): CrateRecord[] {
    return [...player.crates.values()].filter(
      (record) => record.state === 'openable' && !this.#claimedThisPage.has(record.crate.id),
    );
  }

  /**
   * The booted sim counts from tick 0 again. Every tick the rules remember moves into that frame
   * by the ticks that passed in real time, so the rate envelopes and drop spacing keep holding
   * across a reload instead of starting over, and the clock re-anchors no earlier than the boot.
   */
  #rebaseTicks(player: MockPlayer, now: number): void {
    const anchor = player.tickAnchor;
    const shift =
      anchor === null
        ? 0
        : Math.ceil(Math.max(anchor.maxTick, anchor.tick + (now - anchor.at) / MS_PER_TICK));
    const rebase = (tick: number) => tick - shift;
    player.recentFalls = player.recentFalls.map(rebase);
    player.recentFusions = player.recentFusions.map(rebase);
    if (player.lastDropTick !== null) player.lastDropTick = rebase(player.lastDropTick);
    if (player.lastClaimTick !== null) player.lastClaimTick = rebase(player.lastClaimTick);
    for (const record of player.coins.values()) {
      if (record.place === 'table') record.spawnTick = 0;
    }
    for (const record of player.crates.values()) record.spawnTick = 0;
    player.tickAnchor = null;
    player.previousAnchor = null;
    player.resumedAt = null;
    player.bootedAt = now;
  }

  readonly #handlers: { [N in WorldEndpoint]: Handler<N> } = {
    state: (player, _body, _params, now, query) => {
      const absence = player.absence;
      player.absence = null;
      if (absence !== null && player.tickAnchor !== null) player.resumedAt = now;
      const settlement =
        absence === null ? null : this.#settleOffline(player, absence.until - absence.since, now);
      let layout: TableLayout | null = null;
      let crates = this.#tableCrates(player).map((record) => record.crate);
      if (query.hydrate === 'boot') {
        ({ layout, crates } = this.#bootTable(player, now));
      } else {
        if (player.tableSession === null) this.#startTableSession(player, now);
        this.#refillBuffer(player, now);
      }
      const session = player.tableSession;
      if (session === null) throw new Error('Mock: state left the table without a session.');
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
          lifetimeBullion: player.lifetimeBullion,
        },
        table: {
          session,
          coins: this.#tableCoins(player),
          crates,
          buffer: this.#buffer(player),
          decorum: this.#decorum(player, now),
          frozenUntil: player.frozenUntil,
          layout,
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
        familyOffice: this.#familyOfficeLevels(player),
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
        coin = this.#mintFromCarry(player, DROP_TIER.id, 'table', body.tick);
        this.#record(player, coin.id).paid = DROP_TIER.value;
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
      this.#record(player, coin.id).dropsBehind = 1;
      player.lastDropTick = body.tick;
      this.#raiseSessionTick(player, body.session, body.tick);
      player.drops += 1;
      const spawnedCrates: TableCrate[] = [];
      if (player.drops > player.dropHighWater) {
        player.dropHighWater = player.drops;
        if (player.drops % season.dropsPerStar === 0) {
          this.#credit(player, now, 'season.drops', { stars: 1 });
        }
        const ftue = player.drops === crateSpawn.ftueScriptedDrop;
        if (dropSpawnsCrate(player.drops, levelMap(player))) {
          const crate: TableCrate = {
            id: CrateIdSchema.parse(this.#entityId(ENTITY_ID_PREFIXES.crate)),
            kind: 'vault',
          };
          player.crates.set(crate.id, {
            crate,
            ftue,
            state: 'table',
            spawnTick: body.tick,
            spawnedAt: now,
            relaidIn: null,
          });
          spawnedCrates.push(crate);
        }
      }
      this.#refillBuffer(player, now);
      return { coin, buffer: this.#buffer(player), spawnedCrates, wallet: player.wallet };
    },

    tableClaims: (player, body, _params, now) => {
      const results = body.claims.map((claim) => {
        const result = this.#claim(player, claim, now);
        if (result.status === 'accepted') this.#raiseSessionTick(player, body.session, claim.tick);
        return result;
      });
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
      this.#claimedThisPage.delete(body.crateId);
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
      // The new venue opens on a fresh heap; the stored poses described the coins just forgotten.
      player.tableSnapshot = null;
      this.#seedOpeningHeap(player);
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
      player.fair = await this.#freshSeed(player, body.clientSeed ?? player.fair.clientSeed);
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
        const chain = extendCascade(player.cascadeChain, claim.tick, CASCADE_WINDOW_TICKS);
        player.cascadeChain = chain;
        const tier = cascadeTierFor(chain.count, cascade);
        const credit = creditMintMicros(
          cascadeCreditMicros(record.coin.value, chain.count),
          player.cascadeCarry,
        );
        player.cascadeCarry = credit.carry;
        const credited = credit.value;
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
        const minted = this.#mint(player, next, value, null, 'table', claim.tick, 'fusion');
        const fused = this.#record(player, minted.id);
        for (const record of records) {
          fused.paid += record.paid;
          fused.dropsBehind += record.dropsBehind;
        }
        return { status: 'accepted', credited: 0, cascade: null, minted };
      }
      case 'crate': {
        const record = player.crates.get(claim.crateId);
        if (record === undefined) {
          return reject(
            player.openedCrates.has(claim.crateId) ? 'already_claimed' : 'unknown_entity',
          );
        }
        if (record.state === 'openable') {
          if (record.relaidIn === null || record.relaidIn !== player.tableSession) {
            return reject('already_claimed');
          }
          if (claim.tick < record.spawnTick) return reject('not_on_table');
          record.relaidIn = null;
          this.#claimedThisPage.add(claim.crateId);
          player.lastClaimTick = claim.tick;
          return { status: 'accepted', credited: 0, cascade: null, minted: null };
        }
        if (claim.tick < record.spawnTick) return reject('not_on_table');
        player.lastClaimTick = claim.tick;
        if (claim.edge === 'front') {
          record.state = 'openable';
          this.#claimedThisPage.add(claim.crateId);
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
      id: CharmIdSchema.parse(this.#entityId(ENTITY_ID_PREFIXES.charm)),
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
  query: StateQuery,
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
