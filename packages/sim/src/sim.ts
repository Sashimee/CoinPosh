import type { Rotation, Vector, World } from '@dimforge/rapier3d-deterministic-compat';
import { GRAVITY, SIM_VERSION } from './constants.ts';
import { StateHasher } from './hash.ts';
import { assertValidInput, type SimInput } from './inputs.ts';
import { Xoshiro128ss } from './prng.ts';
import { loadRapier, type Rapier } from './rapier.ts';
import {
  configureTableWorld,
  type FallEvent,
  PusherTable,
  type PusherState,
  TABLE_SOLVER,
} from './table/index.ts';

export interface SimOptions {
  /** uint32 seed for every random choice the sim makes. */
  readonly seed: number;
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
  #tick = 0;
  #disposed = false;

  static async create(options: SimOptions): Promise<Sim> {
    return new Sim(await loadRapier(), options);
  }

  private constructor(rapier: Rapier, options: SimOptions) {
    this.seed = options.seed;
    this.#rng = Xoshiro128ss.fromSeed(options.seed);
    this.#rapier = rapier;
    this.#world = new rapier.World(GRAVITY);
    configureTableWorld(this.#world);
    this.#table = new PusherTable(rapier, this.#world);
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

  get pusher(): PusherState {
    this.#assertLive();
    return this.#table.pusher;
  }

  /** Current pose of every coin on the table, in ascending id order. */
  coins(): CoinState[] {
    this.#assertLive();
    return this.#table.coins();
  }

  /**
   * Applies `inputs` in array order, then advances the table by exactly one fixed
   * tick. Returns the coins that left the table during the tick, in ascending id
   * order, each stamped with the new `tick`.
   */
  step(inputs: readonly SimInput[] = []): FallEvent[] {
    this.#assertLive();
    for (const input of inputs) {
      assertValidInput(input, this.#tick);
    }
    for (const input of inputs) {
      this.#table.dropCoin(input.xMm / 1000, this.#rng);
    }
    this.#tick += 1;
    return this.#table.step(this.#tick);
  }

  /**
   * Digest of everything that can influence a future tick: the tick counter, the
   * PRNG state and the whole table (pusher clock and pose, every coin's pose,
   * velocity and sleep state).
   */
  hash(): string {
    this.#assertLive();
    const h = new StateHasher().int(this.#tick).uint32(this.seed);
    for (const word of this.#rng.state()) {
      h.uint32(word);
    }
    return this.#table.hashInto(h).digest();
  }

  /** Frees the WASM memory. The instance cannot be used afterwards. */
  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#world.free();
  }

  #assertLive(): void {
    if (this.#disposed) {
      throw new Error('Sim has been disposed; create a new one with Sim.create()');
    }
  }
}
