import type {
  RigidBody,
  Rotation,
  Shape,
  ShapeContact,
  Vector,
} from '@dimforge/rapier3d-deterministic-compat';
import type { Rapier } from '../rapier.ts';

/** A coin collider's dimensions, in world units: a cylinder core swept by a sphere of radius `rim`. */
export interface CoinGeometry {
  readonly coreHalfHeight: number;
  readonly coreRadius: number;
  readonly rim: number;
}

/** An axis-aligned box the coins must stay out of: a cabinet slab or the pusher block. */
export interface Obstacle {
  readonly shape: Shape;
  readonly half: Readonly<Vector>;
  /** The box centre now. Read once per call, so a moving block is followed. */
  centre(): Readonly<Vector>;
}

export interface SeparationSettings {
  /** Depth in world units a pair may keep; anything deeper is pushed back to half of it. */
  readonly slop: number;
  /** Most Gauss-Seidel passes per call, so a push that drives a coin into a third is caught. */
  readonly passes: number;
}

/** A coin's face normal, a unit vector along its axis. */
interface Axis {
  readonly ax: number;
  readonly ay: number;
  readonly az: number;
}

/** One coin's working state during a call. */
interface Slot extends Axis {
  readonly index: number;
  readonly body: RigidBody;
  readonly rotation: Rotation;
  x: number;
  y: number;
  z: number;
  /** Half the coin's extent along each world axis. */
  readonly ex: number;
  readonly ey: number;
  readonly ez: number;
  /** The normal of the slab the coin is held against, zero while it is free. */
  hx: number;
  hy: number;
  hz: number;
  /** The last pass that moved the coin, or -1. */
  movedIn: number;
  /** Where the coin was when the candidate pairs were last found. */
  sweptX: number;
  sweptY: number;
  sweptZ: number;
}

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 } as const;
/** Local search over directions: first and last step, in radians near enough. */
const SEARCH_FIRST_STEP = 0.2;
const SEARCH_LAST_STEP = 0.01;
const NUDGES = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

function entry<T>(items: readonly T[], i: number): T {
  const item = items[i];
  if (item === undefined) {
    throw new Error(`CoinSeparator: no coin at index ${i} of ${items.length}`);
  }
  return item;
}

/**
 * Removes the interpenetration Rapier's solver leaves between coins, after it has
 * stepped: the position half of a position-based contact solver. Every pair deeper
 * than `slop` is moved apart along Rapier's exact contact normal, the depth split
 * evenly between the two coins (they have the same mass). A coin pressed into a
 * fixed slab or the pusher is held there: it can still give way along the slab, but
 * not into it, so its partner takes the rest. Without that a coin squeezed between
 * the floor and a stack is pushed down and back up pass after pass and never clears.
 * Velocities are not touched, so momentum is unchanged and Rapier's own contacts keep
 * doing the dynamics.
 *
 * Most touching pairs are cleared without asking Rapier: the overlap of two convex
 * bodies along any direction bounds their penetration depth from above, so a pair
 * whose overlap along a world axis, a face normal or the line between them is within
 * `slop` cannot be too deep. Only the rest pay for an exact contact query. After the
 * first pass only coins that moved in the pass before are looked at again.
 */
export class CoinSeparator {
  readonly #shape: Shape;
  readonly #geometry: CoinGeometry;
  readonly #obstacles: readonly Obstacle[];
  readonly #settings: SeparationSettings;
  readonly #contact: ShapeContact;
  /** Squared distance between centres beyond which two coins cannot touch. */
  readonly #touchSq: number;
  /** Distance between centres within which two coins are candidates: touch plus the margin. */
  readonly #reach: number;
  readonly #reachSq: number;
  /** A coin may move this far, squared, before the candidate pairs are found again. */
  readonly #driftSq: number;
  /** Coin indices sorted along x, kept between calls. */
  #order: number[] = [];
  #boundX = 0;
  #boundY = 0;
  #boundZ = 0;

  constructor(
    rapier: Rapier,
    shape: Shape,
    geometry: CoinGeometry,
    obstacles: readonly Obstacle[],
    settings: SeparationSettings,
  ) {
    this.#shape = shape;
    this.#geometry = geometry;
    this.#obstacles = obstacles;
    this.#settings = settings;
    // fromBuffer writes into these, so each must be its own object.
    const zero = (): Vector => ({ x: 0, y: 0, z: 0 });
    this.#contact = new rapier.ShapeContact(0, zero(), zero(), zero(), zero());
    const { coreHalfHeight, coreRadius, rim } = geometry;
    const bound = Math.sqrt(coreHalfHeight * coreHalfHeight + coreRadius * coreRadius) + rim;
    const margin = 2 * rim;
    this.#touchSq = 4 * bound * bound;
    this.#reach = 2 * bound + margin;
    this.#reachSq = this.#reach * this.#reach;
    this.#driftSq = (margin / 2) * (margin / 2);
  }

  /** Separates `bodies`, given in a fixed order. Returns how many coins it moved. */
  separate(bodies: readonly RigidBody[]): number {
    const coins = bodies.map((body, index): Slot => {
      const t = body.translation();
      const q = body.rotation();
      const ax = 2 * (q.x * q.y - q.w * q.z);
      const ay = 1 - 2 * (q.x * q.x + q.z * q.z);
      const az = 2 * (q.y * q.z + q.w * q.x);
      return {
        index,
        body,
        rotation: q,
        x: t.x,
        y: t.y,
        z: t.z,
        ax,
        ay,
        az,
        ex: this.#halfExtent(ax),
        ey: this.#halfExtent(ay),
        ez: this.#halfExtent(az),
        hx: 0,
        hy: 0,
        hz: 0,
        movedIn: -1,
        sweptX: t.x,
        sweptY: t.y,
        sweptZ: t.z,
      };
    });
    const { slop, passes } = this.#settings;
    const contact = this.#contact;
    const shape = this.#shape;
    const posA = { x: 0, y: 0, z: 0 };
    const posB = { x: 0, y: 0, z: 0 };
    const obstacles = this.#obstacles.map((obstacle) => ({ obstacle, centre: obstacle.centre() }));
    let pass = 0;
    /** Moves `c` by `amount` along unit (x, y, z), less any part into its slab. Returns how far it went along (x, y, z). */
    const shift = (c: Slot, x: number, y: number, z: number, amount: number): number => {
      let sx = x * amount;
      let sy = y * amount;
      let sz = z * amount;
      const into = sx * c.hx + sy * c.hy + sz * c.hz;
      if (into < 0) {
        sx -= into * c.hx;
        sy -= into * c.hy;
        sz -= into * c.hz;
      }
      c.x += sx;
      c.y += sy;
      c.z += sz;
      c.movedIn = pass;
      return sx * x + sy * y + sz * z;
    };

    let pairs = this.#candidatePairs(coins);
    /** Pairs and obstacles are looked at again only for coins whose `movedIn` is at least this. */
    let since = -2;
    let sweptAfter = 0;
    for (; pass < passes; pass++) {
      let pushed = false;
      for (const [a, b] of pairs) {
        if (a.movedIn < since && b.movedIn < since) {
          continue;
        }
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dz = b.z - a.z;
        if (
          dx * dx + dy * dy + dz * dz > this.#touchSq ||
          a.ex + b.ex - Math.abs(dx) <= slop ||
          a.ey + b.ey - Math.abs(dy) <= slop ||
          a.ez + b.ez - Math.abs(dz) <= slop
        ) {
          continue;
        }
        const bound = this.#pairBound(slop, dx, dy, dz, a, b);
        if (bound <= slop) {
          continue;
        }
        posA.x = a.x;
        posA.y = a.y;
        posA.z = a.z;
        posB.x = b.x;
        posB.y = b.y;
        posB.z = b.z;
        const hit = shape.contactShape(posA, a.rotation, shape, posB, b.rotation, 0, contact);
        if (!hit) {
          continue;
        }
        let depth = -hit.distance;
        let { x, y, z } = hit.normal1;
        if (Math.abs(this.#overlap(dx, dy, dz, a, b, x, y, z) - depth) > slop / 2) {
          // The true depth is the overlap along its own normal. Rapier misses that for
          // some near-parallel pairs: two flat coins side by side, one a hair lower,
          // 0.3 mm into each other come back 1.6 mm deep along their axis. The bound's
          // direction is then the better way apart.
          const sign = dx * this.#boundX + dy * this.#boundY + dz * this.#boundZ < 0 ? -1 : 1;
          depth = bound;
          x = sign * this.#boundX;
          y = sign * this.#boundY;
          z = sign * this.#boundZ;
        }
        if (depth <= slop) {
          continue;
        }
        depth -= slop / 2;
        const heldA = a.hx !== 0 || a.hy !== 0 || a.hz !== 0;
        const heldB = b.hx !== 0 || b.hy !== 0 || b.hz !== 0;
        if (heldA && !heldB) {
          shift(b, x, y, z, depth - shift(a, -x, -y, -z, depth / 2));
        } else if (heldB && !heldA) {
          shift(a, -x, -y, -z, depth - shift(b, x, y, z, depth / 2));
        } else {
          shift(a, -x, -y, -z, depth / 2);
          shift(b, x, y, z, depth / 2);
        }
        pushed = true;
      }
      for (const { obstacle, centre } of obstacles) {
        const h = obstacle.half;
        for (const coin of coins) {
          if (coin.movedIn < since) {
            continue;
          }
          const dx = coin.x - centre.x;
          const dy = coin.y - centre.y;
          const dz = coin.z - centre.z;
          if (
            h.x + coin.ex - Math.abs(dx) <= slop ||
            h.y + coin.ey - Math.abs(dy) <= slop ||
            h.z + coin.ez - Math.abs(dz) <= slop
          ) {
            continue;
          }
          posA.x = coin.x;
          posA.y = coin.y;
          posA.z = coin.z;
          const hit = obstacle.shape.contactShape(
            centre,
            IDENTITY,
            shape,
            posA,
            coin.rotation,
            0,
            contact,
          );
          if (!hit || hit.distance >= -slop) {
            continue;
          }
          const depth = -hit.distance - slop / 2;
          const { x, y, z } = hit.normal1;
          coin.x += x * depth;
          coin.y += y * depth;
          coin.z += z * depth;
          coin.hx = x;
          coin.hy = y;
          coin.hz = z;
          coin.movedIn = pass;
          pushed = true;
        }
      }
      if (!pushed) {
        break;
      }
      since = pass;
      if (this.#drifted(coins)) {
        // A pair new to the sweep has a coin that moved since the last one: two coins
        // that both stayed put were within reach of each other then too.
        since = sweptAfter;
        sweptAfter = pass + 1;
        pairs = this.#candidatePairs(coins);
      }
    }
    let count = 0;
    for (const coin of coins) {
      if (coin.movedIn >= 0) {
        coin.body.setTranslation({ x: coin.x, y: coin.y, z: coin.z }, true);
        count += 1;
      }
    }
    return count;
  }

  /**
   * Pairs of coins whose centres are within the reach, by a sweep along x; each coin
   * is marked as swept where it stands. The order depends only on the positions and
   * the input order, so it is the same on every replay.
   */
  #candidatePairs(coins: readonly Slot[]): (readonly [Slot, Slot])[] {
    const n = coins.length;
    const sorted =
      this.#order.length === n ? this.#order.map((i) => entry(coins, i)) : coins.slice();
    // Insertion sort: the coins barely move between calls, so the last order is
    // nearly sorted already. Ties go by index, so the result is the same whatever
    // order it starts from.
    for (let s = 1; s < n; s++) {
      const coin = entry(sorted, s);
      let u = s - 1;
      for (; u >= 0; u--) {
        const before = entry(sorted, u);
        if (before.x < coin.x || (before.x === coin.x && before.index < coin.index)) {
          break;
        }
        sorted[u + 1] = before;
      }
      sorted[u + 1] = coin;
    }
    this.#order = sorted.map((coin) => coin.index);
    const pairs: (readonly [Slot, Slot])[] = [];
    const reach = this.#reach;
    const reachSq = this.#reachSq;
    for (let s = 0; s < n; s++) {
      const a = entry(sorted, s);
      a.sweptX = a.x;
      a.sweptY = a.y;
      a.sweptZ = a.z;
      for (let u = s + 1; u < n; u++) {
        const b = entry(sorted, u);
        const dx = b.x - a.x;
        if (dx > reach) {
          break;
        }
        const dy = b.y - a.y;
        const dz = b.z - a.z;
        if (dx * dx + dy * dy + dz * dz <= reachSq) {
          pairs.push([a, b]);
        }
      }
    }
    return pairs;
  }

  /**
   * Whether some coin has moved far enough since the candidate pairs were found that
   * it may now touch a coin that was out of reach then.
   */
  #drifted(coins: readonly Slot[]): boolean {
    return coins.some((coin) => {
      const dx = coin.x - coin.sweptX;
      const dy = coin.y - coin.sweptY;
      const dz = coin.z - coin.sweptZ;
      return dx * dx + dy * dy + dz * dz > this.#driftSq;
    });
  }

  /** Half the coin's width along a unit direction whose cosine with its face normal is `cos`. */
  #halfExtent(cos: number): number {
    const { coreHalfHeight, coreRadius, rim } = this.#geometry;
    const c = Math.min(1, Math.abs(cos));
    return coreHalfHeight * c + coreRadius * Math.sqrt(1 - c * c) + rim;
  }

  /** How far two coins, `d` apart with face normals `a` and `b`, overlap along the unit direction (x, y, z). */
  #overlap(
    dx: number,
    dy: number,
    dz: number,
    a: Axis,
    b: Axis,
    x: number,
    y: number,
    z: number,
  ): number {
    return (
      this.#halfExtent(a.ax * x + a.ay * y + a.az * z) +
      this.#halfExtent(b.ax * x + b.ay * y + b.az * z) -
      Math.abs(dx * x + dy * y + dz * z)
    );
  }

  /**
   * An upper bound on two coins' penetration depth: their least overlap over the face
   * normals and the line between them, then improved by a local search around the
   * best of those, stopping as soon as it is within `limit`. The direction it was
   * found along is left in #boundX, #boundY and #boundZ.
   */
  #pairBound(limit: number, dx: number, dy: number, dz: number, a: Axis, b: Axis): number {
    const overlap = (x: number, y: number, z: number): number =>
      this.#overlap(dx, dy, dz, a, b, x, y, z);
    let best = overlap(a.ax, a.ay, a.az);
    let nx = a.ax;
    let ny = a.ay;
    let nz = a.az;
    const alongB = overlap(b.ax, b.ay, b.az);
    if (alongB < best) {
      best = alongB;
      nx = b.ax;
      ny = b.ay;
      nz = b.az;
    }
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (best > limit && length > 0) {
      const c = overlap(dx / length, dy / length, dz / length);
      if (c < best) {
        best = c;
        nx = dx / length;
        ny = dy / length;
        nz = dz / length;
      }
    }
    let step = SEARCH_FIRST_STEP;
    while (best > limit && step >= SEARCH_LAST_STEP) {
      // Two unit tangents to n: u from crossing with whichever world axis is least aligned with it.
      let ux: number;
      let uy: number;
      let uz: number;
      if (Math.abs(nx) < 0.5) {
        ux = 0;
        uy = nz;
        uz = -ny;
      } else {
        ux = -nz;
        uy = 0;
        uz = nx;
      }
      const u = Math.sqrt(ux * ux + uy * uy + uz * uz);
      ux /= u;
      uy /= u;
      uz /= u;
      const vx = ny * uz - nz * uy;
      const vy = nz * ux - nx * uz;
      const vz = nx * uy - ny * ux;
      let improved = false;
      for (const [p, q] of NUDGES) {
        const mx = nx + step * (p * ux + q * vx);
        const my = ny + step * (p * uy + q * vy);
        const mz = nz + step * (p * uz + q * vz);
        const m = Math.sqrt(mx * mx + my * my + mz * mz);
        const o = overlap(mx / m, my / m, mz / m);
        if (o < best) {
          best = o;
          nx = mx / m;
          ny = my / m;
          nz = mz / m;
          improved = true;
          break;
        }
      }
      if (!improved) {
        step /= 2;
      }
    }
    this.#boundX = nx;
    this.#boundY = ny;
    this.#boundZ = nz;
    return best;
  }
}
