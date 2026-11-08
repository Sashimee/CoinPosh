import type { Rotation, Vector, World } from '@dimforge/rapier3d-deterministic-compat';
import { GRAVITY, SIM_VERSION } from './constants.ts';
import { StateHasher } from './hash.ts';
import { assertValidInput, type SimInput } from './inputs.ts';
import { type MechanicEvent, type MechanicsConfig, TableMechanics } from './mechanics/mechanics.ts';
import { TOWER_TUNING } from './mechanics/tuning.ts';
import { Xoshiro128ss } from './prng.ts';
import { loadRapier, type Rapier } from './rapier.ts';
import {
  configureTableWorld,
  type ContactEvent,
  type FallEvent,
  type HeapKeepClear,
  type HeapLayout,
  PusherTable,
  type PusherState,
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
  readonly openingHeap?: OpeningHeap;
}

/** What happened during one step, each event stamped with the tick after it. */
export interface SimEvents {
  /** Coins that left the table, in ascending id order. */
  readonly falls: readonly FallEvent[];
  /** Coins that struck something, in ascending id order. */
  readonly contacts: readonly ContactEvent[];
  /** Fusions, then tower captures and topples; always empty without mechanics. */
  readonly mechanics: readonly MechanicEvent<string>[];
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
  readonly sleeping: boolean;
  /** Null on a Sim without mechanics. */
  readonly tier: string | null;
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
  #tick = 0;
  #disposed = false;

  static async create(options: SimOptions): Promise<Sim> {
    return new Sim(await loadRapier(), options);
  }

  /**
   * The most coins `openingHeap` can ask for on a Sim made with `mechanics`. A Sim that
   * fuses lays a single layer, and a tower keeps its pedestal bare, so both hold fewer.
   */
  static heapCapacity(mechanics?: MechanicsConfig<string>): number {
    return PusherTable.heapCapacity(heapLayout(mechanics));
  }

  private constructor(rapier: Rapier, options: SimOptions) {
    this.seed = options.seed;
    this.#rng = Xoshiro128ss.fromSeed(options.seed);
    this.#rapier = rapier;
    this.#world = new rapier.World(GRAVITY);
    configureTableWorld(this.#world);
    this.#table = new PusherTable(rapier, this.#world);
    const config = options.mechanics;
    this.#mechanics = config ? new TableMechanics(rapier, this.#world, this.#table, config) : null;
    this.#tiers = config ? config.tiers : null;
    if (options.openingHeap) {
      this.#placeHeap(options.openingHeap, config);
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

  /**
   * Applies `inputs` in array order, then advances the table by exactly one fixed
   * tick and runs the mechanics. Returns what happened, each event stamped with the
   * new `tick`. Throws, applying nothing, if any input is malformed or more than one
   * is a nudge.
   */
  step(inputs: readonly SimInput[] = []): SimEvents {
    this.#assertLive();
    let nudges = 0;
    for (const input of inputs) {
      assertValidInput(input, this.#tick, this.#tiers);
      if (input.kind === 'nudge') {
        nudges += 1;
      }
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
          this.#register(this.#table.dropCoin(input.xMm / 1000, this.#rng), tier);
          break;
        }
        case 'nudge':
          this.#table.nudge(input.direction);
          break;
      }
    }
    this.#tick += 1;
    const falls = this.#table.step(this.#tick);
    const contacts = this.#table.contacts;
    const mechanics = this.#mechanics
      ? this.#mechanics.step(
          this.#tick,
          falls.map((fall) => fall.coinId),
        )
      : [];
    return { falls, contacts, mechanics };
  }

  /**
   * Digest of everything that can influence a future tick: the tick counter, the
   * PRNG state, the whole table (pusher clock and pose, every coin's pose, velocity
   * and sleep state) and, on a Sim with mechanics, every coin's tier and the fusion
   * and tower state. A Sim without mechanics hashes only the first three.
   */
  hash(): string {
    this.#assertLive();
    const h = new StateHasher().int(this.#tick).uint32(this.seed);
    for (const word of this.#rng.state()) {
      h.uint32(word);
    }
    this.#table.hashInto(h);
    this.#mechanics?.hashInto(h);
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

  #placeHeap(heap: OpeningHeap, config: MechanicsConfig<string> | undefined): void {
    const tier = this.#resolveTier(heap.tier, 'openingHeap.tier');
    if (tier !== null && !config?.tiers.includes(tier)) {
      throw new RangeError(`Sim: openingHeap.tier "${tier}" is not in the tier ladder`);
    }
    for (const id of this.#table.placeHeap(heap.coins, this.#rng, heapLayout(config))) {
      this.#register(id, tier);
    }
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

  #register(id: number, tier: string | null): void {
    if (this.#mechanics && tier !== null) {
      this.#mechanics.registerCoin(id, tier);
    }
  }

  #assertLive(): void {
    if (this.#disposed) {
      throw new Error('Sim has been disposed; create a new one with Sim.create()');
    }
  }
}

/** Where the opening heap goes on a Sim made with `config`; see Sim.heapCapacity. */
function heapLayout(config: MechanicsConfig<string> | undefined): HeapLayout {
  const keepClear: HeapKeepClear[] = [];
  if (config && config.tower !== null) {
    const { x, z } = config.tower ?? TOWER_TUNING.placement;
    keepClear.push({ x, z, radius: TOWER_TUNING.pedestalRadius });
  }
  return { keepClear, secondLayer: !config?.fusion };
}
