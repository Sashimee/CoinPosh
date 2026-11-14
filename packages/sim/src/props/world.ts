import type {
  Collider,
  ColliderDesc,
  RigidBody,
  World,
} from '@dimforge/rapier3d-deterministic-compat';
import { COIN } from '../coin.ts';
import { FIXED_DT } from '../constants.ts';
import type { StateHasher } from '../hash.ts';
import type { NudgeDirection } from '../inputs.ts';
import type { Rapier } from '../rapier.ts';
import {
  dequantizePosition,
  dequantizeRotation,
  type PropSnapshot,
  quantizePosition,
  quantizeRotation,
  ROTATION_UNIT,
} from '../snapshot/snapshot.ts';
import { BACKBOARD, PLAYFIELD, PUSHER, TABLE_INNER_HALF_WIDTH } from '../table/layout.ts';
import type { FallEdge, PusherTable } from '../table/table.ts';
import type { HeapKeepClear } from '../table/heap.ts';
import { COIN_MATERIAL, NUDGE, TABLE_SOLVER } from '../table/tuning.ts';
import {
  type BoundProp,
  type PropCoin,
  type PropKindName,
  type PropPose,
  sweepRadius,
} from './index.ts';
import {
  boundingRadius,
  conjugate,
  distanceAt,
  multiply,
  type PropShape,
  type Vec3,
} from './shape.ts';

const SCALE = TABLE_SOLVER.worldScale;
/** Half the side of the box wakeRegion is given to wake the one coin centred in it. */
const POINT_WAKE = 1e-6;
/** Highest a solid prop's lowest point may be and still keep the opening heap off its spot. */
const HEAP_TOP = PUSHER.height + 4 * COIN.halfThickness;

/** Something a prop did during one step, stamped with the tick after it. */
export type PropEvent =
  | {
      readonly kind: 'prop.enter';
      readonly coinId: number;
      readonly propId: number;
      readonly tick: number;
      /** Taken off the table by the prop; it is not reported as a fall. */
      readonly consumed: boolean;
      readonly tag: string | null;
    }
  | {
      readonly kind: 'prop.fall';
      readonly propId: number;
      readonly tick: number;
      readonly edge: FallEdge;
    };

/** A prop's pose in metres. */
export interface PropState {
  readonly id: number;
  readonly kind: PropKindName;
  /** False once a dynamic prop has fallen; its pose is where it left the table. */
  readonly present: boolean;
  readonly translation: Readonly<Vec3>;
  readonly rotation: Readonly<PropPose['rotation']>;
  readonly sleeping: boolean;
}

interface LiveProp {
  readonly prop: BoundProp;
  readonly body: RigidBody | null;
  readonly collider: Collider | null;
  clock: number;
  present: boolean;
  /** Where it left the table, once it has fallen. */
  lastPose: PropPose;
  /** Ids of the coins in it, ascending; see PropEnter. */
  inside: number[];
}

function fallEdge(x: number): FallEdge {
  if (x < -PLAYFIELD.fieldHalfWidth) {
    return 'left';
  }
  if (x > PLAYFIELD.fieldHalfWidth) {
    return 'right';
  }
  return 'front';
}

function scaled(v: Readonly<Vec3>): Vec3 {
  return { x: v.x * SCALE, y: v.y * SCALE, z: v.z * SCALE };
}

/**
 * The opening heap's bare spots for `props`: one for each solid prop low enough to stand
 * in the heap, wide enough for everywhere its path takes it.
 */
export function propKeepClear(props: readonly BoundProp[]): HeapKeepClear[] {
  return props
    .filter(
      (prop) =>
        prop.body !== 'ghost' && prop.home.translation.y - boundingRadius(prop.shape) < HEAP_TOP,
    )
    .map((prop) => ({
      x: prop.home.translation.x,
      z: prop.home.translation.z,
      radius: sweepRadius(prop),
    }));
}

/**
 * The props on a PusherTable, stepped in ascending id order around the table's own step:
 * `beforeStep` sets each kinematic prop moving towards its next pose and applies the
 * fields, then `afterStep` finds the props that fell and the coins that entered one.
 *
 * Frozen coins are kinematic or fixed bodies, which Rapier never brings into contact with
 * a kinematic or fixed prop, so every prop that moves wakes the coins in reach first.
 * Two limits remain until the table grows the API for them: a field finds a coin's body
 * through the world's query structure, which holds the poses of the last world step, so a
 * coin added since then, or moving faster than the broad phase's margin, feels nothing
 * that tick; and props are not CoinSeparator obstacles.
 */
export class TableProps {
  readonly #rapier: Rapier;
  readonly #world: World;
  readonly #table: PusherTable;
  readonly #live: LiveProp[];
  readonly #colliders = new Set<number>();
  readonly #fields: LiveProp[];
  readonly #enters: LiveProp[];

  constructor(
    rapier: Rapier,
    world: World,
    table: PusherTable,
    props: readonly BoundProp[],
    restore?: readonly PropSnapshot[],
  ) {
    this.#rapier = rapier;
    this.#world = world;
    this.#table = table;
    const saved = restore ? restoredProps(props, restore) : null;
    this.#live = props.map((prop) => {
      const entry = saved?.get(prop.id);
      const clock = entry?.clock ?? 0;
      const present = prop.body !== 'dynamic' || !entry || entry.pose !== undefined;
      const pose =
        entry?.pose !== undefined
          ? {
              translation: dequantizePosition(entry.pose.p),
              rotation: dequantizeRotation(entry.pose.q),
            }
          : prop.poseAt(clock);
      const [body, collider] = present
        ? this.#build(prop, pose, entry?.pose?.rest === 'asleep')
        : [null, null];
      if (collider) {
        this.#colliders.add(collider.handle);
      }
      return { prop, body, collider, clock, present, lastPose: pose, inside: [] };
    });
    this.#fields = this.#live.filter(({ prop }) => prop.fieldReach !== null);
    this.#enters = this.#live.filter(({ prop }) => prop.enterMargin !== null);
  }

  get count(): number {
    return this.#live.length;
  }

  /**
   * Run once the table's first coins are laid: wakes the coins any solid prop reaches,
   * so none rests frozen inside one, and counts the coins already in each prop as in,
   * without an event.
   */
  prime(coins: readonly PropCoin[]): void {
    for (const live of this.#live) {
      if (live.present && live.prop.body !== 'ghost') {
        this.#wakeAround(this.#pose(live), sweepRadius(live.prop));
      }
    }
    for (const live of this.#enters) {
      live.inside = this.#inside(live, coins);
    }
  }

  /** Gives every dynamic prop on the table the same jolt as the coins (NUDGE). */
  nudge(direction: NudgeDirection): void {
    const dx = direction === 'left' ? -NUDGE.sideways : direction === 'right' ? NUDGE.sideways : 0;
    const dz = direction === 'forward' ? NUDGE.push : 0;
    for (const { body, present, prop } of this.#live) {
      if (!body || !present || prop.body !== 'dynamic') {
        continue;
      }
      const v = body.linvel();
      body.setLinvel(
        { x: v.x + dx * SCALE, y: v.y + NUDGE.lift * SCALE, z: v.z + dz * SCALE },
        true,
      );
    }
  }

  /** Before PusherTable.step: sets each kinematic prop moving, then applies the fields. */
  beforeStep(coins: () => readonly PropCoin[]): void {
    for (const live of this.#live) {
      const { prop, body } = live;
      if (!live.present) {
        continue;
      }
      if (prop.moves) {
        const from = prop.poseAt(live.clock);
        const to = prop.poseAt(live.clock + 1);
        if (body) {
          this.#drive(body, from, to);
        }
        if (body && !samePose(from, to)) {
          this.#wakeSwept(from, to, boundingRadius(prop.shape));
        }
      } else if (prop.body === 'dynamic' && body && !body.isSleeping()) {
        const v = body.linvel();
        const reach = (Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) / SCALE) * FIXED_DT;
        this.#wakeAround(this.#pose(live), boundingRadius(prop.shape) + reach);
      }
    }
    if (this.#fields.length > 0) {
      this.#applyFields(coins());
    }
  }

  /**
   * After PusherTable.step: advances every prop's clock, takes the dynamic props that
   * fell below PLAYFIELD.fallY off the table, then reports the coins that entered a prop,
   * taking the consumed ones off the table. Returns the events, falls first, each in
   * ascending prop id order, and the consumed coin ids, ascending.
   */
  afterStep(
    tick: number,
    coins: () => readonly PropCoin[],
  ): { events: PropEvent[]; consumed: number[] } {
    const events: PropEvent[] = [];
    for (const live of this.#live) {
      live.clock += 1;
      const { body, prop } = live;
      if (!live.present || prop.body !== 'dynamic' || !body) {
        continue;
      }
      const pose = this.#pose(live);
      if (pose.translation.y < PLAYFIELD.fallY) {
        events.push({
          kind: 'prop.fall',
          propId: prop.id,
          tick,
          edge: fallEdge(pose.translation.x),
        });
        live.present = false;
        live.lastPose = pose;
        live.inside = [];
        if (live.collider) {
          this.#colliders.delete(live.collider.handle);
        }
        this.#world.removeRigidBody(body);
      }
    }
    if (this.#enters.length === 0) {
      return { events, consumed: [] };
    }
    const all = coins();
    const consumed = new Set<number>();
    for (const live of this.#enters) {
      if (!live.present) {
        continue;
      }
      const pose = this.#pose(live);
      const now = this.#inside(live, all).filter((id) => !consumed.has(id));
      const before = new Set(live.inside);
      const kept: number[] = [];
      for (const id of now) {
        if (before.has(id)) {
          kept.push(id);
          continue;
        }
        const coin = all.find((c) => c.id === id);
        const result = coin ? live.prop.onEnter(coin, live.clock, pose) : null;
        if (result) {
          events.push({
            kind: 'prop.enter',
            coinId: id,
            propId: live.prop.id,
            tick,
            consumed: result.consume,
            tag: result.tag,
          });
        }
        if (result?.consume) {
          consumed.add(id);
        } else {
          kept.push(id);
        }
      }
      live.inside = kept;
    }
    const taken = [...consumed].sort((a, b) => a - b);
    for (const id of taken) {
      this.#table.removeCoin(id);
    }
    if (taken.length > 0) {
      for (const live of this.#enters) {
        live.inside = live.inside.filter((id) => !consumed.has(id));
      }
    }
    return { events, consumed: taken };
  }

  /** Every prop, in ascending id order. */
  states(): PropState[] {
    return this.#live.map((live) => {
      const pose = live.present ? this.#pose(live) : live.lastPose;
      return {
        id: live.prop.id,
        kind: live.prop.kind,
        present: live.present,
        translation: pose.translation,
        rotation: pose.rotation,
        sleeping: live.present && live.body ? live.body.isSleeping() : live.prop.body !== 'dynamic',
      };
    });
  }

  /** Each prop's clock and, for a dynamic one on the table, its quantized pose. */
  snapshot(): PropSnapshot[] {
    return this.#live.map((live) => {
      const { prop, body, clock } = live;
      if (prop.body !== 'dynamic' || !live.present || !body) {
        return { id: prop.id, clock };
      }
      const pose = this.#pose(live);
      return {
        id: prop.id,
        clock,
        pose: {
          p: quantizePosition(pose.translation),
          q: quantizeRotation(pose.rotation),
          rest: body.isSleeping() ? 'asleep' : 'awake',
        },
      };
    });
  }

  /** Feeds each prop's kind, clock, body state and the coins in it into `h`. */
  hashInto(h: StateHasher): StateHasher {
    h.int(this.#live.length);
    for (const live of this.#live) {
      const { prop, body } = live;
      h.uint32(prop.id).int(prop.kind.length);
      for (let i = 0; i < prop.kind.length; i++) {
        h.uint32(prop.kind.charCodeAt(i));
      }
      h.int(live.clock).bool(live.present);
      if (body && live.present) {
        h.vec3(body.translation())
          .quat(body.rotation())
          .vec3(body.linvel())
          .vec3(body.angvel())
          .bool(body.isSleeping());
      }
      h.int(live.inside.length);
      for (const id of live.inside) {
        h.uint32(id);
      }
    }
    return h;
  }

  #pose(live: LiveProp): PropPose {
    const { body, prop } = live;
    if (prop.body === 'dynamic' && body) {
      const t = body.translation();
      return {
        translation: { x: t.x / SCALE, y: t.y / SCALE, z: t.z / SCALE },
        rotation: body.rotation(),
      };
    }
    return prop.poseAt(live.clock);
  }

  #build(prop: BoundProp, pose: PropPose, asleep: boolean): [RigidBody | null, Collider | null] {
    if (prop.body === 'ghost') {
      return [null, null];
    }
    const { RigidBodyDesc, CoefficientCombineRule } = this.#rapier;
    const desc =
      prop.body === 'fixed'
        ? RigidBodyDesc.fixed()
        : prop.body === 'kinematic'
          ? RigidBodyDesc.kinematicVelocityBased()
          : RigidBodyDesc.dynamic()
              .setLinearDamping(prop.damping?.linear ?? 0)
              .setAngularDamping(prop.damping?.angular ?? 0)
              .setCanSleep(true)
              .setCcdEnabled(true)
              .setSleeping(asleep);
    const t = scaled(pose.translation);
    const body = this.#world.createRigidBody(
      desc.setTranslation(t.x, t.y, t.z).setRotation(pose.rotation),
    );
    const material = prop.material;
    let collider = this.#shapeDesc(prop.shape);
    if (material) {
      collider = collider
        .setFriction(material.friction)
        .setRestitution(material.restitution)
        .setRestitutionCombineRule(
          material.restitutionCombine === 'max'
            ? CoefficientCombineRule.Max
            : CoefficientCombineRule.Min,
        );
    }
    if (prop.body === 'dynamic') {
      collider = collider.setMass(prop.mass);
    }
    return [body, this.#world.createCollider(collider, body)];
  }

  #shapeDesc(shape: PropShape): ColliderDesc {
    const { ColliderDesc } = this.#rapier;
    switch (shape.kind) {
      case 'box':
        return ColliderDesc.cuboid(
          shape.halfExtents.x * SCALE,
          shape.halfExtents.y * SCALE,
          shape.halfExtents.z * SCALE,
        );
      case 'cylinder':
        return ColliderDesc.cylinder(shape.halfHeight * SCALE, shape.radius * SCALE);
      case 'ball':
        return ColliderDesc.ball(shape.radius * SCALE);
      case 'capsule':
        return ColliderDesc.capsule(shape.halfHeight * SCALE, shape.radius * SCALE);
    }
  }

  /**
   * Places a kinematic body at `from` and sets the velocities that carry it to `to` over
   * the tick. Placing it every tick keeps the path exact: the small-angle turn rate
   * would otherwise drift.
   */
  #drive(body: RigidBody, from: PropPose, to: PropPose): void {
    const a = scaled(from.translation);
    const b = scaled(to.translation);
    body.setTranslation(a, false);
    body.setRotation(from.rotation, false);
    body.setLinvel(
      { x: (b.x - a.x) / FIXED_DT, y: (b.y - a.y) / FIXED_DT, z: (b.z - a.z) / FIXED_DT },
      true,
    );
    const turn = multiply(to.rotation, conjugate(from.rotation));
    const sign = turn.w < 0 ? -2 : 2;
    body.setAngvel(
      {
        x: (sign * turn.x) / FIXED_DT,
        y: (sign * turn.y) / FIXED_DT,
        z: (sign * turn.z) / FIXED_DT,
      },
      true,
    );
  }

  #wakeAround(pose: PropPose, radius: number): void {
    const r = radius + COIN.radius;
    const { x, y, z } = pose.translation;
    this.#table.wakeRegion({ x: x - r, y: y - r, z: z - r }, { x: x + r, y: y + r, z: z + r });
  }

  #wakeSwept(from: PropPose, to: PropPose, radius: number): void {
    const r = radius + COIN.radius;
    const a = from.translation;
    const b = to.translation;
    this.#table.wakeRegion(
      { x: Math.min(a.x, b.x) - r, y: Math.min(a.y, b.y) - r, z: Math.min(a.z, b.z) - r },
      { x: Math.max(a.x, b.x) + r, y: Math.max(a.y, b.y) + r, z: Math.max(a.z, b.z) + r },
    );
  }

  /** The ids of the coins in `live`'s prop now, ascending. */
  #inside(live: LiveProp, coins: readonly PropCoin[]): number[] {
    const margin = live.prop.enterMargin;
    if (margin === null || !live.present) {
      return [];
    }
    const pose = this.#pose(live);
    const reach = boundingRadius(live.prop.shape) + margin;
    const c = pose.translation;
    const ids: number[] = [];
    for (const coin of coins) {
      const t = coin.translation;
      if (
        Math.abs(t.x - c.x) > reach ||
        Math.abs(t.y - c.y) > reach ||
        Math.abs(t.z - c.z) > reach
      ) {
        continue;
      }
      if (distanceAt(live.prop.shape, c, pose.rotation, t) <= margin) {
        ids.push(coin.id);
      }
    }
    return ids;
  }

  #applyFields(coins: readonly PropCoin[]): void {
    const kicks = new Map<number, { coin: PropCoin; x: number; y: number; z: number }>();
    for (const live of this.#fields) {
      if (!live.present) {
        continue;
      }
      const reach = live.prop.fieldReach ?? 0;
      const pose = this.#pose(live);
      const c = pose.translation;
      for (const coin of coins) {
        const t = coin.translation;
        if (
          Math.abs(t.x - c.x) > reach ||
          Math.abs(t.y - c.y) > reach ||
          Math.abs(t.z - c.z) > reach
        ) {
          continue;
        }
        const dv = live.prop.kick(coin, live.clock, pose);
        if (!dv) {
          continue;
        }
        const kick = kicks.get(coin.id) ?? { coin, x: 0, y: 0, z: 0 };
        kick.x += dv.x;
        kick.y += dv.y;
        kick.z += dv.z;
        kicks.set(coin.id, kick);
      }
    }
    const ids = [...kicks.keys()].sort((a, b) => a - b);
    for (const id of ids) {
      const kick = kicks.get(id);
      if (!kick) {
        continue;
      }
      const t = kick.coin.translation;
      if (kick.coin.sleeping) {
        this.#table.wakeRegion(
          { x: t.x - POINT_WAKE, y: t.y - POINT_WAKE, z: t.z - POINT_WAKE },
          { x: t.x + POINT_WAKE, y: t.y + POINT_WAKE, z: t.z + POINT_WAKE },
        );
      }
      const body = this.#coinBody(t);
      if (!body?.isDynamic()) {
        continue;
      }
      const v = body.linvel();
      body.setLinvel(
        { x: v.x + kick.x * SCALE, y: v.y + kick.y * SCALE, z: v.z + kick.z * SCALE },
        true,
      );
    }
  }

  /** The coin body whose centre is nearest `centre`, among the colliders holding it. */
  #coinBody(centre: Readonly<Vec3>): RigidBody | null {
    const point = scaled(centre);
    let best: RigidBody | null = null;
    let bestDistance = Infinity;
    this.#world.intersectionsWithPoint(point, (collider) => {
      const body = collider.parent();
      if (!body || this.#colliders.has(collider.handle) || !isCoinCollider(collider)) {
        return true;
      }
      const b = body.translation();
      const dx = b.x - point.x;
      const dy = b.y - point.y;
      const dz = b.z - point.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestDistance) {
        bestDistance = d;
        best = body;
      }
      return true;
    });
    return best;
  }
}

/** World units within which a collider's dimensions match a coin's. */
const SHAPE_MATCH = 1e-6;
const COIN_CORE = {
  halfHeight: (COIN.halfThickness - COIN_MATERIAL.rimRadius) * SCALE,
  radius: (COIN.radius - COIN_MATERIAL.rimRadius) * SCALE,
  rim: COIN_MATERIAL.rimRadius * SCALE,
};

/** Whether `collider` has the coin's round-cylinder dimensions (PusherTable.addCoin). */
function isCoinCollider(collider: Collider): boolean {
  return (
    Math.abs(collider.roundRadius() - COIN_CORE.rim) < SHAPE_MATCH &&
    Math.abs(collider.radius() - COIN_CORE.radius) < SHAPE_MATCH &&
    Math.abs(collider.halfHeight() - COIN_CORE.halfHeight) < SHAPE_MATCH
  );
}

function samePose(a: PropPose, b: PropPose): boolean {
  const s = a.translation;
  const t = b.translation;
  const q = a.rotation;
  const r = b.rotation;
  return (
    s.x === t.x &&
    s.y === t.y &&
    s.z === t.z &&
    q.x === r.x &&
    q.y === r.y &&
    q.z === r.z &&
    q.w === r.w
  );
}

/** Most a restored prop's clock may read: about a year of ticks. */
const MAX_PROP_CLOCK = 60 * 60 * 24 * 366 * 60;

function wellFormed(pose: PropSnapshot['pose'] & object): boolean {
  const p: unknown = pose.p;
  const q: unknown = pose.q;
  if (!Array.isArray(p) || !Array.isArray(q) || p.length !== 3 || q.length !== 4) {
    return false;
  }
  const ints = (values: unknown[], limit: number) =>
    values.every((v) => typeof v === 'number' && Number.isInteger(v) && Math.abs(v) <= limit);
  return ints(p, Number.MAX_SAFE_INTEGER) && ints(q, ROTATION_UNIT) && pose.q.some((v) => v !== 0);
}

/** Checks `restore` against `props` before anything is built: any mismatch throws. */
function restoredProps(
  props: readonly BoundProp[],
  restore: readonly PropSnapshot[],
): Map<number, PropSnapshot> {
  const raw: unknown = restore;
  if (!Array.isArray(raw)) {
    throw new TypeError('Sim: restore.props must be an array of PropSnapshot');
  }
  const byId = new Map<number, PropSnapshot>();
  restore.forEach((entry, i) => {
    const what = `restore.props[${i}]`;
    const prop = props.find((p) => p.id === entry.id);
    if (!prop) {
      throw new RangeError(`Sim: ${what}.id ${entry.id} is not a prop in options.props`);
    }
    if (byId.has(entry.id)) {
      throw new RangeError(`Sim: ${what} repeats prop ${entry.id}`);
    }
    if (!Number.isInteger(entry.clock) || entry.clock < 0 || entry.clock > MAX_PROP_CLOCK) {
      throw new RangeError(
        `Sim: ${what}.clock must be an integer in [0, ${MAX_PROP_CLOCK}], got ${entry.clock}`,
      );
    }
    if (entry.pose !== undefined) {
      if (prop.body !== 'dynamic') {
        throw new RangeError(
          `Sim: ${what} has a pose, but prop ${entry.id} is ${prop.body}; only a dynamic prop keeps one`,
        );
      }
      const rest: unknown = entry.pose.rest;
      if (!wellFormed(entry.pose) || (rest !== 'awake' && rest !== 'asleep')) {
        throw new RangeError(
          `Sim: ${what}.pose must hold integer p and q, q of non-zero length within ±${ROTATION_UNIT}, and rest awake or asleep`,
        );
      }
      const t = dequantizePosition(entry.pose.p);
      const inTable =
        Math.abs(t.x) <= TABLE_INNER_HALF_WIDTH &&
        t.y >= PLAYFIELD.fallY &&
        t.y <= PLAYFIELD.wallHeight &&
        t.z >= BACKBOARD.frontZ &&
        t.z <= PLAYFIELD.fieldFrontZ;
      if (!inTable) {
        throw new RangeError(
          `Sim: ${what}.pose must lie in the cabinet, got (${t.x}, ${t.y}, ${t.z})`,
        );
      }
    }
    byId.set(entry.id, entry);
  });
  if (byId.size !== props.length) {
    const missing = props.filter((p) => !byId.has(p.id)).map((p) => p.id);
    throw new RangeError(
      `Sim: restore.props must hold every prop in options.props; missing ${missing.join(', ')}`,
    );
  }
  return byId;
}
