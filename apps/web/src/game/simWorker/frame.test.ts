import { describe, expect, it } from 'vitest';
import { frameByteLength, FrameView, POSE_STRIDE, type CoinPose } from './frame.ts';
import { SharedFrameRing } from './shared-ring.ts';

function coin(id: number, x = id * 0.01): CoinPose {
  return {
    id,
    translation: { x, y: 0.0013, z: -x },
    rotation: { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 },
  };
}

describe('FrameView', () => {
  it('round-trips tick, epoch, ids and float32 poses', () => {
    const frame = FrameView.allocate(4);
    frame.write(1234, 2, [coin(3), coin(7), coin(2 ** 40)]);
    expect(frame.tick).toBe(1234);
    expect(frame.epoch).toBe(2);
    expect(frame.count).toBe(3);
    expect(Array.from(frame.ids.subarray(0, 3))).toEqual([3, 7, 2 ** 40]);
    expect(frame.poses[POSE_STRIDE]).toBe(Math.fround(0.07));
    expect(frame.poses[POSE_STRIDE + 2]).toBe(Math.fround(-0.07));
    expect(frame.poses[POSE_STRIDE + 4]).toBe(Math.fround(Math.SQRT1_2));
  });

  it('accepts an empty frame and a frame filled to capacity', () => {
    const frame = FrameView.allocate(2);
    frame.write(1, 0, []);
    expect(frame.count).toBe(0);
    frame.write(2, 0, [coin(0), coin(1)]);
    expect(frame.count).toBe(2);
  });

  it('rejects overflow and unordered or duplicate ids without writing', () => {
    const frame = FrameView.allocate(2);
    frame.write(5, 0, [coin(1)]);
    expect(() => {
      frame.write(6, 0, [coin(1), coin(2), coin(3)]);
    }).toThrow(/capacity of 2.*SimBridgeOptions\.capacity/);
    expect(() => {
      frame.write(6, 0, [coin(2), coin(1)]);
    }).toThrow(/strictly ascending/);
    expect(() => {
      frame.write(6, 0, [coin(2), coin(2)]);
    }).toThrow(/strictly ascending/);
    expect(() => {
      frame.write(6, 0, [coin(0.5)]);
    }).toThrow(/safe integers/);
    expect(frame.tick).toBe(5);
    expect(frame.count).toBe(1);
  });

  it('packs frames back to back on 8-byte boundaries and refuses a bad slice', () => {
    expect(frameByteLength(1) % 8).toBe(0);
    expect(frameByteLength(3) % 8).toBe(0);
    expect(() => frameByteLength(0)).toThrow(/positive integer/);
    const buffer = new ArrayBuffer(frameByteLength(3) * 2);
    expect(() => new FrameView(buffer, frameByteLength(3), 3)).not.toThrow();
    expect(() => new FrameView(buffer, 4, 3)).toThrow(/8-aligned/);
    expect(() => new FrameView(buffer, frameByteLength(3) + 8, 3)).toThrow(/needs/);
  });

  it('copies only the used range from a frame of another capacity', () => {
    const source = FrameView.allocate(8);
    source.write(9, 1, [coin(4), coin(5)]);
    const target = FrameView.allocate(2);
    target.copyFrom(source);
    expect(target.tick).toBe(9);
    expect(target.epoch).toBe(1);
    expect(Array.from(target.ids)).toEqual([4, 5]);
    source.write(10, 1, [coin(1), coin(2), coin(3)]);
    expect(() => {
      target.copyFrom(source);
    }).toThrow(/do not fit/);
  });
});

describe('SharedFrameRing', () => {
  it('hands the reader every frame still in a slot and only whole ones', () => {
    const ring = SharedFrameRing.create(3, 4);
    expect(ring.latest()).toBe(0);
    const target = FrameView.allocate(4);
    expect(ring.readInto(1, target)).toBe(false);
    for (let tick = 1; tick <= 5; tick += 1) ring.publish(tick, 0, [coin(tick)]);
    expect(ring.latest()).toBe(5);
    expect(ring.readInto(2, target)).toBe(false);
    for (const seq of [3, 4, 5]) {
      expect(ring.readInto(seq, target)).toBe(true);
      expect(target.tick).toBe(seq);
      expect(target.ids[0]).toBe(seq);
    }
  });

  it('shares state between two views of one buffer, as the worker and page see it', () => {
    const writer = SharedFrameRing.create(4, 2);
    const reader = new SharedFrameRing(writer.buffer, 4, 2);
    writer.publish(42, 3, [coin(1), coin(2)]);
    const target = FrameView.allocate(2);
    expect(reader.readInto(reader.latest(), target)).toBe(true);
    expect(target.tick).toBe(42);
    expect(target.epoch).toBe(3);
  });

  it('keeps the slot readable as the previous frame when a publish fails', () => {
    const ring = SharedFrameRing.create(2, 1);
    ring.publish(1, 0, [coin(1)]);
    ring.publish(2, 0, [coin(2)]);
    expect(() => ring.publish(3, 0, [coin(1), coin(2)])).toThrow(/overflow/);
    expect(ring.latest()).toBe(2);
    const target = FrameView.allocate(1);
    expect(ring.readInto(1, target)).toBe(true);
    expect(target.tick).toBe(1);
    expect(ring.publish(3, 0, [coin(3)])).toBe(3);
    expect(ring.readInto(1, target)).toBe(false);
  });

  it('rejects a ring too small to be safe or a buffer too small for it', () => {
    expect(() => SharedFrameRing.create(1, 4)).toThrow(/at least 2 slots/);
    expect(() => new SharedFrameRing(new SharedArrayBuffer(64), 4, 4)).toThrow(/need/);
  });
});
