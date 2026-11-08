import { COIN_TIERS, type CoinTier } from '@coinposh/shared';

/** Floats per coin in a frame: translation xyz, then rotation quaternion xyzw. */
export const POSE_STRIDE = 7;

/** The tier byte of a coin the sim gave no tier, as in a Sim created without mechanics. */
export const NO_TIER = 255;

const HEADER_WORDS = 5;
const HEADER_BYTES = HEADER_WORDS * Float64Array.BYTES_PER_ELEMENT;
const TICK = 0;
const COUNT = 1;
const EPOCH = 2;
const PUSHER_EXTENSION = 3;
const PUSHER_PHASE = 4;

export interface CoinPose {
  readonly id: number;
  readonly translation: { readonly x: number; readonly y: number; readonly z: number };
  readonly rotation: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly w: number;
  };
  /** One of COIN_TIERS, or null (or absent) for a coin without one. */
  readonly tier?: string | null;
}

/** Where the pusher block is on the tick a frame shows. */
export interface FramePusher {
  /** 0 retracted to 1 at full stroke, as `setPusherStroke` takes it. */
  readonly extension: number;
  /** Position in the stroke cycle, 0 inclusive to 1 exclusive; the push ends at pushFraction. */
  readonly phase: number;
}

const RETRACTED: FramePusher = { extension: 0, phase: 0 };

/** Bytes one frame of `capacity` coins occupies; a multiple of 8 so frames pack back to back. */
export function frameByteLength(capacity: number): number {
  assertCapacity(capacity);
  const poseBytes = capacity * POSE_STRIDE * Float32Array.BYTES_PER_ELEMENT;
  return (
    HEADER_BYTES + capacity * Float64Array.BYTES_PER_ELEMENT + align8(poseBytes) + align8(capacity)
  );
}

/**
 * One sim tick's coin poses over a slice of an ArrayBuffer or SharedArrayBuffer: a float64
 * header (tick, count, epoch, pusher extension and phase), float64 coin ids in ascending order,
 * float32 poses, then one byte per coin indexing its tier in COIN_TIERS. Poses are float32
 * because that is what Rapier computes in, so the copy is exact.
 */
export class FrameView {
  readonly buffer: ArrayBufferLike;
  readonly capacity: number;
  readonly ids: Float64Array;
  readonly poses: Float32Array;
  readonly tiers: Uint8Array;
  readonly #header: Float64Array;

  constructor(buffer: ArrayBufferLike, byteOffset: number, capacity: number) {
    const bytes = frameByteLength(capacity);
    if (byteOffset % 8 !== 0 || byteOffset < 0 || byteOffset + bytes > buffer.byteLength) {
      throw new RangeError(
        `FrameView: a ${capacity}-coin frame needs ${bytes} bytes at an 8-aligned offset; got offset ${byteOffset} in a ${buffer.byteLength}-byte buffer`,
      );
    }
    this.buffer = buffer;
    this.capacity = capacity;
    this.#header = new Float64Array(buffer, byteOffset, HEADER_WORDS);
    const idsOffset = byteOffset + HEADER_BYTES;
    this.ids = new Float64Array(buffer, idsOffset, capacity);
    const posesOffset = idsOffset + capacity * Float64Array.BYTES_PER_ELEMENT;
    this.poses = new Float32Array(buffer, posesOffset, capacity * POSE_STRIDE);
    const tiersOffset =
      posesOffset + align8(capacity * POSE_STRIDE * Float32Array.BYTES_PER_ELEMENT);
    this.tiers = new Uint8Array(buffer, tiersOffset, capacity);
  }

  static allocate(capacity: number): FrameView {
    return new FrameView(new ArrayBuffer(frameByteLength(capacity)), 0, capacity);
  }

  get tick(): number {
    return this.#header[TICK] ?? 0;
  }

  get count(): number {
    return this.#header[COUNT] ?? 0;
  }

  /** Bumped by the worker whenever its tick clock is rebased (resume, or a stall it gave up on). */
  get epoch(): number {
    return this.#header[EPOCH] ?? 0;
  }

  get pusherExtension(): number {
    return this.#header[PUSHER_EXTENSION] ?? 0;
  }

  get pusherPhase(): number {
    return this.#header[PUSHER_PHASE] ?? 0;
  }

  /** The tier of the coin at `index`, or null when the sim gave it none. */
  tierAt(index: number): CoinTier | null {
    return COIN_TIERS[this.tiers[index] ?? NO_TIER] ?? null;
  }

  /**
   * Throws without writing anything if there are too many coins, ids are not strictly
   * ascending or a tier is not one of COIN_TIERS.
   */
  write(
    tick: number,
    epoch: number,
    coins: readonly CoinPose[],
    pusher: FramePusher = RETRACTED,
  ): void {
    if (coins.length > this.capacity) {
      throw new RangeError(
        `Sim frame overflow at tick ${tick}: ${coins.length} coins exceed the bridge capacity of ${this.capacity}; raise SimBridgeOptions.capacity`,
      );
    }
    let previous = -Infinity;
    for (const coin of coins) {
      if (!Number.isSafeInteger(coin.id) || coin.id <= previous) {
        throw new RangeError(
          `Sim frame at tick ${tick}: coin ids must be safe integers in strictly ascending order; got ${coin.id} after ${previous}`,
        );
      }
      tierByte(coin, tick);
      previous = coin.id;
    }
    const { ids, poses, tiers } = this;
    for (let i = 0; i < coins.length; i += 1) {
      const coin = coins[i];
      if (!coin) continue;
      const o = i * POSE_STRIDE;
      ids[i] = coin.id;
      poses[o] = coin.translation.x;
      poses[o + 1] = coin.translation.y;
      poses[o + 2] = coin.translation.z;
      poses[o + 3] = coin.rotation.x;
      poses[o + 4] = coin.rotation.y;
      poses[o + 5] = coin.rotation.z;
      poses[o + 6] = coin.rotation.w;
      tiers[i] = tierByte(coin, tick);
    }
    this.#header[TICK] = tick;
    this.#header[COUNT] = coins.length;
    this.#header[EPOCH] = epoch;
    this.#header[PUSHER_EXTENSION] = pusher.extension;
    this.#header[PUSHER_PHASE] = pusher.phase;
  }

  /**
   * Copies the first `count` coins of `source` into this frame, touching only the used range.
   * `count` defaults to the source's own; a reader racing a writer passes the count it checked.
   */
  copyFrom(source: FrameView, count = source.count): void {
    if (!Number.isInteger(count) || count < 0 || count > this.capacity) {
      throw new RangeError(
        `FrameView.copyFrom: ${count} coins do not fit a ${this.capacity}-coin frame`,
      );
    }
    this.ids.set(source.ids.subarray(0, count));
    this.poses.set(source.poses.subarray(0, count * POSE_STRIDE));
    this.tiers.set(source.tiers.subarray(0, count));
    this.#header[TICK] = source.tick;
    this.#header[COUNT] = count;
    this.#header[EPOCH] = source.epoch;
    this.#header[PUSHER_EXTENSION] = source.pusherExtension;
    this.#header[PUSHER_PHASE] = source.pusherPhase;
  }
}

function tierByte(coin: CoinPose, tick: number): number {
  if (coin.tier === undefined || coin.tier === null) return NO_TIER;
  const index = (COIN_TIERS as readonly string[]).indexOf(coin.tier);
  if (index < 0) {
    throw new RangeError(
      `Sim frame at tick ${tick}: coin ${coin.id} has tier "${coin.tier}", which is not one of ${COIN_TIERS.join(', ')}`,
    );
  }
  return index;
}

function align8(bytes: number): number {
  return Math.ceil(bytes / 8) * 8;
}

function assertCapacity(capacity: number): void {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError(`Frame capacity must be a positive integer, got ${capacity}`);
  }
}
