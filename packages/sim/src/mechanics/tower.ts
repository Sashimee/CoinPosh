import type { Collider, RigidBody, World } from '@dimforge/rapier3d-deterministic-compat';
import { COIN } from '../coin.ts';
import { FIXED_DT, TICK_RATE_HZ } from '../constants.ts';
import type { StateHasher } from '../hash.ts';
import type { Rapier } from '../rapier.ts';
import { BACKBOARD, PLAYFIELD, PUSHER } from '../table/layout.ts';
import type { TableCoin } from '../table/table.ts';
import { COIN_MATERIAL, TABLE_MATERIAL, TABLE_SOLVER } from '../table/tuning.ts';
import type { MechanicTable } from './table.ts';
import { FUSION_TUNING, TOWER_TUNING, type TowerPlacement } from './tuning.ts';

const SCALE = TABLE_SOLVER.worldScale;
const T = TOWER_TUNING;
const R = COIN.radius;
/** Height of one coin in the stack: the stack is logical, so it packs without a contact skin. */
const PITCH = 2 * COIN.halfThickness;
/** Thickness of a released coin with its contact skin on both faces, plus a hair. */
const RELEASE_THICKNESS = 2 * (COIN.halfThickness + COIN_MATERIAL.contactSkin) + 0.0001;
const SIDE_REACH = 2 * R + FUSION_TUNING.touchGap;
const PEDESTAL_REACH = T.pedestalRadius + R + FUSION_TUNING.touchGap;
/** Coins this close to the axis, horizontally, are watched: anything nearer could touch the tower. */
const INFLUENCE = PEDESTAL_REACH + R;
const TWO_PI = 6.283185307179586;
const OMEGA_REF = TWO_PI * T.swayHz;
/** Released coins keep this far inside the side walls and off the backboard. */
const RELEASE_HALF_WIDTH = PLAYFIELD.fieldHalfWidth - PUSHER.sideClearance - R - 0.001;
const RELEASE_BACK_Z = BACKBOARD.frontZ + R + 0.001;

/** A coin in the stack. `offset` is its centre's sideways offset from the pedestal axis. */
export interface StackedCoin {
  readonly id: number;
  /** Opaque to the tower: the caller's tier index, handed back when the coin is released. */
  readonly group: number;
  readonly offset: Readonly<{ x: number; z: number }>;
}

/** Everything the renderer needs to draw the tower and its tension. Offsets are in metres. */
export interface TowerState {
  readonly axis: Readonly<{ x: number; z: number }>;
  /** y of the pedestal top, where the bottom coin rests. */
  readonly pedestalTop: number;
  /** Bottom to top. Coin k's centre is at pedestalTop + (k + 0.5) × stackPitch. */
  readonly coins: readonly StackedCoin[];
  readonly stackPitch: number;
  /** Sideways sway of the top of the stack; coin k sways by sway × (k + 0.5) / coins.length. */
  readonly sway: Readonly<{ x: number; z: number }>;
  /** Permanent lean of the top from slipping, applied like the sway. */
  readonly lean: Readonly<{ x: number; z: number }>;
  /** How close the stack is to toppling: 0 steady, 1 toppling. */
  readonly risk: number;
  /** Ticks until the pedestal stacks coins again after a topple. */
  readonly cooldown: number;
}

export interface TowerCapture {
  readonly coinId: number;
  readonly group: number;
  readonly tick: number;
  /** Coins in the stack, this one included. */
  readonly height: number;
}

export interface TowerTopple {
  readonly tick: number;
  /** The stacked coins, bottom to top. */
  readonly ids: readonly number[];
  /** Their groups, in the same order. */
  readonly groups: readonly number[];
  /** The ids the released coins have on the table, in the same order. */
  readonly released: readonly number[];
  /** Unit vector of the fall, in the xz plane. */
  readonly direction: Readonly<{ x: number; z: number }>;
}

export interface TowerStep {
  readonly captures: readonly TowerCapture[];
  readonly topple: TowerTopple | null;
}

interface Stacked {
  readonly id: number;
  readonly group: number;
  readonly x: number;
  readonly z: number;
}

/** A coin near the tower: where it was last tick, and how it was moving when it fell fastest. */
interface Watched {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly fall: number;
  readonly slideX: number;
  readonly slideZ: number;
}

const NO_CAPTURES: TowerStep = { captures: [], topple: null };

/**
 * The Champagne Tower: a pedestal on the upper tier that stacks the coins landing on
 * it, sways as it is knocked and topples once its centre of mass passes the rim of
 * its bottom coin, releasing the stack onto the table as a cascade. See TOWER_TUNING
 * for the model and its values. Its pedestal and stack colliders live in the table's
 * world, at the table's world scale; it reads coins only through the MechanicTable,
 * in metres.
 */
export class ChampagneTower {
  readonly #rapier: Rapier;
  readonly #world: World;
  readonly #body: RigidBody;
  readonly #axisX: number;
  readonly #axisZ: number;
  readonly #pedestalTop = PUSHER.height + T.pedestalHeight;
  readonly #stack: Stacked[] = [];
  #stackCollider: Collider | null = null;
  #sumX = 0;
  #sumZ = 0;
  #swayX = 0;
  #swayZ = 0;
  #swayVx = 0;
  #swayVz = 0;
  #leanX = 0;
  #leanZ = 0;
  #risk = 0;
  #cooldown = 0;
  /** The watched coins, in ascending id order. */
  #near = new Map<number, Watched>();

  constructor(rapier: Rapier, world: World, placement: TowerPlacement = T.placement) {
    const { x, z } = placement;
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(z) ||
      Math.abs(x) > RELEASE_HALF_WIDTH - T.pedestalRadius + R ||
      z - T.pedestalRadius < BACKBOARD.frontZ + 2 * R ||
      z + T.pedestalRadius > PUSHER.frontZ - 2 * R
    ) {
      throw new RangeError(
        `Tower placement (${x}, ${z}) must leave a coin's width of upper tier all round the pedestal`,
      );
    }
    this.#rapier = rapier;
    this.#world = world;
    this.#axisX = x;
    this.#axisZ = z;
    const { RigidBodyDesc, ColliderDesc, CoefficientCombineRule } = rapier;
    this.#body = world.createRigidBody(RigidBodyDesc.fixed());
    const bottom = PUSHER.height - T.pedestalEmbed;
    const halfHeight = (this.#pedestalTop - bottom) / 2;
    world.createCollider(
      ColliderDesc.cylinder(halfHeight * SCALE, T.pedestalRadius * SCALE)
        .setTranslation(x * SCALE, (bottom + halfHeight) * SCALE, z * SCALE)
        .setFriction(TABLE_MATERIAL.wallFriction)
        .setRestitution(TABLE_MATERIAL.restitution)
        .setRestitutionCombineRule(CoefficientCombineRule.Min),
      this.#body,
    );
  }

  get height(): number {
    return this.#stack.length;
  }

  get state(): TowerState {
    return {
      axis: { x: this.#axisX, z: this.#axisZ },
      pedestalTop: this.#pedestalTop,
      coins: this.#stack.map(({ id, group, x, z }) => ({ id, group, offset: { x, z } })),
      stackPitch: PITCH,
      sway: { x: this.#swayX, z: this.#swayZ },
      lean: { x: this.#leanX, z: this.#leanZ },
      risk: this.#risk,
      cooldown: this.#cooldown,
    };
  }

  /**
   * Advances the tower by one tick after the table has stepped: stacks the coins that
   * came to rest on it (taking them off `table`), applies the knocks of coins landing
   * on or running into it, integrates the sway and topples the tower if it has passed
   * its tipping point. `coins` is the table's coins this tick, in ascending id order;
   * `groupOf` gives the group a stacked coin keeps.
   */
  step(
    tick: number,
    coins: readonly TableCoin[],
    groupOf: (id: number) => number,
    table: MechanicTable,
  ): TowerStep {
    const near = new Map<number, Watched>();
    const captures: TowerCapture[] = [];
    let stackTop = this.#pedestalTop + this.#stack.length * PITCH;
    let kickX = 0;
    let kickZ = 0;
    let overfull = false;

    for (const coin of coins) {
      const p = coin.translation;
      const dx = p.x - this.#axisX;
      const dz = p.z - this.#axisZ;
      const distSq = dx * dx + dz * dz;
      if (distSq > INFLUENCE * INFLUENCE) {
        continue;
      }
      const prev = this.#near.get(coin.id);
      const vx = prev ? (p.x - prev.x) * TICK_RATE_HZ : 0;
      const vy = prev ? (p.y - prev.y) * TICK_RATE_HZ : 0;
      const vz = prev ? (p.z - prev.z) * TICK_RATE_HZ : 0;
      const watched =
        prev && prev.fall >= -vy
          ? { x: p.x, y: p.y, z: p.z, fall: prev.fall, slideX: prev.slideX, slideZ: prev.slideZ }
          : { x: p.x, y: p.y, z: p.z, fall: Math.max(0, -vy), slideX: vx, slideZ: vz };

      if (this.#cooldown === 0 && this.#restsOnTop(coin, dx, dz, stackTop)) {
        const top = this.#top();
        const ox = dx - top.x;
        const oz = dz - top.z;
        const com = this.#centreOfMassFromBase();
        const thud = T.landThudGain * watched.fall;
        kickX += T.landSlideGain * watched.slideX + (thud * (ox + com.x)) / R;
        kickZ += T.landSlideGain * watched.slideZ + (thud * (oz + com.z)) / R;
        const residual = 1 - T.alignment;
        const placed = {
          id: coin.id,
          group: groupOf(coin.id),
          x: top.x + residual * ox,
          z: top.z + residual * oz,
        };
        table.removeCoin(coin.id);
        this.#stack.push(placed);
        this.#sumX += placed.x;
        this.#sumZ += placed.z;
        stackTop += PITCH;
        captures.push({
          coinId: coin.id,
          group: placed.group,
          tick,
          height: this.#stack.length,
        });
        overfull ||= this.#stack.length > T.maxCoins;
        continue;
      }

      near.set(coin.id, watched);
      const dist = Math.sqrt(distSq);
      if (dist === 0 || this.#stack.length === 0) {
        continue;
      }
      const inward = -(vx * dx + vz * dz) / dist;
      if (inward <= 0) {
        continue;
      }
      const stackHeight = this.#stack.length * PITCH;
      let gain = 0;
      if (dist <= SIDE_REACH && p.y >= this.#pedestalTop && p.y <= stackTop + COIN.halfThickness) {
        gain = (T.sideGain * (p.y - this.#pedestalTop)) / stackHeight;
      } else if (dist <= PEDESTAL_REACH && p.y < this.#pedestalTop + COIN.halfThickness) {
        gain = T.pedestalGain;
      }
      kickX -= (gain * inward * dx) / dist;
      kickZ -= (gain * inward * dz) / dist;
    }
    this.#near = near;

    if (this.#cooldown > 0) {
      this.#cooldown -= 1;
    }
    if (captures.length > 0) {
      this.#rebuildStackCollider();
    }
    this.#integrate(kickX, kickZ);
    if (overfull || this.#risk >= 1) {
      return { captures, topple: this.#topple(tick, table) };
    }
    return captures.length > 0 ? { captures, topple: null } : NO_CAPTURES;
  }

  hashInto(h: StateHasher): StateHasher {
    h.int(this.#stack.length);
    for (const { id, group, x, z } of this.#stack) {
      h.int(id).int(group).float(x).float(z);
    }
    h.float(this.#swayX)
      .float(this.#swayZ)
      .float(this.#swayVx)
      .float(this.#swayVz)
      .float(this.#leanX)
      .float(this.#leanZ)
      .int(this.#cooldown)
      .int(this.#near.size);
    for (const [id, w] of this.#near) {
      h.int(id).vec3(w).float(w.fall).float(w.slideX).float(w.slideZ);
    }
    return h;
  }

  #restsOnTop(coin: TableCoin, dx: number, dz: number, stackTop: number): boolean {
    const top = this.#top();
    const ox = dx - top.x;
    const oz = dz - top.z;
    if (ox * ox + oz * oz > R * R) {
      return false;
    }
    const lift = coin.translation.y - COIN.halfThickness - stackTop;
    if (lift < -COIN.halfThickness || lift > T.captureHeight) {
      return false;
    }
    const q = coin.rotation;
    return 1 - 2 * (q.x * q.x + q.z * q.z) >= T.minFaceUp;
  }

  #top(): { x: number; z: number } {
    const top = this.#stack.at(-1);
    return top ? { x: top.x, z: top.z } : { x: 0, z: 0 };
  }

  /** The stack's centre of mass relative to its bottom coin, with the column tilted by lean and sway. */
  #centreOfMassFromBase(): { x: number; z: number } {
    const base = this.#stack[0];
    const n = this.#stack.length;
    if (!base) {
      return { x: 0, z: 0 };
    }
    return {
      x: this.#sumX / n - base.x + (this.#leanX + this.#swayX) / 2,
      z: this.#sumZ / n - base.z + (this.#leanZ + this.#swayZ) / 2,
    };
  }

  /** One semi-implicit Euler step of the sway, then slip and the toppling risk. */
  #integrate(kickX: number, kickZ: number): void {
    const n = this.#stack.length;
    if (n === 0) {
      this.#swayX = this.#swayZ = this.#swayVx = this.#swayVz = 0;
      this.#leanX = this.#leanZ = 0;
      this.#risk = 0;
      return;
    }
    const omega = OMEGA_REF * Math.sqrt(T.refCoins / Math.max(n, T.refCoins));
    const stiffness = omega * omega;
    const drag = 2 * T.damping * omega;
    this.#swayVx += kickX - (stiffness * this.#swayX + drag * this.#swayVx) * FIXED_DT;
    this.#swayVz += kickZ - (stiffness * this.#swayZ + drag * this.#swayVz) * FIXED_DT;
    this.#swayX += this.#swayVx * FIXED_DT;
    this.#swayZ += this.#swayVz * FIXED_DT;
    const sway = Math.sqrt(this.#swayX * this.#swayX + this.#swayZ * this.#swayZ);
    if (sway > T.slipSway) {
      const slip = (T.creep * (sway - T.slipSway)) / sway;
      this.#leanX += this.#swayX * slip;
      this.#leanZ += this.#swayZ * slip;
    }
    if (n < T.minToppleCoins) {
      this.#risk = 0;
      return;
    }
    const com = this.#centreOfMassFromBase();
    this.#risk = Math.sqrt(com.x * com.x + com.z * com.z) / T.supportRadius;
  }

  /**
   * Releases the stack as table coins, laid out as the column leaning toward the fall
   * at TOWER_TUNING.toppleSlope (less if a wall is closer), each coin tilted with it
   * and sheared off the one below so none overlap. They take new ids on the table.
   */
  #topple(tick: number, table: MechanicTable): TowerTopple {
    const n = this.#stack.length;
    const com = this.#centreOfMassFromBase();
    const direction = unit(com.x, com.z) ?? unit(this.#swayX, this.#swayZ) ?? { x: 0, z: 1 };
    const tipX = this.#leanX + this.#swayX;
    const tipZ = this.#leanZ + this.#swayZ;
    const topOffsetX = this.#axisX + (this.#stack.at(-1)?.x ?? 0) + tipX;
    const topOffsetZ = this.#axisZ + (this.#stack.at(-1)?.z ?? 0) + tipZ;
    const room = roomAlong(topOffsetX, topOffsetZ, direction);
    const slopeFor = (pitch: number): number => Math.max(0, room / (n * pitch));
    let slope: number = T.toppleSlope;
    for (let i = 0; i < 2; i++) {
      slope = Math.min(T.toppleSlope, slopeFor(RELEASE_THICKNESS / Math.sqrt(1 + slope * slope)));
    }
    const cos = 1 / Math.sqrt(1 + slope * slope);
    const sin = slope * cos;
    const pitch = RELEASE_THICKNESS * cos;
    const halfCos = Math.sqrt((1 + cos) / 2);
    const halfSin = Math.sqrt((1 - cos) / 2);
    const rotation = { x: direction.z * halfSin, y: 0, z: -direction.x * halfSin, w: halfCos };
    const baseY =
      this.#pedestalTop + R * sin + COIN.halfThickness * cos + COIN_MATERIAL.contactSkin;

    const ids: number[] = [];
    const groups: number[] = [];
    const released: number[] = [];
    this.#stack.forEach((coin, k) => {
      const along = (k + 0.5) / n;
      const shear = k * pitch * slope;
      released.push(
        table.addCoin(
          {
            x: this.#axisX + coin.x + tipX * along + direction.x * shear,
            y: baseY + k * pitch,
            z: this.#axisZ + coin.z + tipZ * along + direction.z * shear,
          },
          rotation,
        ),
      );
      ids.push(coin.id);
      groups.push(coin.group);
    });
    this.#stack.length = 0;
    this.#sumX = this.#sumZ = 0;
    this.#rebuildStackCollider();
    this.#integrate(0, 0);
    this.#cooldown = T.toppleCooldownTicks;
    return { tick, ids, groups, released, direction };
  }

  #rebuildStackCollider(): void {
    if (this.#stackCollider) {
      this.#world.removeCollider(this.#stackCollider, true);
      this.#stackCollider = null;
    }
    const n = this.#stack.length;
    if (n === 0) {
      return;
    }
    const { ColliderDesc, CoefficientCombineRule } = this.#rapier;
    const halfHeight = (n * PITCH) / 2;
    this.#stackCollider = this.#world.createCollider(
      ColliderDesc.cylinder(halfHeight * SCALE, R * SCALE)
        .setTranslation(
          this.#axisX * SCALE,
          (this.#pedestalTop + halfHeight) * SCALE,
          this.#axisZ * SCALE,
        )
        .setFriction(COIN_MATERIAL.friction)
        .setRestitution(COIN_MATERIAL.restitution)
        .setRestitutionCombineRule(CoefficientCombineRule.Min),
      this.#body,
    );
  }
}

function unit(x: number, z: number): { x: number; z: number } | null {
  const length = Math.sqrt(x * x + z * z);
  return length > 1e-9 ? { x: x / length, z: z / length } : null;
}

/** How far a coin centre at (x, z) can move along `direction` before it would meet a side wall or the backboard. */
function roomAlong(x: number, z: number, direction: { x: number; z: number }): number {
  let room = Number.POSITIVE_INFINITY;
  if (direction.x > 0) {
    room = Math.min(room, (RELEASE_HALF_WIDTH - x) / direction.x);
  } else if (direction.x < 0) {
    room = Math.min(room, (-RELEASE_HALF_WIDTH - x) / direction.x);
  }
  if (direction.z < 0) {
    room = Math.min(room, (RELEASE_BACK_Z - z) / direction.z);
  }
  return room;
}
