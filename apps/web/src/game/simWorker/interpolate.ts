import { COIN_TIER_IDS, type CoinTierId } from '../../scene/coins/index.ts';
import { POSE_STRIDE, type FrameView } from './frame.ts';

/** What the bridge draws into; CoinField satisfies it. */
export interface CoinTransformTarget {
  capacity(tier: CoinTierId): number;
  setTransforms(
    tier: CoinTierId,
    positions: ArrayLike<number>,
    quaternions: ArrayLike<number>,
    count: number,
    ids: ArrayLike<number>,
  ): void;
}

/**
 * A coin that moves further than this in one tick is drawn at its new pose rather than swept
 * across the gap: coins top out near 3 m/s (5 cm a tick) when they fall, so anything beyond
 * 20 cm a tick is the sim placing a coin, not moving it.
 */
export const TELEPORT_METRES_PER_TICK = 0.2;

interface TierOutput {
  readonly tier: CoinTierId;
  positions: Float32Array;
  quaternions: Float32Array;
  ids: Float64Array;
  count: number;
}

/**
 * Blends two sim frames into per-tier transform arrays for CoinField. Both frames list coins in
 * ascending id order, so matching a coin across them is one merge pass with no lookups. Positions
 * lerp; rotations nlerp along the shorter arc, which at the few degrees a coin turns in one tick
 * is indistinguishable from slerp at a fraction of the cost. A coin new in the later frame
 * appears at its pose there, and one gone from it is no longer drawn.
 */
export class FrameBlender {
  readonly #outputs: readonly TierOutput[];
  readonly #byTier: ReadonlyMap<CoinTierId, TierOutput>;

  constructor(initialCapacity = 64) {
    initialCapacity = Math.max(1, Math.ceil(initialCapacity));
    this.#outputs = COIN_TIER_IDS.map((tier) => ({
      tier,
      positions: new Float32Array(initialCapacity * 3),
      quaternions: new Float32Array(initialCapacity * 4),
      ids: new Float64Array(initialCapacity),
      count: 0,
    }));
    this.#byTier = new Map(this.#outputs.map((output) => [output.tier, output]));
  }

  /** Coins of `tier` written by the last `blend`. */
  count(tier: CoinTierId): number {
    return this.#byTier.get(tier)?.count ?? 0;
  }

  blend(from: FrameView, to: FrameView, alpha: number, tierOf: (id: number) => CoinTierId): void {
    for (const output of this.#outputs) output.count = 0;
    const t = alpha <= 0 ? 0 : alpha >= 1 ? 1 : alpha;
    const span = Math.max(1, to.tick - from.tick);
    const snapSq = (TELEPORT_METRES_PER_TICK * span) ** 2;
    const a = from.poses;
    const b = to.poses;
    const fromIds = from.ids;
    const fromCount = from.count;
    const toIds = to.ids;
    const toCount = to.count;
    let i = 0;
    for (let j = 0; j < toCount; j += 1) {
      const id = toIds[j] ?? 0;
      while (i < fromCount && (fromIds[i] ?? 0) < id) i += 1;
      const output = this.#reserve(tierOf(id));
      const slot = output.count;
      output.count += 1;
      output.ids[slot] = id;
      const pb = j * POSE_STRIDE;
      const p = output.positions;
      const q = output.quaternions;
      const po = slot * 3;
      const qo = slot * 4;
      const bx = b[pb] ?? 0;
      const by = b[pb + 1] ?? 0;
      const bz = b[pb + 2] ?? 0;
      const bqx = b[pb + 3] ?? 0;
      const bqy = b[pb + 4] ?? 0;
      const bqz = b[pb + 5] ?? 0;
      const bqw = b[pb + 6] ?? 1;
      if (i < fromCount && fromIds[i] === id && t < 1) {
        const pa = i * POSE_STRIDE;
        const ax = a[pa] ?? 0;
        const ay = a[pa + 1] ?? 0;
        const az = a[pa + 2] ?? 0;
        const dx = bx - ax;
        const dy = by - ay;
        const dz = bz - az;
        if (dx * dx + dy * dy + dz * dz <= snapSq) {
          p[po] = ax + dx * t;
          p[po + 1] = ay + dy * t;
          p[po + 2] = az + dz * t;
          const aqx = a[pa + 3] ?? 0;
          const aqy = a[pa + 4] ?? 0;
          const aqz = a[pa + 5] ?? 0;
          const aqw = a[pa + 6] ?? 1;
          const sign = aqx * bqx + aqy * bqy + aqz * bqz + aqw * bqw < 0 ? -1 : 1;
          const qx = aqx + (sign * bqx - aqx) * t;
          const qy = aqy + (sign * bqy - aqy) * t;
          const qz = aqz + (sign * bqz - aqz) * t;
          const qw = aqw + (sign * bqw - aqw) * t;
          const inv = 1 / Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
          q[qo] = qx * inv;
          q[qo + 1] = qy * inv;
          q[qo + 2] = qz * inv;
          q[qo + 3] = qw * inv;
          continue;
        }
      }
      p[po] = bx;
      p[po + 1] = by;
      p[po + 2] = bz;
      q[qo] = bqx;
      q[qo + 1] = bqy;
      q[qo + 2] = bqz;
      q[qo + 3] = bqw;
    }
  }

  /**
   * Hands every tier, including empty ones, to `target`, so coins that left the table vanish.
   * A tier holding more coins than `target` has room for is drawn up to its capacity, oldest
   * coins first, and `onOverflow` hears of it; returns how many coins went undrawn.
   */
  writeTo(
    target: CoinTransformTarget,
    onOverflow?: (tier: CoinTierId, count: number, capacity: number) => void,
  ): number {
    let dropped = 0;
    for (const output of this.#outputs) {
      const capacity = Math.max(0, target.capacity(output.tier));
      let count = output.count;
      if (count > capacity) {
        onOverflow?.(output.tier, count, capacity);
        dropped += count - capacity;
        count = capacity;
      }
      target.setTransforms(output.tier, output.positions, output.quaternions, count, output.ids);
    }
    return dropped;
  }

  #reserve(tier: CoinTierId): TierOutput {
    const output = this.#byTier.get(tier);
    if (!output) throw new Error(`FrameBlender: unknown coin tier "${tier}"`);
    if (output.count === output.ids.length) {
      const size = output.ids.length * 2;
      output.positions = grow(output.positions, size * 3);
      output.quaternions = grow(output.quaternions, size * 4);
      const ids = new Float64Array(size);
      ids.set(output.ids);
      output.ids = ids;
    }
    return output;
  }
}

function grow(source: Float32Array, length: number): Float32Array {
  const next = new Float32Array(length);
  next.set(source);
  return next;
}
