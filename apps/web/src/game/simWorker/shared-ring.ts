import { frameByteLength, FrameView, type CoinPose, type FramePusher } from './frame.ts';

const LATEST = 0;
const CONTROL_HEADER = 2;
/** A slot's sequence while the writer is inside it; published frames are numbered from 1. */
const WRITING = 0;

/**
 * Frames in a SharedArrayBuffer, for cross-origin isolated pages: the worker publishes each
 * tick into the next of `slots` frame slots and the render thread copies out whatever is new
 * on its own schedule, with no message per frame. Every slot carries a sequence number used as
 * a seqlock: the writer clears it before writing and stores the frame number after, so a reader
 * that sees the same number before and after its copy knows the copy is whole.
 */
export class SharedFrameRing {
  readonly buffer: SharedArrayBuffer;
  readonly slots: number;
  readonly capacity: number;
  readonly #control: Int32Array;
  readonly #frames: readonly FrameView[];

  static byteLength(slots: number, capacity: number): number {
    return controlBytes(slots) + slots * frameByteLength(capacity);
  }

  static create(slots: number, capacity: number): SharedFrameRing {
    return new SharedFrameRing(
      new SharedArrayBuffer(SharedFrameRing.byteLength(slots, capacity)),
      slots,
      capacity,
    );
  }

  constructor(buffer: SharedArrayBuffer, slots: number, capacity: number) {
    if (!Number.isInteger(slots) || slots < 2) {
      throw new RangeError(`SharedFrameRing needs at least 2 slots, got ${slots}`);
    }
    const bytes = SharedFrameRing.byteLength(slots, capacity);
    if (buffer.byteLength < bytes) {
      throw new RangeError(
        `SharedFrameRing: ${slots} slots of ${capacity} coins need ${bytes} bytes, the buffer has ${buffer.byteLength}`,
      );
    }
    this.buffer = buffer;
    this.slots = slots;
    this.capacity = capacity;
    this.#control = new Int32Array(buffer, 0, CONTROL_HEADER + slots);
    const offset = controlBytes(slots);
    const stride = frameByteLength(capacity);
    this.#frames = Array.from(
      { length: slots },
      (_, i) => new FrameView(buffer, offset + i * stride, capacity),
    );
  }

  /** Number of the newest whole frame, 0 before the first publish. */
  latest(): number {
    return Atomics.load(this.#control, LATEST);
  }

  /** Writer side. Returns the published frame number. */
  publish(tick: number, epoch: number, coins: readonly CoinPose[], pusher?: FramePusher): number {
    const sequence = this.latest() + 1;
    const slot = sequence % this.slots;
    const frame = this.#frames[slot];
    if (!frame) throw new Error(`SharedFrameRing: slot ${slot} is missing`);
    const index = CONTROL_HEADER + slot;
    const previous = Atomics.exchange(this.#control, index, WRITING);
    try {
      frame.write(tick, epoch, coins, pusher);
    } catch (error) {
      // FrameView.write validates before it writes, so the slot still holds frame `previous`.
      Atomics.store(this.#control, index, previous);
      throw error;
    }
    Atomics.store(this.#control, index, sequence);
    Atomics.store(this.#control, LATEST, sequence);
    return sequence;
  }

  /**
   * Reader side: copies frame `sequence` into `target`. False when the slot has been reused
   * for a newer frame or was being rewritten during the copy, in which case `target` holds
   * garbage and must be discarded.
   */
  readInto(sequence: number, target: FrameView): boolean {
    const index = CONTROL_HEADER + (sequence % this.slots);
    const frame = this.#frames[sequence % this.slots];
    if (!frame || Atomics.load(this.#control, index) !== sequence) return false;
    const count = frame.count;
    if (!Number.isInteger(count) || count < 0 || count > target.capacity) return false;
    target.copyFrom(frame, count);
    return Atomics.load(this.#control, index) === sequence;
  }
}

function controlBytes(slots: number): number {
  return Math.ceil(((CONTROL_HEADER + slots) * Int32Array.BYTES_PER_ELEMENT) / 8) * 8;
}
