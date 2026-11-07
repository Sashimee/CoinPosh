import type {
  RigidBody,
  Rotation,
  Shape,
  Vector,
  World,
} from '@dimforge/rapier3d-deterministic-compat';
import { COIN, COIN_DROP_MAX_JITTER, COIN_DROP_MAX_TILT } from '../coin.ts';
import type { StateHasher } from '../hash.ts';
import type { Xoshiro128ss } from '../prng.ts';
import type { Rapier } from '../rapier.ts';
import {
  BACKBOARD,
  DROP_ZONE,
  GUTTER_START_Z,
  PLAYFIELD,
  PUSHER,
  TABLE_INNER_HALF_WIDTH,
} from './layout.ts';
import { DEFAULT_PUSHER_MOTION, PusherClock, type PusherMotion } from './pusher.ts';
import { COIN_MATERIAL, TABLE_MATERIAL, TABLE_SOLVER } from './tuning.ts';

/** Mirrors FallEdge in packages/shared, which packages/sim cannot import yet. */
export type FallEdge = 'front' | 'left' | 'right';

/** World units per metre; see TABLE_SOLVER.worldScale. */
const SCALE = TABLE_SOLVER.worldScale;
const SUBSTEPS = TABLE_SOLVER.substeps;
const IMPACT_SPEED = COIN_MATERIAL.impactSpeed * SCALE;
const IMPACT_SPEED_SQ = IMPACT_SPEED * IMPACT_SPEED;
const IMPACT_MARGIN = COIN_MATERIAL.impactMargin * SCALE;
const IMPACT_PASSES = COIN_MATERIAL.impactPasses;
const FALL_Y = PLAYFIELD.fallY * SCALE;

export interface FallEvent {
  readonly coinId: number;
  readonly edge: FallEdge;
  /** The tick the coin crossed the fall plane, counted like Sim.tick (after the step). */
  readonly tick: number;
}

export interface TableCoin {
  readonly id: number;
  readonly translation: Readonly<Vector>;
  readonly rotation: Readonly<Rotation>;
  readonly sleeping: boolean;
}

export interface PusherState {
  readonly phase: number;
  readonly extension: number;
  /** World z of the pusher's front face. */
  readonly frontZ: number;
  readonly motion: PusherMotion;
}

export interface TableOptions {
  readonly pusher?: PusherMotion;
}

/**
 * The two-tier pusher table inside a Rapier world: fixed floor, side walls with open
 * gutters, a backboard, a kinematic pusher, the coins on the table and fall
 * detection. The caller owns the world (set up with `configureTableWorld`) and the
 * tick count, and calls `step()` once per tick; the table steps the world itself,
 * TABLE_SOLVER.substeps times per tick.
 */
export class PusherTable {
  readonly #rapier: Rapier;
  readonly #world: World;
  readonly #pusher: RigidBody;
  readonly #clock: PusherClock;
  readonly #coinShape: Shape;
  /** Insertion-ordered by ascending coin id, which fixes the iteration order. */
  readonly #coins = new Map<number, RigidBody>();
  #nextCoinId = 0;

  constructor(rapier: Rapier, world: World, options: TableOptions = {}) {
    this.#rapier = rapier;
    this.#world = world;
    this.#clock = new PusherClock(options.pusher ?? DEFAULT_PUSHER_MOTION);
    this.#coinShape = new rapier.RoundCylinder(
      (COIN.halfThickness - COIN_MATERIAL.rimRadius) * SCALE,
      (COIN.radius - COIN_MATERIAL.rimRadius) * SCALE,
      COIN_MATERIAL.rimRadius * SCALE,
    );
    this.#buildCabinet();
    this.#pusher = this.#buildPusher();
  }

  get coinCount(): number {
    return this.#coins.size;
  }

  get nextCoinId(): number {
    return this.#nextCoinId;
  }

  get pusher(): PusherState {
    return {
      phase: this.#clock.phase,
      extension: this.#clock.extension,
      frontZ: PUSHER.frontZ + this.#clock.offset,
      motion: this.#clock.motion,
    };
  }

  setPusherMotion(motion: PusherMotion): void {
    this.#clock.setMotion(motion);
  }

  /** Current pose of every coin on the table, in ascending id order. */
  coins(): TableCoin[] {
    return Array.from(this.#coins, ([id, body]) => ({
      id,
      translation: toMetres(body.translation()),
      rotation: body.rotation(),
      sleeping: body.isSleeping(),
    }));
  }

  /**
   * Drops a coin over the upper tier at `x` metres from the centre line, with a small
   * random depth offset and tilt drawn from `rng` so a column of drops does not stack
   * perfectly. Returns the new coin's id.
   */
  dropCoin(x: number, rng: Xoshiro128ss): number {
    const z = DROP_ZONE.z + rng.nextRange(-COIN_DROP_MAX_JITTER, COIN_DROP_MAX_JITTER);
    const tiltX = rng.nextRange(-COIN_DROP_MAX_TILT, COIN_DROP_MAX_TILT);
    const tiltZ = rng.nextRange(-COIN_DROP_MAX_TILT, COIN_DROP_MAX_TILT);
    const norm = Math.sqrt(tiltX * tiltX + tiltZ * tiltZ + 1);
    return this.addCoin(
      { x, y: PUSHER.height + DROP_ZONE.height, z },
      { x: tiltX / norm, y: 0, z: tiltZ / norm, w: 1 / norm },
    );
  }

  /** Places a coin at an exact pose. Returns the new coin's id. */
  addCoin(translation: Readonly<Vector>, rotation: Readonly<Rotation>): number {
    const { RigidBodyDesc, ColliderDesc, CoefficientCombineRule } = this.#rapier;
    const body = this.#world.createRigidBody(
      RigidBodyDesc.dynamic()
        .setTranslation(translation.x * SCALE, translation.y * SCALE, translation.z * SCALE)
        .setRotation(rotation)
        .setLinearDamping(COIN_MATERIAL.linearDamping)
        .setAngularDamping(COIN_MATERIAL.angularDamping)
        .setCanSleep(true)
        .setCcdEnabled(true),
    );
    this.#world.createCollider(
      new ColliderDesc(this.#coinShape)
        .setDensity(COIN.density / (SCALE * SCALE * SCALE))
        .setFriction(COIN_MATERIAL.friction)
        .setRestitution(COIN_MATERIAL.restitution)
        .setRestitutionCombineRule(CoefficientCombineRule.Min)
        .setContactSkin(COIN_MATERIAL.contactSkin * SCALE),
      body,
    );
    const id = this.#nextCoinId;
    this.#coins.set(id, body);
    this.#nextCoinId += 1;
    return id;
  }

  /**
   * Advances the table by one tick: sweeps the pusher, steps the world, then removes
   * every coin that fell below the fall plane and reports where it left, in ascending
   * coin id order. `tick` is the tick count after this step, like Sim.tick.
   */
  step(tick: number): FallEvent[] {
    const from = this.#clock.offset;
    this.#clock.advance();
    const to = this.#clock.offset;
    for (let i = 1; i <= SUBSTEPS; i++) {
      this.#pusher.setNextKinematicTranslation(
        this.#pusherCentre(from + ((to - from) * i) / SUBSTEPS),
      );
      this.#absorbImpacts();
      this.#world.step();
    }
    return this.#collectFalls(tick);
  }

  /**
   * Lands every fast coin that would strike something during the coming substep:
   * the coin is moved forward to the point of contact and loses its closing speed
   * along the contact normal, as if the struck body were immovable. See
   * COIN_MATERIAL.impactSpeed for why the solver is not left to do this.
   */
  #absorbImpacts(): void {
    for (const body of this.#coins.values()) {
      if (body.isSleeping()) {
        continue;
      }
      for (let pass = 0; pass < IMPACT_PASSES && this.#absorbImpact(body); pass++) {
        // Each pass lands the coin on the nearest thing in its path; a glancing hit
        // leaves it sliding, so look again along the new velocity.
      }
    }
  }

  /** Returns whether the coin hit something and had its motion changed. */
  #absorbImpact(body: RigidBody): boolean {
    const v = body.linvel();
    if (v.x * v.x + v.y * v.y + v.z * v.z <= IMPACT_SPEED_SQ) {
      return false;
    }
    const dt = this.#world.timestep;
    const t = body.translation();
    const hit = this.#world.castShape(
      t,
      body.rotation(),
      { x: v.x * dt, y: v.y * dt, z: v.z * dt },
      this.#coinShape,
      IMPACT_MARGIN,
      1,
      false,
      undefined,
      undefined,
      undefined,
      body,
    );
    if (!hit || hit.time_of_impact >= 1) {
      return false;
    }
    const n = hit.normal1;
    const other = hit.collider.parent();
    const u = other && !other.isFixed() ? other.linvel() : ZERO;
    const closing = (v.x - u.x) * n.x + (v.y - u.y) * n.y + (v.z - u.z) * n.z;
    if (closing >= 0) {
      return false;
    }
    const ahead = hit.time_of_impact * dt;
    body.setTranslation({ x: t.x + v.x * ahead, y: t.y + v.y * ahead, z: t.z + v.z * ahead }, true);
    body.setLinvel(
      { x: v.x - closing * n.x, y: v.y - closing * n.y, z: v.z - closing * n.z },
      true,
    );
    return true;
  }

  #collectFalls(tick: number): FallEvent[] {
    const falls: FallEvent[] = [];
    for (const [id, body] of this.#coins) {
      if (body.isSleeping()) {
        continue;
      }
      const t = body.translation();
      if (t.y < FALL_Y) {
        falls.push({ coinId: id, edge: fallEdge(t.x / SCALE), tick });
        this.#coins.delete(id);
        this.#world.removeRigidBody(body);
      }
    }
    return falls;
  }

  /** Feeds every piece of table state that can influence a future tick into `h`. */
  hashInto(h: StateHasher): StateHasher {
    const pending = this.#clock.pendingMotion;
    h.int(this.#clock.tickInCycle).int(this.#clock.cycles);
    hashMotion(h, this.#clock.motion);
    h.bool(pending !== undefined);
    if (pending) {
      hashMotion(h, pending);
    }
    h.vec3(this.#pusher.translation());
    h.int(this.#nextCoinId).int(this.#coins.size);
    for (const [id, body] of this.#coins) {
      h.int(id)
        .vec3(body.translation())
        .quat(body.rotation())
        .vec3(body.linvel())
        .vec3(body.angvel())
        .bool(body.isSleeping());
    }
    return h;
  }

  #buildCabinet(): void {
    const { RigidBodyDesc, ColliderDesc, CoefficientCombineRule } = this.#rapier;
    const { fieldHalfWidth, fieldFrontZ, floorThickness, wallThickness, wallHeight } = PLAYFIELD;
    const cabinet = this.#world.createRigidBody(RigidBodyDesc.fixed());
    const backZ = PUSHER.frontZ - PUSHER.depth;
    const floorHalfDepth = (fieldFrontZ - backZ) / 2;
    const floorCentreZ = (fieldFrontZ + backZ) / 2;
    const wallBottom = -floorThickness;
    const wallHalfHeight = (wallHeight - wallBottom) / 2;
    const wallCentreY = (wallHeight + wallBottom) / 2;
    const boardBottom = PUSHER.height - BACKBOARD.embed;
    const boardHalfHeight = (wallHeight - boardBottom) / 2;
    const guideHalfDepth = (GUTTER_START_Z - backZ) / 2;
    const guideCentreZ = (GUTTER_START_Z + backZ) / 2;
    const outerHalfDepth = (fieldFrontZ - GUTTER_START_Z) / 2;
    const outerCentreZ = (fieldFrontZ + GUTTER_START_Z) / 2;

    const add = (
      [hx, hy, hz]: readonly [number, number, number],
      [x, y, z]: readonly [number, number, number],
      friction: number,
    ): void => {
      this.#world.createCollider(
        ColliderDesc.cuboid(hx * SCALE, hy * SCALE, hz * SCALE)
          .setTranslation(x * SCALE, y * SCALE, z * SCALE)
          .setFriction(friction)
          .setRestitution(TABLE_MATERIAL.restitution)
          .setRestitutionCombineRule(CoefficientCombineRule.Min),
        cabinet,
      );
    };
    add(
      [fieldHalfWidth, floorThickness / 2, floorHalfDepth],
      [0, -floorThickness / 2, floorCentreZ],
      TABLE_MATERIAL.floorFriction,
    );
    for (const side of [-1, 1]) {
      add(
        [wallThickness / 2, wallHalfHeight, guideHalfDepth],
        [side * (fieldHalfWidth + wallThickness / 2), wallCentreY, guideCentreZ],
        TABLE_MATERIAL.wallFriction,
      );
      add(
        [wallThickness / 2, wallHalfHeight, outerHalfDepth],
        [side * (TABLE_INNER_HALF_WIDTH + wallThickness / 2), wallCentreY, outerCentreZ],
        TABLE_MATERIAL.wallFriction,
      );
    }
    add(
      [fieldHalfWidth, boardHalfHeight, wallThickness / 2],
      [0, boardBottom + boardHalfHeight, BACKBOARD.frontZ - wallThickness / 2],
      TABLE_MATERIAL.wallFriction,
    );
  }

  #buildPusher(): RigidBody {
    const { RigidBodyDesc, ColliderDesc, CoefficientCombineRule } = this.#rapier;
    const centre = this.#pusherCentre(this.#clock.offset);
    const body = this.#world.createRigidBody(
      RigidBodyDesc.kinematicPositionBased().setTranslation(centre.x, centre.y, centre.z),
    );
    this.#world.createCollider(
      ColliderDesc.cuboid(
        (PLAYFIELD.fieldHalfWidth - PUSHER.sideClearance) * SCALE,
        (PUSHER.height / 2) * SCALE,
        (PUSHER.depth / 2) * SCALE,
      )
        .setFriction(TABLE_MATERIAL.pusherFriction)
        .setRestitution(TABLE_MATERIAL.restitution)
        .setRestitutionCombineRule(CoefficientCombineRule.Min),
      body,
    );
    return body;
  }

  #pusherCentre(offset: number): Vector {
    return {
      x: 0,
      y: (PUSHER.height / 2) * SCALE,
      z: (PUSHER.frontZ + offset - PUSHER.depth / 2) * SCALE,
    };
  }
}

const ZERO: Readonly<Vector> = { x: 0, y: 0, z: 0 };

function toMetres(v: Readonly<Vector>): Vector {
  return { x: v.x / SCALE, y: v.y / SCALE, z: v.z / SCALE };
}

/**
 * A coin below the fall plane went over the front edge unless its centre is outside
 * the floor's width: the floor is solid between the gutters, so nothing can fall
 * through it.
 */
function fallEdge(x: number): FallEdge {
  if (x < -PLAYFIELD.fieldHalfWidth) {
    return 'left';
  }
  if (x > PLAYFIELD.fieldHalfWidth) {
    return 'right';
  }
  return 'front';
}

function hashMotion(h: StateHasher, motion: PusherMotion): void {
  h.float(motion.stroke).int(motion.periodTicks).float(motion.pushFraction);
}
