import type { Rotation, Vector, World } from '@dimforge/rapier3d-deterministic-compat';
import { GRAVITY, SIM_VERSION } from './constants.ts';
import { StateHasher } from './hash.ts';
import { assertValidInput, type SimInput } from './inputs.ts';
import { type MechanicEvent, type MechanicsConfig, TableMechanics } from './mechanics/mechanics.ts';
import { TOWER_TUNING } from './mechanics/tuning.ts';
import { Xoshiro128ss } from './prng.ts';
import { type AnyPropSpec, type BoundProp, bindProps, type PropCoin } from './props/index.ts';
import { type PropEvent, propKeepClear, type PropState, TableProps } from './props/world.ts';
import { loadRapier, type Rapier } from './rapier.ts';
import {
  type CoinPose,
  dequantizePosition,
  dequantizeRotation,
  quantizePosition,
  type PropSnapshot,
  quantizeRotation,
  SIM_SNAPSHOT_VERSION,
  type SimTableSnapshot,
} from './snapshot/snapshot.ts';
import { validateSnapshot } from './snapshot/validate.ts';
import {
  configureTableWorld,
  CRATE_BODY,
  type ContactEvent,
  type CrateFallEvent,
  type CrateImpactEvent,
  type FallEvent,
  type HeapKeepClear,
  type HeapLayout,
  PusherTable,
  type PusherState,
  type RestoreCoin,
  TABLE_SOLVER,
} from './table/index.ts';

/** Coins laid on the table before the first tick; see HEAP_TUNING. */
export interface OpeningHeap {
  readonly coins: number;
  /** Their tier, from the mechanics' ladder; the lowest when omitted. Needs mechanics. */
  readonly tier?: string;
}

export interface SimOptions {
  /** uint32 seed for every random choice the sim makes. */
  readonly seed: number;
  /**
   * Contact Fusion and the Champagne Tower, with the tier ladder and fusion rules from
   * packages/shared and packages/economy. Without it coins have no tier and nothing
   * fuses. A config without `tower` stands one at TOWER_TUNING.placement; null for none.
   */
  readonly mechanics?: MechanicsConfig<string>;
  /** Mutually exclusive with `restore`. */
  readonly openingHeap?: OpeningHeap;
  /**
   * A saved table to lay instead of an opening heap; see SimRestore. Refused on a Sim
   * with a Champagne Tower.
   */
  readonly restore?: SimRestore;
  /**
   * Pegs, movers, prizes, fields and targets on the table, by kind (PROP_KINDS), checked
   * by bindProps and stepped in ascending id order. None when omitted or empty, and a Sim
   * without props hashes and snapshots as it did before props existed.
   */
  readonly props?: readonly AnyPropSpec[];
}

/**
 * One coin of a restored table. A `heapSlot` is a heap coin with no pose worth keeping:
 * it is laid again at slot `slot` of the opening heap, as `openingHeap` lays it on a
 * Sim with this seed and mechanics. `tier` is as for OpeningHeap.
 */
export type RestoreEntry =
  | { readonly kind: 'pose'; readonly pose: CoinPose; readonly tier?: string }
  | { readonly kind: 'heapSlot'; readonly slot: number; readonly tier?: string };

/**
 * A table to restore, from Sim.snapshot() and the heap. The Sim starts at tick 0 with a
 * fresh PRNG, the pusher `pusherTickInCycle` ticks into its first cycle, and entry i as
 * coin id i, every coin at rest velocity. Poses must pass validateSnapshot. A heap slot
 * that overlaps a coin before it or the pusher is lifted clear and restores awake; an
 * `asleep` pose restores asleep if something at rest below holds it (PusherTable.restore).
 * Fusion streaks start over, and every restored coin is idle like the opening heap: it
 * fuses only once a fresh coin of its tier wakes it (FUSION_TUNING.wakeFromTier).
 * `restore` with every entry `heapSlot` 0..n − 1 lays the same table as
 * `openingHeap: { coins: n }`.
 */
export interface SimRestore {
  readonly pusherTickInCycle: number;
  readonly coins: readonly RestoreEntry[];
  /**
   * The props' state from Sim.snapshot(): one entry for every prop in `props`. When
   * omitted, every prop starts afresh as on a new Sim.
   */
  readonly props?: readonly PropSnapshot[];
}

/** What happened during one step, each event stamped with the tick after it. */
export interface SimEvents {
  /** Coins that left the table, in ascending id order. */
  readonly falls: readonly FallEvent[];
  /** Coins that struck something, in ascending id order. */
  readonly contacts: readonly ContactEvent[];
  /** Fusions, then tower captures and topples; always empty without mechanics. */
  readonly mechanics: readonly MechanicEvent<string>[];
  /** Crates that left the table, in ascending crate id order. */
  readonly crateFalls: readonly CrateFallEvent[];
  /** Crates that landed or were knocked hard, in ascending crate id order. */
  readonly crateImpacts: readonly CrateImpactEvent[];
  /** Dynamic props that fell, then coins that entered a prop; always empty without props. */
  readonly props: readonly PropEvent[];
}

/**
 * Engine build and solver settings as the table's world holds them (world units,
 * TABLE_SOLVER.worldScale per metre; seconds per substep).
 */
export interface EngineInfo {
  readonly simVersion: number;
  readonly rapierVersion: string;
  readonly substepTimestep: number;
  readonly substeps: number;
  readonly worldScale: number;
  readonly lengthUnit: number;
  readonly normalizedPredictionDistance: number;
  readonly numSolverIterations: number;
  readonly numInternalPgsIterations: number;
  readonly maxCcdSubsteps: number;
}

/** A coin's pose in metres. */
export interface CoinState {
  readonly id: number;
  readonly translation: Readonly<Vector>;
  readonly rotation: Readonly<Rotation>;
  /**
   * At rest (TableCoin.sleeping). A sleeping coin on the pusher top still rides the
   * block, so its translation can change while it sleeps.
   */
  readonly sleeping: boolean;
  /** Null on a Sim without mechanics. */
  readonly tier: string | null;
}

/** A crate's pose in metres; crate ids count from 0, apart from coin ids. */
export interface CrateState {
  readonly id: number;
  readonly translation: Readonly<Vector>;
  readonly rotation: Readonly<Rotation>;
}

/**
 * The authoritative simulation: the pusher table in a Rapier world that holds
 * nothing else, driven one fixed tick at a time by player inputs. Everything it
 * exposes is in metres; only the table reads the scaled world.
 */
export class Sim {
  readonly seed: number;
  readonly #rapier: Rapier;
  readonly #world: World;
  readonly #table: PusherTable;
  readonly #rng: Xoshiro128ss;
  readonly #mechanics: TableMechanics<string> | null;
  readonly #tiers: readonly string[] | null;
  readonly #props: TableProps | null;
  #tick = 0;
  #disposed = false;

  static async create(options: SimOptions): Promise<Sim> {
    return new Sim(await loadRapier(), options);
  }

  /**
   * The most coins `openingHeap` can ask for on a Sim made with `mechanics`. A tower keeps
   * its pedestal bare, so a Sim with one holds fewer. A Sim that fuses lays the same heap
   * as one that does not: the heap is idle (FUSION_TUNING.freshTicks, wakeFromTier), so
   * its second layer does not fuse with the coins it rests on until a fresh coin wakes it.
   */
  static heapCapacity(
    mechanics?: MechanicsConfig<string>,
    props: readonly AnyPropSpec[] = [],
  ): number {
    return PusherTable.heapCapacity(heapLayout(mechanics, bindProps(props)));
  }

  private constructor(rapier: Rapier, options: SimOptions) {
    this.seed = options.seed;
    this.#rng = Xoshiro128ss.fromSeed(options.seed);
    this.#rapier = rapier;
    const config = options.mechanics;
    this.#tiers = config ? config.tiers : null;
    const { restore, openingHeap } = options;
    if (restore && openingHeap) {
      throw new RangeError('Sim: restore and openingHeap are mutually exclusive; pass one');
    }
    if (restore && config && config.tower !== null) {
      throw new RangeError(
        'Sim: restore refuses a Sim with a Champagne Tower; pass mechanics with tower: null',
      );
    }
    const props = bindProps(options.props ?? []);
    if (props.length === 0 && restore?.props !== undefined && restore.props.length > 0) {
      throw new RangeError('Sim: restore.props holds props, but options.props has none');
    }
    const layout = heapLayout(config, props);
    const entries = restore
      ? this.#restoreEntries(restore, layout)
      : openingHeap
        ? this.#heapEntries(openingHeap)
        : [];
    const tiers = entries.map(({ tier }, i) =>
      this.#ladderTier(tier, restore ? `restore.coins[${i}].tier` : 'openingHeap.tier'),
    );
    if (openingHeap) {
      this.#ladderTier(openingHeap.tier, 'openingHeap.tier');
    }
    this.#world = new rapier.World(GRAVITY);
    try {
      configureTableWorld(this.#world);
      this.#table = new PusherTable(rapier, this.#world, {
        pusherTickInCycle: restore?.pusherTickInCycle ?? 0,
      });
      this.#mechanics = config
        ? new TableMechanics(rapier, this.#world, this.#table, config)
        : null;
      this.#props =
        props.length > 0
          ? new TableProps(rapier, this.#world, this.#table, props, restore?.props)
          : null;
      const laid = this.#lay(entries, layout);
      const mechanics = this.#mechanics;
      if (mechanics) {
        mechanics.layCoins(
          laid.map((id, i) => {
            const tier = tiers[i];
            if (tier === undefined || tier === null) {
              throw new Error(`Sim: laid coin ${id} has no tier on a Sim with mechanics`);
            }
            return { id, tier };
          }),
        );
      }
      this.#props?.prime(this.#propCoins());
    } catch (error) {
      this.#world.free();
      throw error;
    }
  }

  get tick(): number {
    return this.#tick;
  }

  /** Recorded with input logs so an auditor can refuse a replay on a mismatched engine. */
  get engine(): EngineInfo {
    const params = this.#world.integrationParameters;
    return {
      simVersion: SIM_VERSION,
      rapierVersion: this.#rapier.version(),
      substepTimestep: this.#world.timestep,
      substeps: TABLE_SOLVER.substeps,
      worldScale: TABLE_SOLVER.worldScale,
      lengthUnit: params.lengthUnit,
      normalizedPredictionDistance: params.normalizedPredictionDistance,
      numSolverIterations: params.numSolverIterations,
      numInternalPgsIterations: params.numInternalPgsIterations,
      maxCcdSubsteps: params.maxCcdSubsteps,
    };
  }

  get coinCount(): number {
    return this.#table.coinCount;
  }

  /** The tier ladder the Sim was created with, or null without mechanics. */
  get tiers(): readonly string[] | null {
    return this.#tiers;
  }

  get pusher(): PusherState {
    this.#assertLive();
    return this.#table.pusher;
  }

  /** Current pose of every coin on the table, in ascending id order. */
  coins(): CoinState[] {
    this.#assertLive();
    const mechanics = this.#mechanics;
    return this.#table
      .coins()
      .map((coin) => ({ ...coin, tier: mechanics ? mechanics.tierOf(coin.id) : null }));
  }

  /** Every prop, in ascending id order; empty on a Sim without props. */
  props(): PropState[] {
    this.#assertLive();
    return this.#props ? this.#props.states() : [];
  }

  get crateCount(): number {
    return this.#table.crateCount;
  }

  /** Current pose of every crate on the table, in ascending id order. */
  crates(): CrateState[] {
    this.#assertLive();
    return this.#table.crates();
  }

  /**
   * The table quantized for storage: the pusher's place in its cycle and every coin's
   * pose and rest state, in ascending id order. Velocities are not kept; a restore
   * starts every coin at rest. Tiers are the server's to keep. Throws while a crate is
   * on the table: SimTableSnapshot has no place for one, and a restore without it would
   * replay to other hashes.
   */
  snapshot(): SimTableSnapshot {
    this.#assertLive();
    if (this.#table.crateCount > 0) {
      throw new Error(
        `Sim.snapshot: tick ${this.#tick} has ${this.#table.crateCount} crates on the table, which a snapshot cannot hold; snapshot once they have fallen`,
      );
    }
    const table: SimTableSnapshot = {
      version: SIM_SNAPSHOT_VERSION,
      pusherTickInCycle: this.#table.pusherTickInCycle,
      coins: this.#table.coins().map((coin) => ({
        id: coin.id,
        p: quantizePosition(coin.translation),
        q: quantizeRotation(coin.rotation),
        rest: coin.sleeping ? 'asleep' : 'awake',
      })),
    };
    return this.#props ? { ...table, props: this.#props.snapshot() } : table;
  }

  /**
   * Applies `inputs` in array order, then advances the table by exactly one fixed
   * tick and runs the mechanics. Returns what happened, each event stamped with the
   * new `tick`. Throws, applying nothing, if any input is malformed, more than one
   * is a nudge, or its crates would take the table past CRATE_BODY.maxOnTable.
   */
  step(inputs: readonly SimInput[] = []): SimEvents {
    this.#assertLive();
    let nudges = 0;
    let crates = 0;
    for (const input of inputs) {
      assertValidInput(input, this.#tick, this.#tiers);
      if (input.kind === 'nudge') {
        nudges += 1;
      } else if (input.kind === 'dropCrate') {
        crates += 1;
      }
    }
    if (this.#table.crateCount + crates > CRATE_BODY.maxOnTable) {
      throw new RangeError(
        `Tick ${this.#tick}: the table holds ${this.#table.crateCount} crates and takes at most ${CRATE_BODY.maxOnTable}; drop a crate only after one has fallen`,
      );
    }
    // Nudges stack velocity on every coin, so one per tick keeps a replayed log within
    // the kick NUDGE is tuned for; how often a player may nudge is an economy rule.
    if (nudges > 1) {
      throw new RangeError(`Tick ${this.#tick}: at most one nudge per step, got ${nudges}`);
    }
    for (const input of inputs) {
      switch (input.kind) {
        case 'dropCoin': {
          const tier = this.#resolveTier(input.tier, 'dropCoin.tier');
          this.#registerDrop(this.#table.dropCoin(input.xMm / 1000, this.#rng), tier);
          break;
        }
        case 'nudge':
          this.#table.nudge(input.direction);
          this.#props?.nudge(input.direction);
          break;
        case 'dropCrate':
          this.#table.dropCrate(input.xMm / 1000, this.#rng);
          break;
      }
    }
    this.#tick += 1;
    const coins = (): PropCoin[] => this.#propCoins();
    this.#props?.beforeStep(coins);
    const falls = this.#table.step(this.#tick);
    const contacts = this.#table.contacts;
    const crateFalls = this.#table.crateFalls;
    const crateImpacts = this.#table.crateImpacts;
    const { events: props, consumed } = this.#props
      ? this.#props.afterStep(this.#tick, coins)
      : { events: [], consumed: [] };
    const removed = falls.map((fall) => fall.coinId);
    removed.push(...consumed);
    const mechanics = this.#mechanics ? this.#mechanics.step(this.#tick, removed) : [];
    return { falls, contacts, mechanics, crateFalls, crateImpacts, props };
  }

  /**
   * Digest of everything that can influence a future tick: the tick counter, the
   * PRNG state, the whole table (pusher clock and pose, every coin's pose, velocity
   * and sleep state, and every crate's once one has been dropped) and, on a Sim with
   * mechanics, every coin's tier and the fusion and tower state, and on a Sim with
   * props, every prop's clock, body state and the coins in it. A Sim without mechanics
   * or props hashes only the first three.
   */
  hash(): string {
    this.#assertLive();
    const h = new StateHasher().int(this.#tick).uint32(this.seed);
    for (const word of this.#rng.state()) {
      h.uint32(word);
    }
    this.#table.hashInto(h);
    this.#mechanics?.hashInto(h);
    this.#props?.hashInto(h);
    return h.digest();
  }

  /** Frees the WASM memory. The instance cannot be used afterwards. */
  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#world.free();
  }

  #heapEntries(heap: OpeningHeap): RestoreEntry[] {
    if (!Number.isInteger(heap.coins) || heap.coins < 0) {
      throw new RangeError(
        `Sim: openingHeap.coins must be a non-negative integer, got ${heap.coins}`,
      );
    }
    return Array.from({ length: heap.coins }, (_, slot) =>
      heap.tier === undefined
        ? { kind: 'heapSlot', slot }
        : { kind: 'heapSlot', slot, tier: heap.tier },
    );
  }

  /** Checks a restore before anything is built: any bad entry throws. */
  #restoreEntries(restore: SimRestore, layout: HeapLayout): readonly RestoreEntry[] {
    if (!Array.isArray(restore.coins)) {
      throw new TypeError('Sim: restore.coins must be an array of RestoreEntry');
    }
    const entries: readonly RestoreEntry[] = restore.coins;
    const poses = entries.flatMap((entry) => (entry.kind === 'pose' ? [entry.pose] : []));
    const { dropped } = validateSnapshot({
      version: SIM_SNAPSHOT_VERSION,
      pusherTickInCycle: restore.pusherTickInCycle,
      coins: poses,
    });
    if (dropped.length > 0) {
      const reasons = dropped.map(({ id, reason }) => `${id}: ${reason}`).join(', ');
      throw new RangeError(
        `Sim: restore has poses validateSnapshot drops (${reasons}); filter them before restoring`,
      );
    }
    const capacity = PusherTable.heapCapacity(layout);
    const slots = new Set<number>();
    entries.forEach((entry, i) => {
      if (entry.kind === 'pose') {
        return;
      }
      const kind: unknown = entry.kind;
      if (kind !== 'heapSlot') {
        throw new TypeError(
          `Sim: restore.coins[${i}].kind must be "pose" or "heapSlot", got ${JSON.stringify(kind)}`,
        );
      }
      const { slot } = entry;
      if (!Number.isInteger(slot) || slot < 0 || slot >= capacity) {
        throw new RangeError(
          `Sim: restore.coins[${i}].slot must be an integer in [0, ${capacity}), got ${slot}`,
        );
      }
      if (slots.has(slot)) {
        throw new RangeError(`Sim: restore.coins[${i}] repeats heap slot ${slot}`);
      }
      slots.add(slot);
    });
    return entries;
  }

  /** Lays `entries` on the empty table, heap slots from their own PRNG, and returns the ids. */
  #lay(entries: readonly RestoreEntry[], layout: HeapLayout): number[] {
    if (entries.length === 0) {
      return [];
    }
    let slots = 0;
    for (const entry of entries) {
      if (entry.kind === 'heapSlot' && entry.slot >= slots) {
        slots = entry.slot + 1;
      }
    }
    const heap = this.#table.heapSlotPoses(slots, Xoshiro128ss.fromSeed(this.seed), layout);
    const coins = entries.map((entry): RestoreCoin => {
      if (entry.kind === 'pose') {
        return {
          translation: dequantizePosition(entry.pose.p),
          rotation: dequantizeRotation(entry.pose.q),
          asleep: entry.pose.rest === 'asleep',
          lift: false,
        };
      }
      const pose = heap[entry.slot];
      if (!pose) {
        throw new Error(`Sim: heap slot ${entry.slot} was not laid`);
      }
      return { ...pose, asleep: false, lift: true };
    });
    return this.#table.restore(coins);
  }

  /** The tier a coin is laid with: `tier`, or the lowest; it must be in the ladder. */
  #ladderTier(tier: string | undefined, what: string): string | null {
    const resolved = this.#resolveTier(tier, what);
    if (resolved !== null && !this.#tiers?.includes(resolved)) {
      throw new RangeError(`Sim: ${what} "${resolved}" is not in the tier ladder`);
    }
    return resolved;
  }

  #resolveTier(tier: string | undefined, what: string): string | null {
    if (!this.#tiers) {
      if (tier !== undefined) {
        throw new RangeError(`Sim: ${what} needs a Sim created with mechanics`);
      }
      return null;
    }
    return tier ?? this.#tiers[0] ?? null;
  }

  #registerDrop(id: number, tier: string | null): void {
    if (this.#mechanics && tier !== null) {
      this.#mechanics.registerDrop(id, tier);
    }
  }

  /** Every coin as a prop hook sees it, in ascending id order. */
  #propCoins(): PropCoin[] {
    const mechanics = this.#mechanics;
    return this.#table.coins().map((coin) => ({
      id: coin.id,
      translation: coin.translation,
      rotation: coin.rotation,
      sleeping: coin.sleeping,
      tier: mechanics ? mechanics.tierOf(coin.id) : null,
    }));
  }

  #assertLive(): void {
    if (this.#disposed) {
      throw new Error('Sim has been disposed; create a new one with Sim.create()');
    }
  }
}

/** Where the opening heap goes on a Sim made with `config` and `props`; see Sim.heapCapacity. */
function heapLayout(
  config: MechanicsConfig<string> | undefined,
  props: readonly BoundProp[],
): HeapLayout {
  const keepClear: HeapKeepClear[] = propKeepClear(props);
  if (config && config.tower !== null) {
    const { x, z } = config.tower ?? TOWER_TUNING.placement;
    keepClear.push({ x, z, radius: TOWER_TUNING.pedestalRadius });
  }
  return { keepClear };
}
