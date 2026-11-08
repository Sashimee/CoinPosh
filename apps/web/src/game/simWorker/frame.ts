/** Floats per coin in a frame: translation xyz, then rotation quaternion xyzw. */
export const POSE_STRIDE = 7;

const HEADER_WORDS = 4;
const HEADER_BYTES = HEADER_WORDS * Float64Array.BYTES_PER_ELEMENT;
const TICK = 0;
const COUNT = 1;
const EPOCH = 2;

export interface CoinPose {
  readonly id: number;
  readonly translation: { readonly x: number; readonly y: number; readonly z: number };
  readonly rotation: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly w: number;
  };
}

/** Bytes one frame of `capacity` coins occupies; a multiple of 8 so frames pack back to back. */
export function frameByteLength(capacity: number): number {
  assertCapacity(capacity);
  const poseBytes = capacity * POSE_STRIDE * Float32Array.BYTES_PER_ELEMENT;
  return HEADER_BYTES + capacity * Float64Array.BYTES_PER_ELEMENT + align8(poseBytes);
}

/**
 * One sim tick's coin poses over a slice of an ArrayBuffer or SharedArrayBuffer: a float64
 * header (tick, count, epoch), float64 coin ids in ascending order, then float32 poses. Poses
 * are float32 because that is what Rapier computes in, so the copy is exact.
 */
export class FrameView {
  readonly buffer: ArrayBufferLike;
  readonly capacity: number;
  readonly ids: Float64Array;
  readonly poses: Float32Array;
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
    this.ids = new Float64Array(buffer, byteOffset + HEADER_BYTES, capacity);
    this.poses = new Float32Array(
      buffer,
      byteOffset + HEADER_BYTES + capacity * Float64Array.BYTES_PER_ELEMENT,
      capacity * POSE_STRIDE,
    );
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

  /** Throws without writing anything if there are too many coins or ids are not strictly ascending. */
  write(tick: number, epoch: number, coins: readonly CoinPose[]): void {
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
      previous = coin.id;
    }
    const { ids, poses } = this;
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
    }
    this.#header[TICK] = tick;
    this.#header[COUNT] = coins.length;
    this.#header[EPOCH] = epoch;
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
    this.#header[TICK] = source.tick;
    this.#header[COUNT] = count;
    this.#header[EPOCH] = source.epoch;
  }
}

function align8(bytes: number): number {
  return Math.ceil(bytes / 8) * 8;
}

function assertCapacity(capacity: number): void {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError(`Frame capacity must be a positive integer, got ${capacity}`);
  }
}
