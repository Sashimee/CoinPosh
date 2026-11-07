import type {
  Rotation,
  Shape,
  ShapeContact,
  Vector,
} from '@dimforge/rapier3d-deterministic-compat';
import { COIN } from '../coin.ts';
import type { Rapier } from '../rapier.ts';
import type { TableCoin } from '../table/table.ts';
import { COIN_MATERIAL, TABLE_SOLVER } from '../table/tuning.ts';
import { coinFrame, distanceLowerBound, distanceUpperBound } from './bounds.ts';

const SCALE = TABLE_SOLVER.worldScale;

/** Groups below zero never touch anything: a coin that cannot fuse is left out. */
export const NO_GROUP = -1;

/** Two touching coins, `a < b`. */
export interface CoinPair {
  readonly a: number;
  readonly b: number;
}

/**
 * The poses of a pair when it was last measured, and its distance then, in metres.
 * The distance may be a bound, but always one on the far side of the gap from where
 * the pair is: a lower bound when apart, an upper bound when touching.
 */
interface Measured {
  readonly distance: number;
  readonly rx: number;
  readonly ry: number;
  readonly rz: number;
  readonly qa: Readonly<Rotation>;
  readonly qb: Readonly<Rotation>;
}

/** Slack against the exact query's rounding when reusing a measured distance, in metres. */
const REUSE_SLACK = 1e-6;

/** Coin ids are table ids, which count up from zero; 2^26 of them outlast any session. */
const ID_LIMIT = 0x4000000;

function pairKey(lo: number, hi: number): number {
  if (hi >= ID_LIMIT) {
    throw new RangeError(`CoinContactFinder: coin id ${hi} is past the ${ID_LIMIT} it can key`);
  }
  return lo * ID_LIMIT + hi;
}

function at(values: ArrayLike<number>, i: number): number {
  const value = values[i];
  if (value === undefined) {
    throw new Error(`CoinContactFinder: no coin at index ${i} of ${values.length}`);
  }
  return value;
}

/**
 * Finds the pairs of coins in the same group whose surfaces are within `gap` metres of
 * each other, from their poses alone. The query uses the exact collider shape the
 * table simulates (the rounded cylinder at the solver's world scale), so a pair counts
 * as touching exactly when the physics has them resting against each other, whatever
 * their tilt.
 *
 * Candidates come from a sweep along x with a bounding-sphere test, and pairs in
 * different groups are dropped before any exact query: fusion only cares about coins
 * of one tier. The exact query is the expensive part (a few microseconds across the
 * WASM boundary, and a pile has hundreds of candidates), so it is the last resort:
 *
 * - A pair's distance is kept and reused while the pair cannot have crossed the gap:
 *   moving two coins changes their distance by at most how far one moved relative to
 *   the other plus how far each one's rim swung, and a pile riding the pusher moves
 *   together.
 * - Otherwise cheap bounds (bounds.ts) settle most pairs: their shadows are farther
 *   apart than the gap, or two points on them are nearer than it.
 *
 * The bounds are true geometric bounds. Rapier's query is iterative and reads up to
 * about 0.4 mm long on these rounded shapes, so a pair within that of the gap may be
 * classed differently than the query alone would class it, always deterministically.
 */
export class CoinContactFinder {
  readonly #shape: Shape;
  readonly #contact: ShapeContact;
  readonly #gap: number;
  readonly #reachWorld: number;
  /** Bounding radius of a coin: no point of it is farther from its centre. */
  readonly #bound: number;
  /** Centre distance beyond which two coins cannot be within the gap. */
  readonly #reach: number;
  readonly #reachSq: number;
  readonly #posA: Vector = { x: 0, y: 0, z: 0 };
  readonly #posB: Vector = { x: 0, y: 0, z: 0 };
  /** Last tick's candidates, by pairKey. */
  #measured = new Map<number, Measured>();
  #order: number[] = [];
  #xs = new Float64Array(0);

  constructor(rapier: Rapier, gap: number) {
    if (!Number.isFinite(gap) || gap < 0) {
      throw new RangeError(`Contact gap must be a finite number of metres >= 0, got ${gap}`);
    }
    const rim = COIN_MATERIAL.rimRadius;
    this.#shape = new rapier.RoundCylinder(
      (COIN.halfThickness - rim) * SCALE,
      (COIN.radius - rim) * SCALE,
      rim * SCALE,
    );
    this.#contact = new rapier.ShapeContact(0, zero(), zero(), zero(), zero());
    this.#gap = gap;
    this.#bound = Math.sqrt(COIN.radius * COIN.radius + COIN.halfThickness * COIN.halfThickness);
    this.#reach = 2 * this.#bound + gap;
    this.#reachSq = this.#reach * this.#reach;
    this.#reachWorld = this.#reach * SCALE;
  }

  /**
   * Every touching pair of coins whose `groups` entries match and are not below zero,
   * sorted by `a` then `b`. `groups[i]` belongs to `coins[i]`.
   */
  find(coins: readonly TableCoin[], groups: ArrayLike<number>): CoinPair[] {
    if (groups.length !== coins.length) {
      throw new RangeError(
        `CoinContactFinder.find needs one group per coin, got ${groups.length} for ${coins.length}`,
      );
    }
    const n = coins.length;
    if (this.#xs.length < n) {
      this.#xs = new Float64Array(Math.max(n, 2 * this.#xs.length));
    }
    const xs = this.#xs;
    const order = this.#order;
    order.length = 0;
    for (let i = 0; i < n; i++) {
      if (at(groups, i) >= 0) {
        xs[i] = this.#coin(coins, i).translation.x;
        order.push(i);
      }
    }
    order.sort((i, j) => at(xs, i) - at(xs, j) || i - j);

    const pairs: CoinPair[] = [];
    const previous = this.#measured;
    const measured = new Map<number, Measured>();
    for (let s = 0; s < order.length; s++) {
      const i = at(order, s);
      const ci = this.#coin(coins, i);
      const gi = at(groups, i);
      const pi = ci.translation;
      for (let t = s + 1; t < order.length; t++) {
        const j = at(order, t);
        const pj = this.#coin(coins, j).translation;
        if (pj.x - pi.x > this.#reach) {
          break;
        }
        if (at(groups, j) !== gi) {
          continue;
        }
        const dx = pj.x - pi.x;
        const dy = pj.y - pi.y;
        const dz = pj.z - pi.z;
        if (dx * dx + dy * dy + dz * dz > this.#reachSq) {
          continue;
        }
        const cj = this.#coin(coins, j);
        const lo = ci.id < cj.id ? ci : cj;
        const hi = lo === ci ? cj : ci;
        const key = pairKey(lo.id, hi.id);
        const entry = this.#measure(lo, hi, previous.get(key));
        measured.set(key, entry);
        if (entry.distance <= this.#gap) {
          pairs.push({ a: lo.id, b: hi.id });
        }
      }
    }
    this.#measured = measured;
    pairs.sort((p, q) => p.a - q.a || p.b - q.b);
    return pairs;
  }

  /** `last` again if the pair cannot have crossed the gap since, else a fresh measurement. */
  #measure(a: TableCoin, b: TableCoin, last: Measured | undefined): Measured {
    const pa = a.translation;
    const pb = b.translation;
    const rx = pb.x - pa.x;
    const ry = pb.y - pa.y;
    const rz = pb.z - pa.z;
    if (last) {
      const dx = rx - last.rx;
      const dy = ry - last.ry;
      const dz = rz - last.rz;
      const drift =
        Math.sqrt(dx * dx + dy * dy + dz * dz) +
        2 * this.#bound * (turn(a.rotation, last.qa) + turn(b.rotation, last.qb)) +
        REUSE_SLACK;
      if (Math.abs(last.distance - this.#gap) > drift) {
        return last;
      }
    }
    return { distance: this.#bounded(a, b), rx, ry, rz, qa: a.rotation, qb: b.rotation };
  }

  /** A bound that settles which side of the gap the pair is on, or the exact distance. */
  #bounded(a: TableCoin, b: TableCoin): number {
    const fa = coinFrame(a.translation, a.rotation);
    const fb = coinFrame(b.translation, b.rotation);
    const lower = distanceLowerBound(fa, fb);
    if (lower > this.#gap) {
      return lower;
    }
    const upper = distanceUpperBound(fa, fb);
    if (upper <= this.#gap) {
      return upper;
    }
    return this.#distance(a, b);
  }

  /**
   * Surface distance in metres. The query looks as far as the candidate reach, so a
   * candidate's distance is always measured; beyond it, the reach is a lower bound.
   */
  #distance(a: TableCoin, b: TableCoin): number {
    const posA = this.#posA;
    const posB = this.#posB;
    posA.x = a.translation.x * SCALE;
    posA.y = a.translation.y * SCALE;
    posA.z = a.translation.z * SCALE;
    posB.x = b.translation.x * SCALE;
    posB.y = b.translation.y * SCALE;
    posB.z = b.translation.z * SCALE;
    const hit = this.#shape.contactShape(
      posA,
      a.rotation,
      this.#shape,
      posB,
      b.rotation,
      this.#reachWorld,
      this.#contact,
    );
    return hit === null ? this.#reach : hit.distance / SCALE;
  }

  #coin(coins: readonly TableCoin[], i: number): TableCoin {
    const coin = coins[i];
    if (!coin) {
      throw new Error(`CoinContactFinder: no coin at index ${i} of ${coins.length}`);
    }
    return coin;
  }
}

/**
 * An upper bound on the sine of half the angle between two orientations: |q - q'|
 * with the sign of q' chosen nearer, which is 2 sin(θ/4). A point r from the centre
 * moves 2r sin(θ/2) under the turn, at most 2r times this.
 */
function turn(q: Readonly<Rotation>, p: Readonly<Rotation>): number {
  const dot = q.x * p.x + q.y * p.y + q.z * p.z + q.w * p.w;
  const s = dot < 0 ? -1 : 1;
  const x = q.x - s * p.x;
  const y = q.y - s * p.y;
  const z = q.z - s * p.z;
  const w = q.w - s * p.w;
  return Math.sqrt(x * x + y * y + z * z + w * w);
}

function zero(): Vector {
  return { x: 0, y: 0, z: 0 };
}
