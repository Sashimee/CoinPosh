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
import { type HeapGeometry, type HeapLayout, heapCapacity, heapPoses } from './heap.ts';
import { DEFAULT_PUSHER_MOTION, PusherClock, type PusherMotion } from './pusher.ts';
import { CoinSeparator, type Obstacle, type SeparationResult } from './separation.ts';
import { COIN_MATERIAL, CONTACT_EVENTS, NUDGE, TABLE_MATERIAL, TABLE_SOLVER } from './tuning.ts';

/** Mirrors FallEdge in packages/shared, which packages/sim cannot import yet. */
export type FallEdge = 'front' | 'left' | 'right';

/** Mirrors NudgeDirection in packages/shared, which packages/sim cannot import yet. */
export type NudgeDirection = 'left' | 'right' | 'forward';

export const NUDGE_DIRECTIONS: readonly NudgeDirection[] = ['left', 'right', 'forward'];

/**
 * What a coin struck: another coin, the pusher block (its face or the upper tier on
 * top of it), the lower-tier floor, or the rest of the cabinet (side walls, backboard).
 */
export type ContactSurface = 'coin' | 'pusher' | 'floor' | 'cabinet';

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
  readonly #separator: CoinSeparator;
  readonly #floorCollider: number;
  readonly #pusherCollider: number;
  /** Insertion-ordered by ascending coin id, which fixes the iteration order. */
  readonly #coins = new Map<number, RigidBody>();
  /** The strongest contact each coin made during the current step. */
  readonly #pendingContacts = new Map<number, PendingContact>();
  /** The tick of each coin's last reported contact, for CONTACT_EVENTS.cooldownTicks. */
  readonly #lastContact = new Map<number, number>();
  #contacts: ContactEvent[] = [];
  #nextCoinId = 0;
  #separation: SeparationResult = { moved: 0, passes: 0, converged: true };

  constructor(rapier: Rapier, world: World, options: TableOptions = {}) {
    this.#rapier = rapier;
    this.#world = world;
    this.#clock = new PusherClock(options.pusher ?? DEFAULT_PUSHER_MOTION);
    this.#coinShape = new rapier.RoundCylinder(
      (COIN.halfThickness - COIN_MATERIAL.rimRadius) * SCALE,
      (COIN.radius - COIN_MATERIAL.rimRadius) * SCALE,
      COIN_MATERIAL.rimRadius * SCALE,
    );
    const obstacles: Obstacle[] = [];
    this.#floorCollider = this.#buildCabinet(obstacles);
    [this.#pusher, this.#pusherCollider] = this.#buildPusher(obstacles);
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

  /** How many coins placeHeap can lay with `layout` on a new table driven by `motion`. */
  static heapCapacity(layout: HeapLayout = {}, motion = DEFAULT_PUSHER_MOTION): number {
    return heapCapacity(heapGeometry(new PusherClock(motion), layout));
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
    this.#pendingContacts.clear();
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
    this.#separation = this.#separator.separate(this.#coins.values());
    const falls = this.#collectFalls(tick);
    this.#contacts = this.#collectContacts(tick);
    return falls;
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
    for (const body of this.#coins.values()) {
      const v = body.linvel();
      fastest = Math.max(fastest, v.x * v.x + v.y * v.y + v.z * v.z);
    }
    if (fastest <= IMPACT_SPEED_SQ) {
      return;
    }
    fastest = Math.sqrt(fastest);
    for (const [id, body] of this.#coins) {
      if (body.isSleeping()) {
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
      (collider) => !checked.includes(collider.handle),
    );
    if (!hit) {
      return false;
    }
    checked.push(hit.collider.handle);
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
      if (body.isSleeping()) {
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

/** The heap laid against a pusher where `clock` has it now, reaching to its full stroke. */
function heapGeometry(clock: PusherClock, layout: HeapLayout): HeapGeometry {
  return {
    upperLipZ: PUSHER.frontZ + clock.offset,
    reachZ: PUSHER.frontZ + clock.motion.stroke,
    upperY: PUSHER.height,
    ...layout,
  };
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
