import type {
  RigidBody,
  Rotation,
  Shape,
  Vector,
  World,
} from '@dimforge/rapier3d-deterministic-compat';
import { COIN, COIN_DROP_MAX_JITTER, COIN_DROP_MAX_TILT } from '../coin.ts';
import { GRAVITY } from '../constants.ts';
import type { StateHasher } from '../hash.ts';
import type { Xoshiro128ss } from '../prng.ts';
import { loadRapier, type Rapier } from '../rapier.ts';
import { BACKBOARD, DROP_ZONE, PLAYFIELD, PUSHER } from '../table/layout.ts';
import { DEFAULT_PUSHER_MOTION, PusherClock } from '../table/pusher.ts';
import type { TableCoin } from '../table/table.ts';
import {
  COIN_MATERIAL,
  configureTableWorld,
  TABLE_MATERIAL,
  TABLE_SOLVER,
} from '../table/tuning.ts';
import type { MechanicTable } from './table.ts';

const SCALE = TABLE_SOLVER.worldScale;
const FLAT: Readonly<Rotation> = { x: 0, y: 0, z: 0, w: 1 };

export interface RigOptions {
  /** Whether the upper tier slides like the pusher top (DEFAULT_PUSHER_MOTION). */
  readonly moving?: boolean;
}

/**
 * Test bench for the mechanics: the upper tier of the pusher table on its own, in a
 * world set up exactly like the table's (configureTableWorld, the same coin collider
 * and materials), with the `removeCoin` the mechanics need. The slab top is at
 * PUSHER.height and spans the pusher's width from the backboard forward; with
 * `moving` it slides back and forth under the fixed backboard on the pusher's own
 * clock, so coins ride it and pile against whatever is fixed above it. A coin that
 * falls off the front lip is removed and counted in `spilled`.
 */
export class MechanicsRig implements MechanicTable {
  readonly rapier: Rapier;
  readonly world: World;
  tick = 0;
  spilled = 0;
  readonly #slab: RigidBody;
  readonly #clock = new PusherClock(DEFAULT_PUSHER_MOTION);
  readonly #moving: boolean;
  readonly #coinShape: Shape;
  readonly #coins = new Map<number, RigidBody>();
  #spilledIds: number[] = [];
  #nextCoinId = 0;

  static async create(options: RigOptions = {}): Promise<MechanicsRig> {
    return new MechanicsRig(await loadRapier(), options);
  }

  private constructor(rapier: Rapier, options: RigOptions) {
    this.rapier = rapier;
    this.#moving = options.moving ?? false;
    this.world = new rapier.World(GRAVITY);
    configureTableWorld(this.world);
    this.#coinShape = new rapier.RoundCylinder(
      (COIN.halfThickness - COIN_MATERIAL.rimRadius) * SCALE,
      (COIN.radius - COIN_MATERIAL.rimRadius) * SCALE,
      COIN_MATERIAL.rimRadius * SCALE,
    );
    const { RigidBodyDesc, ColliderDesc, CoefficientCombineRule } = rapier;
    const halfWidth = PLAYFIELD.fieldHalfWidth - PUSHER.sideClearance;
    this.#slab = this.world.createRigidBody(
      RigidBodyDesc.kinematicPositionBased().setTranslation(...this.#slabCentre(0)),
    );
    this.world.createCollider(
      ColliderDesc.cuboid(
        halfWidth * SCALE,
        (PUSHER.height / 2) * SCALE,
        (PUSHER.depth / 2) * SCALE,
      )
        .setFriction(TABLE_MATERIAL.pusherFriction)
        .setRestitution(TABLE_MATERIAL.restitution)
        .setRestitutionCombineRule(CoefficientCombineRule.Min),
      this.#slab,
    );
    const cabinet = this.world.createRigidBody(RigidBodyDesc.fixed());
    const wall = (hx: number, hy: number, hz: number, x: number, y: number, z: number): void => {
      this.world.createCollider(
        ColliderDesc.cuboid(hx * SCALE, hy * SCALE, hz * SCALE)
          .setTranslation(x * SCALE, y * SCALE, z * SCALE)
          .setFriction(TABLE_MATERIAL.wallFriction)
          .setRestitution(TABLE_MATERIAL.restitution)
          .setRestitutionCombineRule(CoefficientCombineRule.Min),
        cabinet,
      );
    };
    const t = PLAYFIELD.wallThickness / 2;
    const h = PLAYFIELD.wallHeight / 2;
    const boardBottom = PUSHER.height - BACKBOARD.embed;
    const backZ = PUSHER.frontZ - PUSHER.depth;
    wall(halfWidth, h, t, 0, boardBottom + h, BACKBOARD.frontZ - t);
    for (const side of [-1, 1]) {
      wall(
        t,
        h,
        (PUSHER.frontZ - backZ) / 2,
        side * (halfWidth + t),
        h,
        (PUSHER.frontZ + backZ) / 2,
      );
    }
  }

  get coinCount(): number {
    return this.#coins.size;
  }

  coins(): TableCoin[] {
    return Array.from(this.#coins, ([id, body]) => {
      const t = body.translation();
      return {
        id,
        translation: { x: t.x / SCALE, y: t.y / SCALE, z: t.z / SCALE },
        rotation: body.rotation(),
        sleeping: body.isSleeping(),
      };
    });
  }

  /** Drops a coin the way PusherTable.dropCoin does, at `x` metres and `z` (DROP_ZONE.z by default). */
  dropCoin(x: number, rng: Xoshiro128ss, z: number = DROP_ZONE.z): number {
    const dz = rng.nextRange(-COIN_DROP_MAX_JITTER, COIN_DROP_MAX_JITTER);
    const tiltX = rng.nextRange(-COIN_DROP_MAX_TILT, COIN_DROP_MAX_TILT);
    const tiltZ = rng.nextRange(-COIN_DROP_MAX_TILT, COIN_DROP_MAX_TILT);
    const norm = Math.sqrt(tiltX * tiltX + tiltZ * tiltZ + 1);
    return this.addCoin(
      { x, y: PUSHER.height + DROP_ZONE.height, z: z + dz },
      { x: tiltX / norm, y: 0, z: tiltZ / norm, w: 1 / norm },
    );
  }

  /** A coin lying flat on the upper tier with its centre at (x, z), `layer` coins up. */
  placeFlat(x: number, z: number, layer = 0, velocity?: Readonly<Vector>): number {
    const pitch = 2 * (COIN.halfThickness + COIN_MATERIAL.contactSkin);
    const y = PUSHER.height + COIN.halfThickness + COIN_MATERIAL.contactSkin + layer * pitch;
    return this.addCoin({ x, y, z }, FLAT, velocity);
  }

  addCoin(
    translation: Readonly<Vector>,
    rotation: Readonly<Rotation>,
    velocity?: Readonly<Vector>,
  ): number {
    const { RigidBodyDesc, ColliderDesc, CoefficientCombineRule } = this.rapier;
    const desc = RigidBodyDesc.dynamic()
      .setTranslation(translation.x * SCALE, translation.y * SCALE, translation.z * SCALE)
      .setRotation(rotation)
      .setLinearDamping(COIN_MATERIAL.linearDamping)
      .setAngularDamping(COIN_MATERIAL.angularDamping)
      .setCanSleep(true)
      .setCcdEnabled(true);
    if (velocity) {
      desc.setLinvel(velocity.x * SCALE, velocity.y * SCALE, velocity.z * SCALE);
    }
    const body = this.world.createRigidBody(desc);
    this.world.createCollider(
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

  removeCoin(id: number): void {
    const body = this.#coins.get(id);
    if (!body) {
      throw new Error(`MechanicsRig.removeCoin: coin ${id} is not on the table`);
    }
    this.#coins.delete(id);
    this.world.removeRigidBody(body);
  }

  /** One tick: slab, two substeps, spill removal. Advances `tick`. */
  step(): void {
    const from = this.#clock.offset;
    if (this.#moving) {
      this.#clock.advance();
    }
    const to = this.#clock.offset;
    for (let i = 1; i <= TABLE_SOLVER.substeps; i++) {
      const [x, y, z] = this.#slabCentre(from + ((to - from) * i) / TABLE_SOLVER.substeps);
      this.#slab.setNextKinematicTranslation({ x, y, z });
      this.world.step();
    }
    for (const [id, body] of this.#coins) {
      if (body.translation().y < (PUSHER.height - 0.01) * SCALE) {
        this.removeCoin(id);
        this.spilled += 1;
        this.#spilledIds.push(id);
      }
    }
    this.tick += 1;
  }

  /** The ids of the coins that spilled since the last call, in the order they went. */
  takeSpilled(): number[] {
    const ids = this.#spilledIds;
    this.#spilledIds = [];
    return ids;
  }

  hashInto(h: StateHasher): StateHasher {
    h.int(this.tick).int(this.#nextCoinId).int(this.#coins.size).vec3(this.#slab.translation());
    for (const [id, body] of this.#coins) {
      h.int(id)
        .vec3(body.translation())
        .quat(body.rotation())
        .vec3(body.linvel())
        .vec3(body.angvel());
    }
    return h;
  }

  dispose(): void {
    this.#coins.clear();
    this.world.free();
  }

  #slabCentre(offset: number): [number, number, number] {
    return [0, (PUSHER.height / 2) * SCALE, (PUSHER.frontZ + offset - PUSHER.depth / 2) * SCALE];
  }
}
