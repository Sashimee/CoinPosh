import { COIN } from '../coin.ts';
import type { TableCoin } from '../table/table.ts';
import { type CoinFrame, coinFrame, withinGap } from './bounds.ts';

/** Groups below zero never touch anything: a coin that cannot fuse is left out. */
export const NO_GROUP = -1;

/** Two touching coins, `a < b`. */
export interface CoinPair {
  readonly a: number;
  readonly b: number;
}

function at(values: Float64Array, i: number): number {
  const value = values[i];
  if (value === undefined) {
    throw new Error(`CoinContactFinder: no scratch entry at ${i} of ${values.length}`);
  }
  return value;
}

/** The grid is at most this many cells along x and z; coins beyond share the edge cells. */
const MAX_CELLS = 64;

/**
 * Finds the pairs of coins in the same group whose surfaces are within `gap` metres of
 * each other, from their poses alone. Distances are those of the exact collider shape
 * the table simulates (a cylinder rounded by the rim radius), so a pair counts as
 * touching exactly when the physics has them resting against each other, whatever
 * their tilt.
 *
 * Candidates come from a grid over x and z with cells as wide as the reach, so a
 * coin only meets the coins of its own and the eight cells around it, and pairs in
 * different groups are dropped before any distance work: fusion only cares about
 * coins of one tier. Each candidate is then settled by withinGap (bounds.ts), which
 * refines true geometric bounds until they fall on one side of the gap, always with
 * the lower id first.
 *
 * The finder keeps nothing from one call to the next but scratch space, so what it
 * returns is a pure function of its arguments: a finder made mid-session, or one
 * rebuilt from a restored state, finds the same pairs.
 */
export class CoinContactFinder {
  readonly #gap: number;
  /** Centre distance beyond which two coins cannot be within the gap. */
  readonly #reach: number;
  readonly #reachSq: number;
  /** The grouped coins: their centres, groups, ids and grid cells. */
  #x = new Float64Array(0);
  #y = new Float64Array(0);
  #z = new Float64Array(0);
  #group = new Float64Array(0);
  #id = new Float64Array(0);
  #cellX = new Float64Array(0);
  #cellZ = new Float64Array(0);
  /** The grouped coins by cell: cell c holds #byCell[#cellStart[c]] up to #cellStart[c + 1]. */
  #byCell = new Float64Array(0);
  #cellStart = new Float64Array(0);
  #members: TableCoin[] = [];
  /** The members' frames, made the first time a call needs one. */
  #frames: (CoinFrame | undefined)[] = [];

  constructor(gap: number) {
    if (!Number.isFinite(gap) || gap < 0) {
      throw new RangeError(`Contact gap must be a finite number of metres >= 0, got ${gap}`);
    }
    this.#gap = gap;
    const bound = Math.sqrt(COIN.radius * COIN.radius + COIN.halfThickness * COIN.halfThickness);
    this.#reach = 2 * bound + gap;
    this.#reachSq = this.#reach * this.#reach;
  }

  /**
   * The touching pairs of coins whose `groups` entries match and are not below zero,
   * sorted by `a` then `b`. `groups[i]` belongs to `coins[i]`.
   *
   * With `slices` above one, only the pairs whose lower id is `slice` modulo `slices`
   * are looked at, so a caller can spread the work over that many ticks and still
   * see every pair once a round.
   */
  find(coins: readonly TableCoin[], groups: ArrayLike<number>, slice = 0, slices = 1): CoinPair[] {
    if (groups.length !== coins.length) {
      throw new RangeError(
        `CoinContactFinder.find needs one group per coin, got ${groups.length} for ${coins.length}`,
      );
    }
    if (
      !Number.isInteger(slices) ||
      slices < 1 ||
      !Number.isInteger(slice) ||
      slice < 0 ||
      slice >= slices
    ) {
      throw new RangeError(
        `CoinContactFinder.find needs a whole slice below a whole number of slices, got ${slice} of ${slices}`,
      );
    }
    const m = this.#gather(coins, groups);
    const pairs: CoinPair[] = [];
    if (m < 2) {
      this.#members.length = 0;
      return pairs;
    }
    const [width, depth] = this.#bin(m);
    const id = this.#id;
    const cellX = this.#cellX;
    const cellZ = this.#cellZ;
    for (let s = 0; s < m; s++) {
      if (at(id, s) % slices !== slice) {
        continue;
      }
      const cx = at(cellX, s);
      const cz = at(cellZ, s);
      const x0 = Math.max(0, cx - 1);
      const x1 = Math.min(width - 1, cx + 1);
      const z0 = Math.max(0, cz - 1);
      const z1 = Math.min(depth - 1, cz + 1);
      for (let gx = x0; gx <= x1; gx++) {
        for (let gz = z0; gz <= z1; gz++) {
          this.#scanCell(s, gx * depth + gz, pairs);
        }
      }
    }
    this.#members.length = 0;
    pairs.sort((p, q) => p.a - q.a || p.b - q.b);
    return pairs;
  }

  /** Copies the grouped coins into the scratch arrays and returns how many there are. */
  #gather(coins: readonly TableCoin[], groups: ArrayLike<number>): number {
    const n = coins.length;
    if (this.#x.length < n) {
      const size = Math.max(n, 2 * this.#x.length);
      this.#x = new Float64Array(size);
      this.#y = new Float64Array(size);
      this.#z = new Float64Array(size);
      this.#group = new Float64Array(size);
      this.#id = new Float64Array(size);
      this.#cellX = new Float64Array(size);
      this.#cellZ = new Float64Array(size);
      this.#byCell = new Float64Array(size);
    }
    const members = this.#members;
    members.length = 0;
    let m = 0;
    for (let i = 0; i < n; i++) {
      const group = groups[i];
      if (group === undefined) {
        throw new Error(`CoinContactFinder: no group at index ${i} of ${groups.length}`);
      }
      if (group < 0) {
        continue;
      }
      const coin = this.#coin(coins, i);
      const { x, y, z } = coin.translation;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw new RangeError(`CoinContactFinder.find: coin ${coin.id} is not at a finite position`);
      }
      this.#x[m] = x;
      this.#y[m] = y;
      this.#z[m] = z;
      this.#group[m] = group;
      this.#id[m] = coin.id;
      members.push(coin);
      m += 1;
    }
    this.#frames.length = 0;
    this.#frames.length = m;
    return m;
  }

  /** Puts the m members in their grid cells, by counting sort. Returns the grid's width and depth. */
  #bin(m: number): [number, number] {
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (let s = 0; s < m; s++) {
      const x = at(this.#x, s);
      const z = at(this.#z, s);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    const reach = this.#reach;
    // Clamping the cells keeps neighbours within one cell of each other, so a coin far
    // off the table only makes the edge cells fuller, never misses a pair.
    const width = Math.min(MAX_CELLS, Math.floor((maxX - minX) / reach) + 1);
    const depth = Math.min(MAX_CELLS, Math.floor((maxZ - minZ) / reach) + 1);
    const cells = width * depth;
    if (this.#cellStart.length < cells + 1) {
      this.#cellStart = new Float64Array(MAX_CELLS * MAX_CELLS + 1);
    }
    const start = this.#cellStart;
    start.fill(0, 0, cells + 1);
    for (let s = 0; s < m; s++) {
      const cx = Math.min(width - 1, Math.floor((at(this.#x, s) - minX) / reach));
      const cz = Math.min(depth - 1, Math.floor((at(this.#z, s) - minZ) / reach));
      this.#cellX[s] = cx;
      this.#cellZ[s] = cz;
      const cell = cx * depth + cz;
      start[cell + 1] = at(start, cell + 1) + 1;
    }
    for (let c = 0; c < cells; c++) {
      start[c + 1] = at(start, c + 1) + at(start, c);
    }
    for (let s = 0; s < m; s++) {
      const cell = at(this.#cellX, s) * depth + at(this.#cellZ, s);
      const slot = at(start, cell);
      this.#byCell[slot] = s;
      start[cell] = slot + 1;
    }
    for (let c = cells; c > 0; c--) {
      start[c] = at(start, c - 1);
    }
    start[0] = 0;
    return [width, depth];
  }

  /** Pairs member `s` with every touching member of a higher id in `cell`. */
  #scanCell(s: number, cell: number, pairs: CoinPair[]): void {
    const id = at(this.#id, s);
    const group = at(this.#group, s);
    const x = at(this.#x, s);
    const y = at(this.#y, s);
    const z = at(this.#z, s);
    const end = at(this.#cellStart, cell + 1);
    for (let k = at(this.#cellStart, cell); k < end; k++) {
      const t = at(this.#byCell, k);
      const other = at(this.#id, t);
      if (other <= id || at(this.#group, t) !== group) {
        continue;
      }
      const dx = at(this.#x, t) - x;
      const dy = at(this.#y, t) - y;
      const dz = at(this.#z, t) - z;
      if (
        dx * dx + dy * dy + dz * dz <= this.#reachSq &&
        withinGap(this.#frame(s), this.#frame(t), this.#gap)
      ) {
        pairs.push({ a: id, b: other });
      }
    }
  }

  #frame(s: number): CoinFrame {
    let frame = this.#frames[s];
    if (!frame) {
      const coin = this.#members[s];
      if (!coin) {
        throw new Error(`CoinContactFinder: no coin at member index ${s}`);
      }
      frame = coinFrame(coin.translation, coin.rotation);
      this.#frames[s] = frame;
    }
    return frame;
  }

  #coin(coins: readonly TableCoin[], i: number): TableCoin {
    const coin = coins[i];
    if (!coin) {
      throw new Error(`CoinContactFinder: no coin at index ${i} of ${coins.length}`);
    }
    return coin;
  }
}
