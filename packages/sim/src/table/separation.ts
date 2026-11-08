import type { RigidBody, Rotation, Shape, Vector } from '@dimforge/rapier3d-deterministic-compat';
import type { Rapier } from '../rapier.ts';

type RawShape = ReturnType<Shape['intoRaw']>;
type RawVector = ReturnType<Rapier['VectorOps']['intoRaw']>;
type RawRotation = ReturnType<Rapier['RotationOps']['intoRaw']>;

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

/** One coin's working state during a call, kept between calls so nothing is allocated per tick. */
interface Slot extends Axis {
  readonly index: number;
  body: RigidBody;
  /** A frozen coin that has not been moved yet. */
  fixed: boolean;
  rotation: Rotation;
  /** The rotation in WASM memory, made the first time a call queries the coin and freed when it returns. */
  rawRotation: RawRotation | undefined;
  x: number;
  y: number;
  z: number;
  ax: number;
  ay: number;
  az: number;
  /** Half the coin's extent along each world axis. */
  ex: number;
  ey: number;
  ez: number;
  /** The normal of the slab the coin is held against, zero while it is free. */
  hx: number;
  hy: number;
  hz: number;
  /** The last pass that moved the coin; ASLEEP or AWAKE before it has moved. */
  movedIn: number;
  /** Where the coin was when the candidate pairs were last found. */
  sweptX: number;
  sweptY: number;
  sweptZ: number;
}

export interface SeparationResult {
  /** How many coins were moved. */
  readonly moved: number;
  /** How many passes ran. */
  readonly passes: number;
  /**
   * Whether the last pass found nothing deeper than the slop. False means the passes
   * ran out while some pair or coin and slab may still be too deep.
   */
  readonly converged: boolean;
  /** Frozen coins it moved, in the order it first moved them. */
  readonly loosened: readonly RigidBody[];
}

/**
 * A sleeping coin starts below the first pass's threshold, so a pair of two sleeping
 * coins, or a sleeping coin and a slab, is skipped: neither has moved since it was
 * last separated. A coin pushed by an awake neighbour is looked at from then on.
 */
const ASLEEP = -3;
const AWAKE = -1;
const FIRST_SINCE = -2;

/** Local search over directions: first and last step, in radians near enough. */
const SEARCH_FIRST_STEP = 0.2;
const SEARCH_LAST_STEP = 0.01;
const NUDGES = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

function entry<T>(items: ArrayLike<T>, i: number): T {
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
 * not into it, so its partner takes the rest. A frozen (kinematic) coin is moved like
 * any other and reported in `loosened` for the table to wake. Without that a coin squeezed between
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
  readonly #geometry: CoinGeometry;
  readonly #obstacles: readonly Obstacle[];
  readonly #settings: SeparationSettings;
  /**
   * Contact queries go to the WASM shapes directly: Shape.contactShape copies both
   * shapes, both poses and the result into and out of WASM memory on every call,
   * about a quarter of what a query costs.
   */
  readonly #rapier: Rapier;
  readonly #rawShape: RawShape;
  readonly #rawObstacles: readonly RawShape[];
  readonly #rawIdentity: RawRotation;
  readonly #rawA: RawVector;
  readonly #rawB: RawVector;
  /** distance, point1, point2, normal1, normal2: RawShapeContact.getComponents' layout. */
  readonly #hit = new Float32Array(13);
  /** Squared distance between centres beyond which two coins cannot touch. */
  readonly #touchSq: number;
  /** Distance between centres within which two coins are candidates: touch plus the margin. */
  readonly #reach: number;
  readonly #reachSq: number;
  /** A coin may move this far, squared, before the candidate pairs are found again. */
  readonly #driftSq: number;
  /** One slot per coin, reused from call to call. */
  readonly #slots: Slot[] = [];
  /** Pose reads and writes that nothing keeps past the call making them. */
  readonly #scratch: Vector = { x: 0, y: 0, z: 0 };
  /** Coin indices sorted along x, kept between calls. */
  readonly #order: number[] = [];
  readonly #sorted: Slot[] = [];
  /** Candidate pairs, flattened: pair p is #pairs[2p] and #pairs[2p + 1]. */
  readonly #pairs: Slot[] = [];
  #pairCount = 0;
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
    this.#geometry = geometry;
    this.#obstacles = obstacles;
    this.#settings = settings;
    this.#rapier = rapier;
    this.#rawShape = shape.intoRaw();
    this.#rawObstacles = obstacles.map((obstacle) => obstacle.shape.intoRaw());
    this.#rawIdentity = rapier.RotationOps.intoRaw({ x: 0, y: 0, z: 0, w: 1 });
    this.#rawA = rapier.VectorOps.intoRaw({ x: 0, y: 0, z: 0 });
    this.#rawB = rapier.VectorOps.intoRaw({ x: 0, y: 0, z: 0 });
    const { coreHalfHeight, coreRadius, rim } = geometry;
    const bound = Math.sqrt(coreHalfHeight * coreHalfHeight + coreRadius * coreRadius) + rim;
    const margin = 2 * rim;
    this.#touchSq = 4 * bound * bound;
    this.#reach = 2 * bound + margin;
    this.#reachSq = this.#reach * this.#reach;
    this.#driftSq = (margin / 2) * (margin / 2);
  }

  /**
   * Separates `bodies`, given in a fixed order. Pairs of sleeping coins and sleeping
   * coins against slabs are skipped until an awake neighbour pushes them.
   */
  separate(bodies: Iterable<RigidBody>): SeparationResult {
    const coins = this.#load(bodies);
    try {
      return this.#separate(coins);
    } finally {
      for (const coin of coins) {
        coin.rawRotation?.free();
        coin.rawRotation = undefined;
      }
    }
  }

  #separate(coins: readonly Slot[]): SeparationResult {
    const { slop, passes } = this.#settings;
    const rawShape = this.#rawShape;
    const rawA = this.#rawA;
    const rawB = this.#rawB;
    const hit = this.#hit;
    const rotations = this.#rapier.RotationOps;
    const rawRotation = (c: Slot): RawRotation => (c.rawRotation ??= rotations.intoRaw(c.rotation));
    /** Whether `shape1` at (`pos1`, `rot1`) touches coin `c`; the contact is then in `hit`. */
    const query = (shape1: RawShape, pos1: RawVector, rot1: RawRotation, c: Slot): boolean => {
      rawB.x = c.x;
      rawB.y = c.y;
      rawB.z = c.z;
      const contact = shape1.contactShape(pos1, rot1, rawShape, rawB, rawRotation(c), 0);
      if (contact === undefined) {
        return false;
      }
      contact.getComponents(hit);
      contact.free();
      return true;
    };
    const obstacles = this.#obstacles.map((obstacle, i) => ({
      obstacle,
      raw: entry(this.#rawObstacles, i),
      centre: obstacle.centre(),
    }));
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

    const loosened: RigidBody[] = [];
    const loosen = (c: Slot): void => {
      c.fixed = false;
      loosened.push(c.body);
    };

    this.#candidatePairs(coins);
    const pairs = this.#pairs;
    /** Pairs and obstacles are looked at again only for coins whose `movedIn` is at least this. */
    let since = FIRST_SINCE;
    let sweptAfter = 0;
    let converged = false;
    for (; pass < passes; pass++) {
      let pushed = false;
      for (let p = 0; p < this.#pairCount; p++) {
        const a = entry(pairs, 2 * p);
        const b = entry(pairs, 2 * p + 1);
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
        rawA.x = a.x;
        rawA.y = a.y;
        rawA.z = a.z;
        if (!query(rawShape, rawA, rawRotation(a), b)) {
          continue;
        }
        let depth = -entry(hit, 0);
        let x = entry(hit, 7);
        let y = entry(hit, 8);
        let z = entry(hit, 9);
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
        if (a.fixed) {
          loosen(a);
        }
        if (b.fixed) {
          loosen(b);
        }
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
      for (const { obstacle, raw, centre } of obstacles) {
        const h = obstacle.half;
        rawA.x = centre.x;
        rawA.y = centre.y;
        rawA.z = centre.z;
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
          if (!query(raw, rawA, this.#rawIdentity, coin) || entry(hit, 0) >= -slop) {
            continue;
          }
          const depth = -entry(hit, 0) - slop / 2;
          const x = entry(hit, 7);
          const y = entry(hit, 8);
          const z = entry(hit, 9);
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
        converged = true;
        pass += 1;
        break;
      }
      since = pass;
      if (this.#drifted(coins)) {
        // A pair new to the sweep has a coin that moved since the last one: two coins
        // that both stayed put were within reach of each other then too.
        since = sweptAfter;
        sweptAfter = pass + 1;
        this.#candidatePairs(coins);
      }
    }
    let moved = 0;
    for (const coin of coins) {
      if (coin.movedIn >= 0) {
        const to = this.#scratch;
        to.x = coin.x;
        to.y = coin.y;
        to.z = coin.z;
        coin.body.setTranslation(to, true);
        moved += 1;
      }
    }
    return { moved, passes: pass, converged, loosened };
  }

  /** Fills the slots from `bodies`, making new ones only for coins beyond the last call's count. */
  #load(bodies: Iterable<RigidBody>): readonly Slot[] {
    const slots = this.#slots;
    let n = 0;
    for (const body of bodies) {
      const slot = slots[n];
      const t = body.translation(this.#scratch);
      const q = body.rotation(slot?.rotation);
      const ax = 2 * (q.x * q.y - q.w * q.z);
      const ay = 1 - 2 * (q.x * q.x + q.z * q.z);
      const az = 2 * (q.y * q.z + q.w * q.x);
      const fixed = !body.isDynamic();
      const movedIn = fixed || body.isSleeping() ? ASLEEP : AWAKE;
      const ex = this.#halfExtent(ax);
      const ey = this.#halfExtent(ay);
      const ez = this.#halfExtent(az);
      if (slot === undefined) {
        slots.push({
          index: n,
          body,
          fixed,
          rotation: q,
          rawRotation: undefined,
          x: t.x,
          y: t.y,
          z: t.z,
          ax,
          ay,
          az,
          ex,
          ey,
          ez,
          hx: 0,
          hy: 0,
          hz: 0,
          movedIn,
          sweptX: t.x,
          sweptY: t.y,
          sweptZ: t.z,
        });
      } else {
        slot.body = body;
        slot.fixed = fixed;
        slot.rotation = q;
        slot.x = slot.sweptX = t.x;
        slot.y = slot.sweptY = t.y;
        slot.z = slot.sweptZ = t.z;
        slot.ax = ax;
        slot.ay = ay;
        slot.az = az;
        slot.ex = ex;
        slot.ey = ey;
        slot.ez = ez;
        slot.hx = slot.hy = slot.hz = 0;
        slot.movedIn = movedIn;
      }
      n += 1;
    }
    slots.length = n;
    return slots;
  }

  /**
   * Finds the pairs of coins whose centres are within the reach, by a sweep along x,
   * into #pairs; each coin is marked as swept where it stands. The order depends only
   * on the positions and the input order, so it is the same on every replay.
   */
  #candidatePairs(coins: readonly Slot[]): void {
    const n = coins.length;
    const order = this.#order;
    const sorted = this.#sorted;
    sorted.length = n;
    if (order.length === n) {
      for (let s = 0; s < n; s++) {
        sorted[s] = entry(coins, entry(order, s));
      }
    } else {
      for (let s = 0; s < n; s++) {
        sorted[s] = entry(coins, s);
      }
    }
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
    order.length = n;
    for (let s = 0; s < n; s++) {
      order[s] = entry(sorted, s).index;
    }
    const pairs = this.#pairs;
    let count = 0;
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
          pairs[2 * count] = a;
          pairs[2 * count + 1] = b;
          count += 1;
        }
      }
    }
    pairs.length = 2 * count;
    this.#pairCount = count;
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
