import { venues } from '@coinposh/economy';
import {
  AmountSchema,
  CharmIdSchema,
  ClientSeedSchema,
  CoinIdSchema,
  CratePoseTupleSchema,
  CrateIdSchema,
  CurrencyIdSchema,
  DisplayNameSchema,
  DropSourceIdSchema,
  EpochMsSchema,
  LocaleSchema,
  MintedCoinSchema,
  OwnedCharmSchema,
  PlayerIdSchema,
  PoseTupleSchema,
  RarityIdSchema,
  RevealedSeedSchema,
  SafeSchema,
  ScratchCardIdSchema,
  Sha256HexSchema,
  TableCrateSchema,
  TableSessionIdSchema,
  VenueIdSchema,
  WalletSchema,
} from '@coinposh/shared';
import { SIM_SNAPSHOT_VERSION } from '@coinposh/sim/snapshot';
import { z } from 'zod';
import { SNAPSHOT_FLAG_KINDS } from './snapshot.ts';

/** The sessionStorage key the Demo Mode world lives under, one per tab. */
export const DEMO_STORAGE_KEY = 'coinposh.demo.world';

/**
 * Bumped whenever the shape below changes. A blob of any other version is dropped for a fresh
 * session rather than migrated: Demo progress only lives as long as the tab.
 */
export const DEMO_BLOB_SCHEMA_VERSION = 2;

/** The slice of the Web Storage API the mock needs, so tests can hand in a fake or a failing one. */
export interface MockStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type PersistWarn = (message: string, cause?: unknown) => void;

const int = z.int();
const tick = z.int();
const economyVenueId = VenueIdSchema.refine(
  (id) => venues.some((venue) => venue.id === id),
  'Expected a venue the economy config defines.',
);

const TickAnchorSchema = z.strictObject({
  tick,
  at: int,
  earliestAt: int,
  maxTick: tick,
  floorTick: tick.nullable(),
});

const CoinRecordSchema = z.strictObject({
  coin: MintedCoinSchema,
  place: z.enum(['buffer', 'table']),
  spawnTick: tick.nullable(),
  origin: z.enum(['drop', 'fusion', 'heap']),
  mintMicros: AmountSchema.nullable(),
  heapSlot: AmountSchema.nullable(),
  paid: AmountSchema,
  dropsBehind: AmountSchema,
});

const CrateRecordSchema = z.strictObject({
  crate: TableCrateSchema,
  ftue: z.boolean(),
  state: z.enum(['table', 'openable']),
  spawnTick: tick,
  spawnedAt: EpochMsSchema,
  relaidIn: TableSessionIdSchema.nullable(),
});

const StoredSnapshotSchema = z.strictObject({
  session: z.string(),
  seq: AmountSchema,
  tick: tick,
  pusherTick: AmountSchema,
  poses: z.array(PoseTupleSchema),
  cratePoses: z.array(CratePoseTupleSchema),
  receivedAt: EpochMsSchema,
});

const FairSeedStateSchema = z.strictObject({
  serverSeed: Sha256HexSchema,
  serverSeedHash: Sha256HexSchema,
  clientSeed: ClientSeedSchema,
  nonce: AmountSchema,
});

const PersistedPlayerSchema = z.strictObject({
  id: PlayerIdSchema,
  deviceThumbprint: z.string().min(1),
  createdAt: EpochMsSchema,
  displayName: DisplayNameSchema,
  locale: LocaleSchema,
  wallet: WalletSchema,
  venueId: economyVenueId,
  unlocked: z.array(economyVenueId).min(1),
  levels: z.array(z.tuple([z.string(), AmountSchema])),
  loadouts: z.array(z.tuple([economyVenueId, z.array(CharmIdSchema.nullable())])),
  charms: z.array(OwnedCharmSchema),
  safes: z.array(SafeSchema),
  scratchCards: z.array(ScratchCardIdSchema),
  album: z.array(z.tuple([z.string(), AmountSchema])),
  coins: z.array(CoinRecordSchema),
  gone: z.array(z.tuple([CoinIdSchema, EpochMsSchema])),
  crates: z.array(CrateRecordSchema),
  openedCrates: z.array(CrateIdSchema),
  decorumPoints: z.number().nonnegative(),
  decorumAt: EpochMsSchema,
  frozenUntil: EpochMsSchema.nullable(),
  drops: AmountSchema,
  dropHighWater: AmountSchema,
  lastDropTick: tick.nullable(),
  tickAnchor: TickAnchorSchema.nullable(),
  previousAnchor: TickAnchorSchema.nullable(),
  resumedAt: EpochMsSchema.nullable(),
  bootedAt: EpochMsSchema.nullable(),
  tableSession: TableSessionIdSchema.nullable(),
  tableSessionStartedAt: EpochMsSchema,
  tableSessionMaxTick: tick,
  tableSnapshot: StoredSnapshotSchema.nullable(),
  snapshotBucket: z
    .strictObject({ tokens: z.number().nonnegative(), at: EpochMsSchema })
    .nullable(),
  snapshotFlags: z.record(z.enum(SNAPSHOT_FLAG_KINDS), AmountSchema),
  absence: z.strictObject({ since: EpochMsSchema, until: EpochMsSchema }).nullable(),
  lastClaimTick: tick.nullable(),
  recentFalls: z.array(tick),
  recentFusions: z.array(tick),
  cascadeChain: z.strictObject({ lastTick: tick, count: AmountSchema }).nullable(),
  cascadeCarry: AmountSchema,
  mintCarry: AmountSchema,
  lifetimeValue: AmountSchema,
  lifetimeBullion: AmountSchema,
  playLog: z.array(z.strictObject({ at: EpochMsSchema, coins: int })),
  lastActiveAt: EpochMsSchema,
  fair: FairSeedStateSchema,
  revealed: z.array(RevealedSeedSchema),
  pity: z.array(z.tuple([DropSourceIdSchema, z.partialRecord(RarityIdSchema, AmountSchema)])),
});

const LedgerEntrySchema = z.strictObject({
  seq: AmountSchema,
  at: EpochMsSchema,
  playerId: PlayerIdSchema,
  reason: z.string().min(1),
  delta: z.partialRecord(CurrencyIdSchema, int),
  ref: z.string().nullable(),
});

/**
 * A Demo feature module's id (`quests`, `season`, ...). Kept to plain identifiers so no stored
 * key can be `__proto__` or another name a record would treat specially.
 */
export const FeatureIdSchema = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/);

/**
 * Feature modules keep their state in `features`, inside the same blob as the ledger their rewards
 * credit, so one write stores both or neither: a reload, or a write the quota refuses, can never
 * restore a reward without the state that marks it claimed.
 */
export const PersistedWorldSchema = z.strictObject({
  /** How many page lives restored this world before; new entity ids carry it so none repeats. */
  epoch: AmountSchema,
  nextSeq: AmountSchema,
  ledger: z.array(LedgerEntrySchema),
  checkpoints: z.array(z.tuple([PlayerIdSchema, z.record(CurrencyIdSchema, int)])),
  players: z.array(PersistedPlayerSchema),
  /** Opaque JSON per feature id; each feature validates its own slot when it reads it back. */
  features: z.record(FeatureIdSchema, z.unknown()).readonly(),
});
export type PersistedWorld = z.infer<typeof PersistedWorldSchema>;
export type PersistedPlayer = z.infer<typeof PersistedPlayerSchema>;

const DemoBlobSchema = z.strictObject({
  schema: z.literal(DEMO_BLOB_SCHEMA_VERSION),
  sim: z.literal(SIM_SNAPSHOT_VERSION),
  world: PersistedWorldSchema,
});

export function encodeDemoBlob(world: PersistedWorld): string {
  return JSON.stringify({ schema: DEMO_BLOB_SCHEMA_VERSION, sim: SIM_SNAPSHOT_VERSION, world });
}

export type DecodedBlob =
  | { readonly ok: true; readonly world: PersistedWorld }
  | { readonly ok: false; readonly reason: string };

/** Never throws: a blob that is not JSON, not this version or not this shape is a reason, not a crash. */
export function decodeDemoBlob(raw: string): DecodedBlob {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, reason: `it is not JSON (${String(error)})` };
  }
  const header = z.looseObject({ schema: z.unknown(), sim: z.unknown() }).safeParse(parsed);
  if (!header.success) return { ok: false, reason: 'it is not a CoinPosh Demo save' };
  if (header.data.schema !== DEMO_BLOB_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `it is save format ${JSON.stringify(header.data.schema)}, this build reads ${DEMO_BLOB_SCHEMA_VERSION}`,
    };
  }
  if (header.data.sim !== SIM_SNAPSHOT_VERSION) {
    return {
      ok: false,
      reason: `it holds sim snapshot version ${JSON.stringify(header.data.sim)}, this build runs ${SIM_SNAPSHOT_VERSION}`,
    };
  }
  const blob = DemoBlobSchema.safeParse(parsed);
  if (!blob.success) {
    const issue = blob.error.issues[0];
    const where = issue === undefined ? '' : ` at ${issue.path.join('.') || 'the root'}`;
    return { ok: false, reason: `its shape is invalid${where}: ${issue?.message ?? 'unknown'}` };
  }
  return { ok: true, world: blob.data.world };
}

/**
 * The tab's sessionStorage, or null outside a browser. Merely touching `sessionStorage` throws
 * in some sandboxed frames and privacy modes, and Demo Mode must still play there.
 */
export function browserSessionStorage(warn: PersistWarn): MockStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch (error) {
    warn(
      'CoinPosh demo: sessionStorage is unavailable, so a reload starts a fresh session.',
      error,
    );
    return null;
  }
}

export const consoleWarn: PersistWarn = (message, cause) => {
  if (cause === undefined) console.warn(message);
  else console.warn(message, cause);
};
