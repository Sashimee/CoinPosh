import type {
  Collider,
  RigidBody,
  Rotation,
  Shape,
  Vector,
  World,
} from '@dimforge/rapier3d-deterministic-compat';
import { COIN, COIN_DROP_MAX_JITTER, COIN_DROP_MAX_TILT } from '../coin.ts';
import { FIXED_DT } from '../constants.ts';
import type { StateHasher } from '../hash.ts';
import type { Xoshiro128ss } from '../prng.ts';
import type { NudgeDirection } from '../inputs.ts';
import type { Rapier } from '../rapier.ts';
import {
  type Box,
  type Disc,
  type DiscShape,
  discAxis,
  discBoxDepth,
  discDiscDepth,
  discReach,
} from '../snapshot/geometry.ts';
import {
  BACKBOARD,
  DROP_ZONE,
  GUTTER_START_Z,
  PLAYFIELD,
  PUSHER,
  TABLE_INNER_HALF_WIDTH,
} from './layout.ts';
import {
  type HeapGeometry,
  type HeapLayout,
  type HeapPose,
  heapCapacity,
  heapPoses,
} from './heap.ts';
import { DEFAULT_PUSHER_MOTION, PusherClock, type PusherMotion } from './pusher.ts';
import { CoinSeparator, type Obstacle, type SeparationResult } from './separation.ts';
import {
  COIN_MATERIAL,
  COIN_REST,
  COIN_RESTORE,
  CONTACT_EVENTS,
  NUDGE,
  TABLE_MATERIAL,
  TABLE_SOLVER,
} from './tuning.ts';

/** Mirrors FallEdge in packages/shared, which packages/sim cannot import yet. */
export type FallEdge = 'front' | 'left' | 'right';

/**
 * What a coin struck: another coin, the pusher block (its face or the upper tier on
 * top of it), the lower-tier floor, or the rest of the cabinet (side walls, backboard).
 */
export type ContactSurface = 'coin' | 'pusher' | 'floor' | 'cabinet';

/** World units per metre; see TABLE_SOLVER.worldScale. */
function square(x: number): number {
  return x * x;
}

/**
 * cos θ from its Taylor series, exact to double precision for |θ| under 0.1 rad, since
 * Math.cos is engine-approximated.
 */
function smallAngleCos(theta: number): number {
  if (!(Math.abs(theta) < 0.1)) {
    throw new RangeError(`smallAngleCos: ${theta} rad is outside (-0.1, 0.1)`);
  }
  const t2 = theta * theta;
  return 1 - (t2 / 2) * (1 - (t2 / 12) * (1 - (t2 / 30) * (1 - t2 / 56)));
}

const SCALE = TABLE_SOLVER.worldScale;
const SUBSTEPS = TABLE_SOLVER.substeps;
const IMPACT_SPEED = COIN_MATERIAL.impactSpeed * SCALE;
const IMPACT_SPEED_SQ = IMPACT_SPEED * IMPACT_SPEED;
const IMPACT_MARGIN = COIN_MATERIAL.impactMargin * SCALE;
const IMPACT_PASSES = COIN_MATERIAL.impactPasses;
const FALL_Y = PLAYFIELD.fallY * SCALE;
const REST_DRIFT_SQ = square(COIN_REST.drift * SCALE);
const REST_TURN_COS_SQ = square(smallAngleCos((COIN_REST.turn * Math.PI) / 180));
const SLOW_SPEED_SQ = square(COIN_REST.slowSpeed * SCALE);
const WAKE_SPEED_SQ = square(COIN_REST.wakeSpeed * SCALE);
const WAKE_FALL_SQ = square(COIN_REST.wakeFall * SCALE);
const WAKE_IMPULSE = COIN_REST.wakeImpulse * SCALE;
const TOUCH_DIST = IMPACT_MARGIN + 2 * COIN_MATERIAL.contactSkin * SCALE;
const SHELF_Y = PUSHER.height * SCALE;
const SHELF_EDGE_Z = PUSHER.frontZ * SCALE;
/**
 * Centre distance in world units within which an awake coin at rest may hold a contact
 * with a frozen one: two bounding spheres, Rapier's look-ahead and both contact skins,
 * plus 5 mm for what the solver and the separation pass moved them since the contacts
 * were found and for a frozen coin lying up to COIN_REST.drift off its anchor.
 */
const NEAR_REACH =
  (2 *
    (Math.sqrt(
      square(COIN.halfThickness - COIN_MATERIAL.rimRadius) +
        square(COIN.radius - COIN_MATERIAL.rimRadius),
    ) +
      COIN_MATERIAL.rimRadius) +
    TABLE_SOLVER.normalizedPredictionDistance * TABLE_SOLVER.lengthUnit +
    2 * COIN_MATERIAL.contactSkin +
    0.005) *
  SCALE;
/** Grid cell size for the search; an awake coin whose reach is longer is checked against every frozen coin. */
const NEAR_CELL = NEAR_REACH + IMPACT_SPEED * FIXED_DT;
/**
 * Centre distance in world units within which two coins can touch: two bounding
 * spheres, both contact skins and COIN_REST.cascadeGap.
 */
const TOUCH_REACH =
  (2 *
    (Math.sqrt(
      square(COIN.halfThickness - COIN_MATERIAL.rimRadius) +
        square(COIN.radius - COIN_MATERIAL.rimRadius),
    ) +
      COIN_MATERIAL.rimRadius +
      COIN_MATERIAL.contactSkin) +
    COIN_REST.cascadeGap) *
  SCALE;
const CASCADE_KEEP_SQ = square(COIN_REST.cascadeKeep);
const CASCADE_SPEED_SQ = square(COIN_REST.cascadeSpeed * SCALE);
const CASCADE_CONE_SQ = square(COIN_REST.cascadeConeCos);
const COIN_DISC: DiscShape = {
  coreHalfHeight: (COIN.halfThickness - COIN_MATERIAL.rimRadius) * SCALE,
  coreRadius: (COIN.radius - COIN_MATERIAL.rimRadius) * SCALE,
  rim: COIN_MATERIAL.rimRadius * SCALE,
};
const COIN_REACH = discReach(COIN_DISC);
const PROBE = COIN_RESTORE.probe * SCALE;
const PROBE_GRIP = PROBE * COIN_RESTORE.probeGrip;
const PUSHER_HALF: Readonly<Vector> = {
  x: (PLAYFIELD.fieldHalfWidth - PUSHER.sideClearance) * SCALE,
  y: (PUSHER.height / 2) * SCALE,
  z: (PUSHER.depth / 2) * SCALE,
};

function cellKey(ix: number, iz: number): number {
  return ix * 65536 + iz;
}

/** A coin's rest state; see COIN_REST. */
interface Rest {
  readonly collider: Collider;
  /**
   * Ticks in a row it has stayed within COIN_REST.drift and COIN_REST.turn of `anchor`,
   * zero when frozen.
   */
  still: number;
  /**
   * Where the still run began: centre x, y, z (z from the pusher's offset on the top),
   * then the face normal x, y, z, in world units.
   */
  readonly anchor: [number, number, number, number, number, number];
  frozen: boolean;
  /** Frozen on the pusher top, moved with the block. */
  rider: boolean;
  /** Slow enough that its spin is damped at COIN_REST.angularDamping. */
  damped: boolean;
  /**
   * Whether #pressedFrozen read the coin awake this tick, into `v` and `t`, for #settle
   * to reuse. The reads live on the coin so a tick makes no garbage that outlives it.
   */
  read: boolean;
  readonly v: Vector;
  readonly t: Vector;
  /** Squared centre distance beyond which it cannot be in contact with a frozen coin. */
  reachSq: number;
}

/**
 * A coin moving into its neighbours at the start of a tick, for #cascade: its centre,
 * how far it can reach a neighbour's centre this tick, and its velocity relative to the
 * surface the neighbours lie on, all in world units.
 */
interface Push {
  x: number;
  y: number;
  z: number;
  reach: number;
  vx: number;
  vy: number;
  vz: number;
}

export interface FallEvent {
  readonly coinId: number;
  readonly edge: FallEdge;
  /** The tick the coin crossed the fall plane, counted like Sim.tick (after the step). */
  readonly tick: number;
}

/** A coin striking something hard enough to hear; see CONTACT_EVENTS. */
export interface ContactEvent {
  readonly coinId: number;
  /** The tick of the step it happened in, counted like Sim.tick (after the step). */
  readonly tick: number;
  /** The coin's centre as it struck, in metres. */
  readonly position: Readonly<Vector>;
  /** Closing speed along the contact normal, in m/s. */
  readonly speed: number;
  /** speed / CONTACT_EVENTS.fullSpeed, capped at 1. */
  readonly strength: number;
  readonly surface: ContactSurface;
}

interface PendingContact {
  readonly speed: number;
  readonly surface: ContactSurface;
  readonly position: Vector;
}

export interface TableCoin {
  readonly id: number;
  readonly translation: Readonly<Vector>;
  readonly rotation: Readonly<Rotation>;
  /**
   * At rest: frozen by the table (COIN_REST) or asleep in Rapier. A sleeping coin is
   * not necessarily still: one frozen on the pusher top rides the block, so its
   * translation keeps changing with the pusher's.
   */
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
  /** Where the pusher starts in its first cycle; 0, full retraction, when omitted. */
  readonly pusherTickInCycle?: number;
}

/** A coin for PusherTable.restore, in metres. */
export interface RestoreCoin {
  readonly translation: Readonly<Vector>;
  readonly rotation: Readonly<Rotation>;
  /** Restore it at rest, if something below holds it up. */
  readonly asleep: boolean;
  /**
   * A heap slot: raised straight up, COIN_RESTORE.liftStep at a time, until it clears
   * the coins placed before it and the pusher. It always restores awake.
   */
  readonly lift: boolean;
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
  readonly #separator: CoinSeparator;
  readonly #obstacles: readonly Obstacle[];
  readonly #floorCollider: number;
  readonly #pusherCollider: number;
  /** Insertion-ordered by ascending coin id, which fixes the iteration order. */
  readonly #coins = new Map<number, RigidBody>();
  /** Each coin's rest state, in the same order as #coins. */
  readonly #rest = new Map<number, Rest>();
  readonly #idByCollider = new Map<number, number>();
  /** Awake coins by grid cell, rebuilt by #pressedFrozen every tick. */
  readonly #nearCells = new Map<number, Rest[]>();
  /** The cell lists #nearCells has used, kept for reuse; see Rest.read. */
  readonly #cellPool: Rest[][] = [];
  /** Awake coins too fast for the grid, rebuilt by #pressedFrozen every tick. */
  readonly #farCoins: Rest[] = [];
  /** Frozen coins by grid cell (TOUCH_REACH wide), rebuilt by #cascade every tick. */
  readonly #frozenCells = new Map<number, Rest[]>();
  /** The cell lists #frozenCells has used, kept for reuse. */
  readonly #frozenPool: Rest[][] = [];
  /** #cascade's queue: each coin pushing on, with the push it passes on. */
  readonly #pushQueue: Push[] = [];
  /** The pushes #pushQueue has used, kept for reuse. */
  readonly #pushPool: Push[] = [];
  /** Pose reads that nothing keeps past the call reading them. */
  readonly #scratch: Vector = { x: 0, y: 0, z: 0 };
  readonly #scratchCarry: Vector = { x: 0, y: 0, z: 0 };
  readonly #scratchRotation: Rotation = { x: 0, y: 0, z: 0, w: 1 };
  /** The coins #absorbImpacts may brake in the current substep. */
  readonly #fastCoins = new Set<number>();
  /** The pusher's velocity along z over the last tick, in world units per second. */
  #pusherSpeed = 0;
  /** The strongest contact each coin made during the current step. */
  readonly #pendingContacts = new Map<number, PendingContact>();
  /** The tick of each coin's last reported contact, for CONTACT_EVENTS.cooldownTicks. */
  readonly #lastContact = new Map<number, number>();
  #contacts: ContactEvent[] = [];
  #nextCoinId = 0;
  #separation: SeparationResult = { moved: 0, passes: 0, converged: true, loosened: [] };

  constructor(rapier: Rapier, world: World, options: TableOptions = {}) {
    this.#rapier = rapier;
    this.#world = world;
    this.#clock = new PusherClock(
      options.pusher ?? DEFAULT_PUSHER_MOTION,
      options.pusherTickInCycle ?? 0,
    );
    this.#coinShape = new rapier.RoundCylinder(
      (COIN.halfThickness - COIN_MATERIAL.rimRadius) * SCALE,
      (COIN.radius - COIN_MATERIAL.rimRadius) * SCALE,
      COIN_MATERIAL.rimRadius * SCALE,
    );
    const obstacles: Obstacle[] = [];
    this.#floorCollider = this.#buildCabinet(obstacles);
    [this.#pusher, this.#pusherCollider] = this.#buildPusher(obstacles);
    this.#obstacles = obstacles;
    this.#separator = new CoinSeparator(
      rapier,
      this.#coinShape,
      {
        coreHalfHeight: (COIN.halfThickness - COIN_MATERIAL.rimRadius) * SCALE,
        coreRadius: (COIN.radius - COIN_MATERIAL.rimRadius) * SCALE,
        rim: COIN_MATERIAL.rimRadius * SCALE,
      },
      obstacles,
      { slop: TABLE_SOLVER.separationSlop * SCALE, passes: TABLE_SOLVER.separationPasses },
    );
  }

  get coinCount(): number {
    return this.#coins.size;
  }

  get nextCoinId(): number {
    return this.#nextCoinId;
  }

  /** What the separation pass did on the last tick. */
  get separation(): SeparationResult {
    return this.#separation;
  }

  /** The contacts made during the last step, in ascending coin id order. */
  get contacts(): readonly ContactEvent[] {
    return this.#contacts;
  }

  get pusher(): PusherState {
    return {
      phase: this.#clock.phase,
      extension: this.#clock.extension,
      frontZ: PUSHER.frontZ + this.#clock.offset,
      motion: this.#clock.motion,
    };
  }

  /** Whole ticks into the pusher's current cycle. */
  get pusherTickInCycle(): number {
    return this.#clock.tickInCycle;
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
      sleeping: this.#isFrozen(id) || body.isSleeping(),
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

  /**
   * Lays the first `count` coins of the opening heap (see HEAP_TUNING) against the
   * pusher where it stands now and the stroke it is set to, with jitter and headings
   * drawn from `rng`, and returns their ids in laying order. Spots in `layout.keepClear`
   * are left bare. Throws, placing nothing, if the heap cannot hold `count` coins.
   */
  placeHeap(count: number, rng: Xoshiro128ss, layout: HeapLayout = {}): number[] {
    const poses = heapPoses(count, heapGeometry(this.#clock, layout), rng);
    return poses.map(({ translation, rotation }) => this.addCoin(translation, rotation));
  }

  /**
   * The first `count` poses of the opening heap as placeHeap lays it on a new table with
   * this table's motion, the pusher fully retracted, wherever this one stands now.
   */
  heapSlotPoses(count: number, rng: Xoshiro128ss, layout: HeapLayout = {}): HeapPose[] {
    return heapPoses(count, heapGeometry(new PusherClock(this.#clock.motion), layout), rng);
  }

  /**
   * Lays a saved table on this empty one, ids 0..n − 1 in `coins` order, every coin with
   * zero velocity relative to what it lies on: a coin awake with its centre over the
   * pusher top, or past its face by less than a radius, moves with the block, as every
   * check on the table measures it; left still there, it would slide against the block
   * and wake the riders around it. Heap slots are lifted clear first (RestoreCoin.lift),
   * then one separation pass removes what overlap the saved poses kept. A coin that was
   * asleep restores at rest unless a COIN_RESTORE.probe cast straight down finds nothing
   * at rest to hold it (#restingIds), or it hangs past the pusher's lip, where no coin
   * ever comes to rest; then it restores awake and settles. Throws if the table already has coins, or if a heap slot
   * cannot be lifted clear below the top of the walls.
   */
  restore(coins: readonly RestoreCoin[]): number[] {
    if (this.#nextCoinId !== 0) {
      throw new Error('PusherTable.restore: the table already has coins; restore onto a new table');
    }
    const pusher = this.#pusherBox();
    const placed: Disc[] = [];
    const translations = coins.map((coin) => {
      if (!coin.lift) {
        placed.push(discAt(coin.translation, coin.rotation));
      }
      return coin.translation;
    });
    coins.forEach((coin, i) => {
      if (!coin.lift) {
        return;
      }
      const { x, y, z } = coin.translation;
      for (let lifts = 0; ; lifts++) {
        const translation = { x, y: y + lifts * COIN_RESTORE.liftStep, z };
        if (translation.y > PLAYFIELD.wallHeight) {
          throw new Error(
            `PusherTable.restore: heap slot coin ${i} at (${x}, ${y}, ${z}) cannot be lifted clear below the wall top`,
          );
        }
        const disc = discAt(translation, coin.rotation);
        if (!blocked(disc, placed, pusher)) {
          placed.push(disc);
          translations[i] = translation;
          break;
        }
      }
    });
    const ids = coins.map((coin, i) =>
      this.addCoin(translations[i] ?? coin.translation, coin.rotation),
    );
    this.#separator.separate(this.#coins.values());
    const holds = this.#restingIds(ids, coins);
    const shelfSpeed = this.#lastPusherSpeed();
    const shelfFrontZ = pusher.z + pusher.hz + COIN.radius * SCALE;
    ids.forEach((id, i) => {
      if (holds[i]) {
        this.#restAsIs(id);
      }
      if (!coins[i]?.lift && !this.#isFrozen(id)) {
        const body = this.#coin(id);
        const t = body.translation();
        if (t.y > SHELF_Y && t.z <= shelfFrontZ) {
          body.setLinvel({ x: 0, y: 0, z: shelfSpeed }, true);
        }
      }
    });
    return ids;
  }

  /** The pusher's speed over the tick that brought it to where it stands, in world units. */
  #lastPusherSpeed(): number {
    const { motion, tickInCycle, offset } = this.#clock;
    const before = new PusherClock(
      motion,
      (tickInCycle + motion.periodTicks - 1) % motion.periodTicks,
    );
    return ((offset - before.offset) * SCALE) / FIXED_DT;
  }

  /** How many coins placeHeap can lay with `layout` on a new table driven by `motion`. */
  static heapCapacity(layout: HeapLayout = {}, motion = DEFAULT_PUSHER_MOTION): number {
    return heapCapacity(heapGeometry(new PusherClock(motion), layout));
  }

  /**
   * Wakes every frozen coin whose centre lies in the box from `min` to `max`, in
   * metres. Call it after adding or growing a fixed collider there: a frozen coin is a
   * kinematic body, and Rapier makes no contacts between a kinematic body and a fixed
   * one, so a frozen coin would neither feel nor be pushed out of it.
   */
  wakeRegion(min: Readonly<Vector>, max: Readonly<Vector>): void {
    if (!(min.x <= max.x && min.y <= max.y && min.z <= max.z)) {
      throw new RangeError(
        `PusherTable.wakeRegion: min (${min.x}, ${min.y}, ${min.z}) must not exceed max (${max.x}, ${max.y}, ${max.z}) on any axis`,
      );
    }
    for (const [id, body] of this.#coins) {
      if (!this.#isFrozen(id)) {
        continue;
      }
      const t = body.translation(this.#scratch);
      if (
        t.x >= min.x * SCALE &&
        t.x <= max.x * SCALE &&
        t.y >= min.y * SCALE &&
        t.y <= max.y * SCALE &&
        t.z >= min.z * SCALE &&
        t.z <= max.z * SCALE
      ) {
        this.#wake(id);
      }
    }
  }

  /**
   * Takes a coin off the table without reporting a fall, as when a fusion consumes it.
   * Throws for an id that is not on the table.
   */
  removeCoin(id: number): void {
    const body = this.#coins.get(id);
    if (!body) {
      throw new RangeError(`PusherTable.removeCoin: coin ${id} is not on the table`);
    }
    this.#wakeAround(body.translation());
    this.#forget(id);
    this.#world.removeRigidBody(body);
  }

  /** Jolts the cabinet: every coin gets the same change of velocity (NUDGE), waking it. */
  nudge(direction: NudgeDirection): void {
    let dx = 0;
    let dz = 0;
    switch (direction) {
      case 'forward':
        dz = NUDGE.push * SCALE;
        break;
      case 'left':
        dx = -NUDGE.sideways * SCALE;
        break;
      case 'right':
        dx = NUDGE.sideways * SCALE;
        break;
      default:
        throw new TypeError(`PusherTable.nudge: unknown direction ${JSON.stringify(direction)}`);
    }
    const lift = NUDGE.lift * SCALE;
    for (const id of this.#coins.keys()) {
      this.#wake(id);
    }
    for (const body of this.#coins.values()) {
      const v = body.linvel();
      body.setLinvel({ x: v.x + dx, y: v.y + lift, z: v.z + dz }, true);
    }
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
    const collider = this.#world.createCollider(
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
    this.#rest.set(id, {
      collider,
      still: 0,
      anchor: [0, 0, 0, 0, 0, 0],
      frozen: false,
      rider: false,
      damped: false,
      read: false,
      v: { x: 0, y: 0, z: 0 },
      t: { x: 0, y: 0, z: 0 },
      reachSq: 0,
    });
    this.#idByCollider.set(collider.handle, id);
    this.#nextCoinId += 1;
    return id;
  }

  /**
   * Advances the table by one tick: sweeps the pusher, steps the world, then removes
   * every coin that fell below the fall plane and reports where it left, in ascending
   * coin id order. `tick` is the tick count after this step, like Sim.tick.
   */
  step(tick: number): FallEvent[] {
    this.#pendingContacts.clear();
    const from = this.#clock.offset;
    this.#clock.advance();
    const to = this.#clock.offset;
    this.#pusherSpeed = ((to - from) * SCALE) / FIXED_DT;
    this.#pushQueue.length = 0;
    this.#wakeAhead(from, to);
    this.#cascade();
    const carry = ((to - from) * SCALE) / SUBSTEPS;
    for (let i = 1; i <= SUBSTEPS; i++) {
      this.#pusher.setNextKinematicTranslation(
        this.#pusherCentre(from + ((to - from) * i) / SUBSTEPS),
      );
      this.#carryRiders(carry);
      this.#absorbImpacts();
      this.#stepWorld();
    }
    this.#separation = this.#separator.separate(this.#coins.values());
    for (const body of this.#separation.loosened) {
      this.#wake(this.#idOf(body.collider(0)));
    }
    const falls = this.#collectFalls(tick);
    this.#contacts = this.#collectContacts(tick);
    this.#settle();
    return falls;
  }

  /**
   * World.step without its wrapper upkeep: after every step it walks every body and
   * collider handle to wrap the pieces soft bodies tore off, and the table has no soft
   * bodies. That walk was a fifth of the garbage a tick made.
   */
  #stepWorld(): void {
    const w = this.#world;
    w.physicsPipeline.step(
      w.gravity,
      w.integrationParameters,
      w.islands,
      w.broadPhase,
      w.narrowPhase,
      w.bodies,
      w.colliders,
      w.softBodies,
      w.impulseJoints,
      w.multibodyJoints,
      w.ccdSolver,
    );
  }

  #idOf(collider: Collider): number {
    const id = this.#idByCollider.get(collider.handle);
    if (id === undefined) {
      throw new Error(`collider ${collider.handle} is not a coin on this table`);
    }
    return id;
  }

  #isFrozen(id: number): boolean {
    return this.#rest.get(id)?.frozen === true;
  }

  #restOf(id: number): Rest {
    const rest = this.#rest.get(id);
    if (!rest) {
      throw new Error(`PusherTable: coin ${id} has no rest state`);
    }
    return rest;
  }

  /** Thaws a frozen coin into a dynamic body moving with what it lay on. */
  #wake(id: number): void {
    const rest = this.#restOf(id);
    rest.still = 0;
    if (!rest.frozen) {
      return;
    }
    rest.frozen = false;
    const body = this.#coins.get(id);
    if (!body) {
      throw new Error(`PusherTable: coin ${id} has rest state but no body`);
    }
    body.setBodyType(this.#rapier.RigidBodyType.Dynamic, true);
    body.setLinvel({ x: 0, y: 0, z: rest.rider ? this.#pusherSpeed : 0 }, true);
    body.setAngvel(ZERO, true);
  }

  #freeze(id: number, body: RigidBody): void {
    const rest = this.#restOf(id);
    rest.frozen = true;
    rest.still = 0;
    rest.rider = body.translation().y > SHELF_Y;
    body.setBodyType(
      rest.rider
        ? this.#rapier.RigidBodyType.KinematicPositionBased
        : this.#rapier.RigidBodyType.Fixed,
      false,
    );
  }

  /**
   * Which restored coins come to rest, by index: the asleep poses a COIN_RESTORE.probe
   * cast holds up on the cabinet or on another coin that comes to rest. A coin lying on
   * one that restores awake would start on a support settling from a standstill, without
   * the contact impulses that held it up, and be shaken loose; it restores awake too.
   */
  #restingIds(ids: readonly number[], coins: readonly RestoreCoin[]): boolean[] {
    const holds = ids.map((_, i) => coins[i]?.asleep === true && !coins[i].lift);
    const resting = new Set(ids.filter((_, i) => holds[i]));
    for (let changed = true; changed;) {
      changed = false;
      ids.forEach((id, i) => {
        if (holds[i] && !this.#held(id, resting)) {
          holds[i] = false;
          resting.delete(id);
          changed = true;
        }
      });
    }
    return holds;
  }

  /**
   * Whether a COIN_RESTORE.probe cast straight down drives the coin into the cabinet or
   * one of the `supports` coins.
   */
  #held(id: number, supports: ReadonlySet<number>): boolean {
    const disc = this.#discOf(this.#coin(id));
    const down = { ...disc, y: disc.y - PROBE };
    const grips = (now: number, after: number): boolean => after > 0 && after - now >= PROBE_GRIP;
    for (const obstacle of this.#obstacles) {
      const c = obstacle.centre();
      const box = {
        x: c.x,
        y: c.y,
        z: c.z,
        hx: obstacle.half.x,
        hy: obstacle.half.y,
        hz: obstacle.half.z,
      };
      if (grips(discBoxDepth(COIN_DISC, disc, box), discBoxDepth(COIN_DISC, down, box))) {
        return true;
      }
    }
    const reach = 2 * COIN_REACH + PROBE;
    for (const [other, body] of this.#coins) {
      if (other === id || !supports.has(other)) {
        continue;
      }
      const near = this.#discOf(body);
      const dx = near.x - disc.x;
      const dy = near.y - disc.y;
      const dz = near.z - disc.z;
      if (dx * dx + dy * dy + dz * dz >= reach * reach) {
        continue;
      }
      if (grips(discDiscDepth(COIN_DISC, near, disc), discDiscDepth(COIN_DISC, near, down))) {
        return true;
      }
    }
    return false;
  }

  /** Freezes a restored coin where it lies, its still run anchored there. */
  #restAsIs(id: number): void {
    const body = this.#coin(id);
    const rest = this.#restOf(id);
    const t = body.translation();
    const shelf = t.y > SHELF_Y;
    const z = t.z - (shelf ? this.#clock.offset * SCALE : 0);
    if (shelf && z > SHELF_EDGE_Z) {
      return;
    }
    const q = body.rotation();
    const { ax, ay, az } = discAxis(q.x, q.y, q.z, q.w);
    rest.anchor[0] = t.x;
    rest.anchor[1] = t.y;
    rest.anchor[2] = z;
    rest.anchor[3] = ax;
    rest.anchor[4] = ay;
    rest.anchor[5] = az;
    this.#freeze(id, body);
  }

  #discOf(body: RigidBody): Disc {
    const t = body.translation();
    const q = body.rotation();
    return { x: t.x, y: t.y, z: t.z, ...discAxis(q.x, q.y, q.z, q.w) };
  }

  #pusherBox(): Box {
    const c = this.#pusherCentre(this.#clock.offset);
    return { x: c.x, y: c.y, z: c.z, hx: PUSHER_HALF.x, hy: PUSHER_HALF.y, hz: PUSHER_HALF.z };
  }

  /** Moves every coin frozen on the pusher top `dz` world units along with the block. */
  #carryRiders(dz: number): void {
    if (dz === 0) {
      return;
    }
    for (const [id, body] of this.#coins) {
      const rest = this.#restOf(id);
      if (rest.frozen && rest.rider) {
        const t = body.translation(this.#scratch);
        const next = this.#scratchCarry;
        next.x = t.x;
        next.y = t.y;
        next.z = t.z + dz;
        body.setNextKinematicTranslation(next);
      }
    }
  }

  /**
   * Before the pusher moves from offset `from` to `to`: wakes the frozen coins on the
   * lower tier its face comes near, and on the way back the riders it carries near the
   * backboard.
   */
  #wakeAhead(from: number, to: number): void {
    if (from === to) {
      return;
    }
    const margin = COIN_REST.pusherMargin + COIN.radius;
    const faceZ = (PUSHER.frontZ + Math.max(from, to) + margin) * SCALE;
    const boardZ = (BACKBOARD.frontZ + margin + Math.max(0, from - to)) * SCALE;
    for (const [id, body] of this.#coins) {
      const rest = this.#restOf(id);
      if (!rest.frozen) {
        continue;
      }
      const t = body.translation(this.#scratch);
      if (rest.rider ? to < from && t.z < boardZ : t.z < faceZ) {
        this.#wake(id);
        this.#pushOn(t, TOUCH_REACH, 0, 0, Math.abs(this.#pusherSpeed));
      }
    }
  }

  /** Queues a push for #cascade, reusing a pooled one. */
  #pushOn(from: Readonly<Vector>, reach: number, vx: number, vy: number, vz: number): void {
    const queue = this.#pushQueue;
    let push = this.#pushPool[queue.length];
    if (push === undefined) {
      push = { x: 0, y: 0, z: 0, reach: 0, vx: 0, vy: 0, vz: 0 };
      this.#pushPool.push(push);
    }
    push.x = from.x;
    push.y = from.y;
    push.z = from.z;
    push.reach = reach;
    push.vx = vx;
    push.vy = vy;
    push.vz = vz;
    queue.push(push);
  }

  /**
   * Before a tick's substeps: wakes the frozen coins that a coin moving into them will
   * touch during the tick, and the ones those touch in turn, so the solver carries the
   * whole push. Left frozen, each coin in the way would be a wall until the tick after
   * it was struck (#settle), soaking up the push one coin at a time: a drop or the face
   * would move the coin it touches and nothing beyond. A coin is in the way when its
   * centre is within TOUCH_REACH of the pushing coin's (plus how far that one moves in
   * the tick) and within the COIN_REST.cascadeConeCos cone of the push's direction; each coin woken
   * passes the push on at COIN_REST.cascadeKeep of the speed, while that stays over
   * COIN_REST.wakeSpeed. The pushes start from every awake coin moving faster than
   * COIN_REST.cascadeSpeed across what it lies on, and from the coins #wakeAhead woke
   * for the face and the backboard.
   */
  #cascade(): void {
    const queue = this.#pushQueue;
    for (const [id, rest] of this.#rest) {
      if (rest.frozen) {
        continue;
      }
      const body = this.#coin(id);
      const v = body.linvel(this.#scratchCarry);
      const t = body.translation(this.#scratch);
      const vz = v.z - (t.y > SHELF_Y ? this.#pusherSpeed : 0);
      const speedSq = v.x * v.x + v.y * v.y + vz * vz;
      if (speedSq > CASCADE_SPEED_SQ) {
        this.#pushOn(t, TOUCH_REACH + Math.sqrt(speedSq) * FIXED_DT, v.x, v.y, vz);
      }
    }
    if (queue.length === 0) {
      return;
    }
    const cells = this.#frozenCells;
    cells.clear();
    let pooled = 0;
    for (const [id, rest] of this.#rest) {
      if (!rest.frozen) {
        continue;
      }
      const t = this.#coin(id).translation(rest.t);
      const key = cellKey(Math.floor(t.x / TOUCH_REACH), Math.floor(t.z / TOUCH_REACH));
      const cell = cells.get(key);
      if (cell) {
        cell.push(rest);
        continue;
      }
      let fresh = this.#frozenPool[pooled];
      if (fresh === undefined) {
        fresh = [];
        this.#frozenPool.push(fresh);
      }
      pooled += 1;
      fresh.length = 0;
      fresh.push(rest);
      cells.set(key, fresh);
    }
    if (cells.size === 0) {
      return;
    }
    for (const push of queue) {
      const span = Math.ceil(push.reach / TOUCH_REACH);
      const ix = Math.floor(push.x / TOUCH_REACH);
      const iz = Math.floor(push.z / TOUCH_REACH);
      const reachSq = push.reach * push.reach;
      const speedSq = push.vx * push.vx + push.vy * push.vy + push.vz * push.vz;
      const passOn = speedSq * CASCADE_KEEP_SQ > WAKE_SPEED_SQ;
      for (let cx = ix - span; cx <= ix + span; cx++) {
        for (let cz = iz - span; cz <= iz + span; cz++) {
          for (const rest of cells.get(cellKey(cx, cz)) ?? NO_COINS) {
            if (!rest.frozen) {
              continue;
            }
            const ex = rest.t.x - push.x;
            const ey = rest.t.y - push.y;
            const ez = rest.t.z - push.z;
            const distSq = ex * ex + ey * ey + ez * ez;
            const along = ex * push.vx + ey * push.vy + ez * push.vz;
            if (
              distSq > reachSq ||
              along <= 0 ||
              along * along < CASCADE_CONE_SQ * distSq * speedSq
            ) {
              continue;
            }
            this.#wake(this.#idOf(rest.collider));
            if (passOn) {
              const keep = COIN_REST.cascadeKeep;
              this.#pushOn(rest.t, TOUCH_REACH, push.vx * keep, push.vy * keep, push.vz * keep);
            }
          }
        }
      }
    }
  }

  #coin(id: number): RigidBody {
    const body = this.#coins.get(id);
    if (!body) {
      throw new Error(`PusherTable: coin ${id} has rest state but no body`);
    }
    return body;
  }

  /** Wakes every frozen coin within two coin widths of `centre`, in world units. */
  #wakeAround(centre: Readonly<Vector>): void {
    const reach = 4 * COIN.radius * SCALE;
    for (const [id, body] of this.#coins) {
      if (!this.#isFrozen(id)) {
        continue;
      }
      const t = body.translation(this.#scratchCarry);
      const dx = t.x - centre.x;
      const dy = t.y - centre.y;
      const dz = t.z - centre.z;
      if (dx * dx + dy * dy + dz * dz < reach * reach) {
        this.#wake(id);
      }
    }
  }

  /**
   * After a tick: wakes the frozen coins an awake coin moves against or presses hard
   * on, then counts every awake coin's still ticks and freezes those still for
   * COIN_REST.ticks.
   */
  #settle(): void {
    for (const id of this.#pressedFrozen()) {
      this.#wake(id);
    }
    for (const [id, body] of this.#coins) {
      const rest = this.#restOf(id);
      if (rest.frozen) {
        continue;
      }
      const v = rest.read ? rest.v : body.linvel(rest.v);
      const t = rest.read ? rest.t : body.translation(rest.t);
      rest.read = false;
      const shelf = t.y > SHELF_Y;
      const dz = v.z - (shelf ? this.#pusherSpeed : 0);
      const slow = v.x * v.x + v.y * v.y + dz * dz < SLOW_SPEED_SQ;
      if (slow !== rest.damped) {
        rest.damped = slow;
        body.setAngularDamping(slow ? COIN_REST.angularDamping : COIN_MATERIAL.angularDamping);
      }
      const q = body.rotation(this.#scratchRotation);
      const nx = 2 * (q.x * q.y - q.w * q.z);
      const ny = 1 - 2 * (q.x * q.x + q.z * q.z);
      const nz = 2 * (q.y * q.z + q.w * q.x);
      const z = t.z - (shelf ? this.#clock.offset * SCALE : 0);
      const ex = t.x - rest.anchor[0];
      const ey = t.y - rest.anchor[1];
      const ez = z - rest.anchor[2];
      const tilt = nx * rest.anchor[3] + ny * rest.anchor[4] + nz * rest.anchor[5];
      const norm = nx * nx + ny * ny + nz * nz;
      if (
        rest.still > 0 &&
        ex * ex + ey * ey + ez * ez < REST_DRIFT_SQ &&
        tilt * tilt > REST_TURN_COS_SQ * norm * norm &&
        tilt > 0
      ) {
        rest.still += 1;
      } else {
        rest.still = 1;
        rest.anchor[0] = t.x;
        rest.anchor[1] = t.y;
        rest.anchor[2] = z;
        rest.anchor[3] = nx;
        rest.anchor[4] = ny;
        rest.anchor[5] = nz;
      }
      if (rest.still > COIN_REST.ticks && !(shelf && z > SHELF_EDGE_Z)) {
        this.#freeze(id, body);
      }
    }
  }

  /**
   * The frozen coins an awake coin moves against or presses on, in ascending id order.
   * Rapier is asked about a pair only when the two centres are within NEAR_REACH (plus
   * how far the awake coin moves in a tick), so a frozen coin with no awake neighbour
   * costs nothing: walking every frozen coin's contact pairs instead took a fifth of a
   * millisecond a tick on the full table.
   */
  #pressedFrozen(): number[] {
    const cells = this.#nearCells;
    cells.clear();
    const pool = this.#cellPool;
    let pooled = 0;
    const fast = this.#farCoins;
    fast.length = 0;
    for (const [id, rest] of this.#rest) {
      if (rest.frozen) {
        continue;
      }
      const body = this.#coins.get(id);
      if (!body) {
        throw new Error(`PusherTable: coin ${id} has rest state but no body`);
      }
      const v = body.linvel(rest.v);
      const t = body.translation(rest.t);
      rest.read = true;
      const reach = NEAR_REACH + Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) * FIXED_DT;
      rest.reachSq = reach * reach;
      if (reach > NEAR_CELL) {
        fast.push(rest);
        continue;
      }
      const key = cellKey(Math.floor(t.x / NEAR_CELL), Math.floor(t.z / NEAR_CELL));
      const cell = cells.get(key);
      if (cell) {
        cell.push(rest);
      } else {
        let fresh = pool[pooled];
        if (fresh === undefined) {
          fresh = [];
          pool.push(fresh);
        }
        pooled += 1;
        fresh.length = 0;
        fresh.push(rest);
        cells.set(key, fresh);
      }
    }
    const pressed: number[] = [];
    if (cells.size === 0 && fast.length === 0) {
      return pressed;
    }
    const offset = this.#clock.offset * SCALE;
    for (const [id, rest] of this.#rest) {
      if (!rest.frozen) {
        continue;
      }
      const x = rest.anchor[0];
      const y = rest.anchor[1];
      const z = rest.anchor[2] + (rest.rider ? offset : 0);
      const ix = Math.floor(x / NEAR_CELL);
      const iz = Math.floor(z / NEAR_CELL);
      let found = this.#anyPresses(fast, rest, x, y, z);
      for (let cx = ix - 1; cx <= ix + 1 && !found; cx++) {
        for (let cz = iz - 1; cz <= iz + 1 && !found; cz++) {
          found = this.#anyPresses(cells.get(cellKey(cx, cz)), rest, x, y, z);
        }
      }
      if (found) {
        pressed.push(id);
      }
    }
    return pressed;
  }

  /** Whether one of `coins` presses on the frozen coin `rest`, whose centre is (x, y, z). */
  #anyPresses(
    coins: readonly Rest[] | undefined,
    rest: Rest,
    x: number,
    y: number,
    z: number,
  ): boolean {
    if (coins === undefined) {
      return false;
    }
    for (const coin of coins) {
      const ex = coin.t.x - x;
      const ey = coin.t.y - y;
      const ez = coin.t.z - z;
      if (ex * ex + ey * ey + ez * ez > coin.reachSq) {
        continue;
      }
      const { v } = coin;
      const dz = v.z - (rest.rider ? this.#pusherSpeed : 0);
      const speedSq = v.x * v.x + dz * dz;
      const moving = speedSq > WAKE_SPEED_SQ || v.y * v.y > WAKE_FALL_SQ;
      const reach = Math.sqrt(speedSq + v.y * v.y) * FIXED_DT;
      if (this.#presses(coin.collider, rest.collider, moving, reach)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Whether `a` touches `b` (when `moving`) or presses on it harder than
   * COIN_REST.wakeImpulse (when not), going by their contact points from the last substep.
   */
  #presses(a: Collider, b: Collider, moving: boolean, reach: number): boolean {
    let pressing = false;
    this.#world.contactPair(a, b, (manifold) => {
      for (let i = 0; i < manifold.numContacts() && !pressing; i++) {
        pressing = moving
          ? manifold.contactDist(i) < TOUCH_DIST + reach
          : manifold.contactImpulse(i) > WAKE_IMPULSE;
      }
    });
    return pressing;
  }

  #collectContacts(tick: number): ContactEvent[] {
    const contacts: ContactEvent[] = [];
    const ids = Array.from(this.#pendingContacts.keys()).sort((a, b) => a - b);
    for (const coinId of ids) {
      const pending = this.#pendingContacts.get(coinId);
      const last = this.#lastContact.get(coinId);
      if (!pending || (last !== undefined && tick - last < CONTACT_EVENTS.cooldownTicks)) {
        continue;
      }
      this.#lastContact.set(coinId, tick);
      contacts.push({
        coinId,
        tick,
        position: pending.position,
        speed: pending.speed,
        strength: Math.min(1, pending.speed / CONTACT_EVENTS.fullSpeed),
        surface: pending.surface,
      });
    }
    return contacts;
  }

  #recordContact(id: number, body: RigidBody, speed: number, surface: ContactSurface): void {
    const pending = this.#pendingContacts.get(id);
    if (pending && pending.speed >= speed) {
      return;
    }
    this.#pendingContacts.set(id, { speed, surface, position: toMetres(body.translation()) });
  }

  #surfaceOf(collider: number, other: RigidBody | null): ContactSurface {
    if (other?.isDynamic()) {
      return 'coin';
    }
    if (collider === this.#pusherCollider) {
      return 'pusher';
    }
    return collider === this.#floorCollider ? 'floor' : 'cabinet';
  }

  #forget(id: number): void {
    const rest = this.#rest.get(id);
    if (rest) {
      this.#idByCollider.delete(rest.collider.handle);
    }
    this.#rest.delete(id);
    this.#coins.delete(id);
    this.#lastContact.delete(id);
  }

  /**
   * Brakes every fast coin that would strike something during the coming substep,
   * like a speculative contact: the closing speed along the contact normal is cut so
   * the coin only just reaches the contact by the end of the substep, and the
   * momentum it loses goes to the struck coin as an equal and opposite impulse (a
   * slab or the pusher absorbs it). Nothing is moved, so every cast sees the poses
   * the solver will start from. See COIN_MATERIAL.impactSpeed for why the solver is
   * not left to do this.
   */
  #absorbImpacts(): void {
    let fastest = 0;
    const fast = this.#fastCoins;
    fast.clear();
    for (const [id, body] of this.#coins) {
      const rest = this.#restOf(id);
      if (rest.frozen && !rest.rider) {
        continue;
      }
      const v = body.linvel(this.#scratch);
      const speedSq = v.x * v.x + v.y * v.y + v.z * v.z;
      fastest = Math.max(fastest, speedSq);
      if (speedSq > IMPACT_SPEED_SQ) {
        fast.add(id);
      }
    }
    if (fastest <= IMPACT_SPEED_SQ) {
      return;
    }
    fastest = Math.sqrt(fastest);
    // Only a coin that was fast above, or was struck since, can be fast enough to brake.
    for (const [id, body] of this.#coins) {
      if (!fast.has(id) || this.#isFrozen(id) || body.isSleeping()) {
        continue;
      }
      const checked: number[] = [];
      for (
        let pass = 0;
        pass < IMPACT_PASSES && this.#absorbImpact(id, body, fastest, checked);
        pass++
      ) {
        // A braked coin keeps its sliding speed, so look again along the new velocity.
      }
    }
  }

  /**
   * Casts the coin along its velocity past every collider in `checked`, brakes it
   * against the first thing it would hit and adds that collider to `checked`.
   * Returns whether there was anything to cast against. The cast reaches as far as
   * the coin and the fastest coin on the table could close in a substep, since what
   * it strikes may be coming the other way.
   */
  #absorbImpact(id: number, body: RigidBody, fastest: number, checked: number[]): boolean {
    const v = body.linvel();
    const speedSq = v.x * v.x + v.y * v.y + v.z * v.z;
    if (speedSq <= IMPACT_SPEED_SQ) {
      return false;
    }
    const dt = this.#world.timestep;
    const reach = (1 + fastest / Math.sqrt(speedSq)) * dt;
    const cast = { x: v.x * reach, y: v.y * reach, z: v.z * reach };
    const hit = this.#world.castShape(
      body.translation(),
      body.rotation(),
      cast,
      this.#coinShape,
      IMPACT_MARGIN,
      1,
      false,
      undefined,
      undefined,
      undefined,
      body,
      checked.length === 0 ? undefined : (collider) => !checked.includes(collider.handle),
    );
    if (!hit) {
      return false;
    }
    checked.push(hit.collider.handle);
    const struck = this.#idByCollider.get(hit.collider.handle);
    if (struck !== undefined) {
      this.#wake(struck);
      this.#fastCoins.add(struck);
    }
    const n = hit.normal1;
    const other = hit.collider.parent();
    const u = other && !other.isFixed() ? other.linvel() : ZERO;
    const closing = (v.x - u.x) * n.x + (v.y - u.y) * n.y + (v.z - u.z) * n.z;
    const gap = Math.max(0, -hit.time_of_impact * (cast.x * n.x + cast.y * n.y + cast.z * n.z));
    const removed = closing + gap / dt;
    if (removed >= 0) {
      return true;
    }
    this.#recordContact(id, body, -closing / SCALE, this.#surfaceOf(hit.collider.handle, other));
    const mass = body.mass();
    const otherMass = other?.isDynamic() ? other.mass() : 0;
    const share = otherMass > 0 ? otherMass / (mass + otherMass) : 1;
    body.setLinvel(
      {
        x: v.x - removed * share * n.x,
        y: v.y - removed * share * n.y,
        z: v.z - removed * share * n.z,
      },
      true,
    );
    if (other && otherMass > 0) {
      const impulse = removed * mass * share;
      other.applyImpulse({ x: impulse * n.x, y: impulse * n.y, z: impulse * n.z }, true);
    }
    return true;
  }

  #collectFalls(tick: number): FallEvent[] {
    const falls: FallEvent[] = [];
    for (const [id, body] of this.#coins) {
      if (this.#isFrozen(id) || body.isSleeping()) {
        continue;
      }
      const t = body.translation();
      if (t.y < FALL_Y) {
        falls.push({ coinId: id, edge: fallEdge(t.x / SCALE), tick });
        this.#forget(id);
        this.#pendingContacts.delete(id);
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
      const rest = this.#restOf(id);
      h.int(rest.still).bool(rest.frozen).bool(rest.rider).bool(rest.damped);
      for (const a of rest.anchor) {
        h.float(a);
      }
    }
    return h;
  }

  /** Builds the fixed cabinet and returns the handle of the lower-tier floor's collider. */
  #buildCabinet(obstacles: Obstacle[]): number {
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
    ): number => {
      const shape = new this.#rapier.Cuboid(hx * SCALE, hy * SCALE, hz * SCALE);
      const centre = { x: x * SCALE, y: y * SCALE, z: z * SCALE };
      obstacles.push({ shape, half: shape.halfExtents, centre: () => centre });
      return this.#world.createCollider(
        ColliderDesc.cuboid(hx * SCALE, hy * SCALE, hz * SCALE)
          .setTranslation(x * SCALE, y * SCALE, z * SCALE)
          .setFriction(friction)
          .setRestitution(TABLE_MATERIAL.restitution)
          .setRestitutionCombineRule(CoefficientCombineRule.Min),
        cabinet,
      ).handle;
    };
    const floor = add(
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
    return floor;
  }

  /** Builds the kinematic pusher and returns its body and its collider's handle. */
  #buildPusher(obstacles: Obstacle[]): [RigidBody, number] {
    const { RigidBodyDesc, ColliderDesc, CoefficientCombineRule } = this.#rapier;
    const centre = this.#pusherCentre(this.#clock.offset);
    const body = this.#world.createRigidBody(
      RigidBodyDesc.kinematicPositionBased().setTranslation(centre.x, centre.y, centre.z),
    );
    const collider = this.#world.createCollider(
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
    const shape = new this.#rapier.Cuboid(
      (PLAYFIELD.fieldHalfWidth - PUSHER.sideClearance) * SCALE,
      (PUSHER.height / 2) * SCALE,
      (PUSHER.depth / 2) * SCALE,
    );
    obstacles.push({ shape, half: shape.halfExtents, centre: () => body.translation() });
    return [body, collider.handle];
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
const NO_COINS: readonly Rest[] = [];

/** The heap laid against a pusher where `clock` has it now, reaching to its full stroke. */
function heapGeometry(clock: PusherClock, layout: HeapLayout): HeapGeometry {
  return {
    upperLipZ: PUSHER.frontZ + clock.offset,
    reachZ: PUSHER.frontZ + clock.motion.stroke,
    upperY: PUSHER.height,
    ...layout,
  };
}

/** A coin at `translation` metres, in world units. */
function discAt(translation: Readonly<Vector>, rotation: Readonly<Rotation>): Disc {
  return {
    x: translation.x * SCALE,
    y: translation.y * SCALE,
    z: translation.z * SCALE,
    ...discAxis(rotation.x, rotation.y, rotation.z, rotation.w),
  };
}

/** Whether `disc` touches the pusher or any coin in `placed`. */
function blocked(disc: Disc, placed: readonly Disc[], pusher: Box): boolean {
  if (discBoxDepth(COIN_DISC, disc, pusher) > 0) {
    return true;
  }
  const reach = 2 * COIN_REACH;
  for (const other of placed) {
    const dx = other.x - disc.x;
    const dy = other.y - disc.y;
    const dz = other.z - disc.z;
    if (dx * dx + dy * dy + dz * dz < reach * reach && discDiscDepth(COIN_DISC, other, disc) > 0) {
      return true;
    }
  }
  return false;
}

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
