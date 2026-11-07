import type { RigidBody, Rotation, Vector, World } from '@dimforge/rapier3d-deterministic-compat';
import { COIN, COIN_DROP_HEIGHT, COIN_DROP_MAX_JITTER, COIN_DROP_MAX_TILT } from './coin.ts';
import { FIXED_DT, GRAVITY, SOLVER } from './constants.ts';
import { StateHasher } from './hash.ts';
import { assertValidInput, type SimInput } from './inputs.ts';
import { Xoshiro128ss } from './prng.ts';
import { loadRapier, type Rapier } from './rapier.ts';

export interface SimOptions {
  /** uint32 seed for every random choice the sim makes. */
  readonly seed: number;
}

export interface EngineInfo {
  readonly rapierVersion: string;
  readonly timestep: number;
  readonly lengthUnit: number;
  readonly numSolverIterations: number;
  readonly maxCcdSubsteps: number;
}

export interface CoinState {
  readonly id: number;
  readonly translation: Readonly<Vector>;
  readonly rotation: Readonly<Rotation>;
  readonly sleeping: boolean;
}

/**
 * Placeholder playfield until T-1.01 builds the real table: a walled tray whose
 * top surface is y = 0, large enough that coins never leave it.
 */
const TRAY = { halfWidth: 0.2, halfDepth: 0.2, floorHalfThickness: 0.02, wallHeight: 0.04 };

export class Sim {
  readonly seed: number;
  readonly #rapier: Rapier;
  readonly #world: World;
  readonly #rng: Xoshiro128ss;
  /** Insertion-ordered by ascending coin id, which fixes the iteration order. */
  readonly #coins = new Map<number, RigidBody>();
  #tick = 0;
  #nextCoinId = 0;
  #disposed = false;

  static async create(options: SimOptions): Promise<Sim> {
    return new Sim(await loadRapier(), options);
  }

  private constructor(rapier: Rapier, options: SimOptions) {
    this.seed = options.seed;
    this.#rng = Xoshiro128ss.fromSeed(options.seed);
    this.#rapier = rapier;
    this.#world = new rapier.World(GRAVITY);
    this.#world.timestep = FIXED_DT;
    const params = this.#world.integrationParameters;
    params.lengthUnit = SOLVER.lengthUnit;
    params.numSolverIterations = SOLVER.numSolverIterations;
    params.maxCcdSubsteps = SOLVER.maxCcdSubsteps;
    this.#buildTray();
  }

  get tick(): number {
    return this.#tick;
  }

  /** Engine build and solver settings, recorded with input logs so an auditor can refuse a mismatched replay. */
  get engine(): EngineInfo {
    const params = this.#world.integrationParameters;
    return {
      rapierVersion: this.#rapier.version(),
      timestep: this.#world.timestep,
      lengthUnit: params.lengthUnit,
      numSolverIterations: params.numSolverIterations,
      maxCcdSubsteps: params.maxCcdSubsteps,
    };
  }

  get coinCount(): number {
    return this.#coins.size;
  }

  /** Current pose of every coin, in ascending id order. */
  coins(): CoinState[] {
    this.#assertLive();
    return Array.from(this.#coins, ([id, body]) => ({
      id,
      translation: body.translation(),
      rotation: body.rotation(),
      sleeping: body.isSleeping(),
    }));
  }

  /** Applies `inputs` in array order, then advances the world by exactly one fixed tick. */
  step(inputs: readonly SimInput[] = []): void {
    this.#assertLive();
    for (const input of inputs) {
      assertValidInput(input, this.#tick);
    }
    for (const input of inputs) {
      this.#dropCoin(input.xMm);
    }
    this.#world.step();
    this.#tick += 1;
  }

  /**
   * Digest of everything that can influence a future tick: the tick counter, the
   * PRNG state and every coin's pose, velocity and sleep state.
   */
  hash(): string {
    this.#assertLive();
    const h = new StateHasher()
      .int(this.#tick)
      .uint32(this.seed)
      .int(this.#nextCoinId)
      .int(this.#coins.size);
    for (const word of this.#rng.state()) {
      h.uint32(word);
    }
    for (const [id, body] of this.#coins) {
      h.int(id)
        .vec3(body.translation())
        .quat(body.rotation())
        .vec3(body.linvel())
        .vec3(body.angvel())
        .bool(body.isSleeping());
    }
    return h.digest();
  }

  /** Frees the WASM memory. The instance cannot be used afterwards. */
  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#coins.clear();
    this.#world.free();
  }

  #assertLive(): void {
    if (this.#disposed) {
      throw new Error('Sim has been disposed; create a new one with Sim.create()');
    }
  }

  #buildTray(): void {
    const { RigidBodyDesc, ColliderDesc } = this.#rapier;
    const { halfWidth, halfDepth, floorHalfThickness, wallHeight } = TRAY;
    const tray = this.#world.createRigidBody(RigidBodyDesc.fixed());
    const wallHalfHeight = wallHeight / 2;
    const wallHalfThickness = floorHalfThickness;
    const parts: readonly [number, number, number, number, number, number][] = [
      [halfWidth, floorHalfThickness, halfDepth, 0, -floorHalfThickness, 0],
      [
        wallHalfThickness,
        wallHalfHeight,
        halfDepth,
        -halfWidth - wallHalfThickness,
        wallHalfHeight,
        0,
      ],
      [
        wallHalfThickness,
        wallHalfHeight,
        halfDepth,
        halfWidth + wallHalfThickness,
        wallHalfHeight,
        0,
      ],
      [
        halfWidth,
        wallHalfHeight,
        wallHalfThickness,
        0,
        wallHalfHeight,
        -halfDepth - wallHalfThickness,
      ],
      [
        halfWidth,
        wallHalfHeight,
        wallHalfThickness,
        0,
        wallHalfHeight,
        halfDepth + wallHalfThickness,
      ],
    ];
    for (const [hx, hy, hz, x, y, z] of parts) {
      this.#world.createCollider(
        ColliderDesc.cuboid(hx, hy, hz)
          .setTranslation(x, y, z)
          .setFriction(COIN.friction)
          .setRestitution(COIN.restitution),
        tray,
      );
    }
  }

  #dropCoin(xMm: number): void {
    const { RigidBodyDesc, ColliderDesc, CoefficientCombineRule } = this.#rapier;
    const z = this.#rng.nextRange(-COIN_DROP_MAX_JITTER, COIN_DROP_MAX_JITTER);
    const tiltX = this.#rng.nextRange(-COIN_DROP_MAX_TILT, COIN_DROP_MAX_TILT);
    const tiltZ = this.#rng.nextRange(-COIN_DROP_MAX_TILT, COIN_DROP_MAX_TILT);
    const norm = Math.sqrt(tiltX * tiltX + tiltZ * tiltZ + 1);
    const body = this.#world.createRigidBody(
      RigidBodyDesc.dynamic()
        .setTranslation(xMm / 1000, COIN_DROP_HEIGHT + COIN.halfThickness, z)
        .setRotation({ x: tiltX / norm, y: 0, z: tiltZ / norm, w: 1 / norm })
        .setLinearDamping(COIN.linearDamping)
        .setAngularDamping(COIN.angularDamping)
        .setCcdEnabled(true),
    );
    this.#world.createCollider(
      ColliderDesc.cylinder(COIN.halfThickness, COIN.radius)
        .setDensity(COIN.density)
        .setFriction(COIN.friction)
        .setRestitution(COIN.restitution)
        .setRestitutionCombineRule(CoefficientCombineRule.Min),
      body,
    );
    this.#coins.set(this.#nextCoinId, body);
    this.#nextCoinId += 1;
  }
}
