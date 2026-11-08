import { describe, expect, it } from 'vitest';
import type { CoinTierId } from '../../scene/coins/index.ts';
import { FrameView, type CoinPose } from './frame.ts';
import { FrameBlender, TELEPORT_METRES_PER_TICK, type CoinTransformTarget } from './interpolate.ts';

function pose(id: number, x: number, yaw = 0): CoinPose {
  return {
    id,
    translation: { x, y: 0.0013, z: 0 },
    rotation: { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) },
  };
}

function frame(tick: number, coins: CoinPose[]): FrameView {
  const view = FrameView.allocate(Math.max(1, coins.length));
  view.write(tick, 0, coins);
  return view;
}

interface Written {
  positions: number[];
  quaternions: number[];
  ids: number[];
}

class RecordingTarget implements CoinTransformTarget {
  readonly written = new Map<CoinTierId, Written>();
  capacity(): number {
    return 1024;
  }
  setTransforms(
    tier: CoinTierId,
    positions: ArrayLike<number>,
    quaternions: ArrayLike<number>,
    count: number,
    ids: ArrayLike<number>,
  ): void {
    this.written.set(tier, {
      positions: Array.from(positions).slice(0, count * 3),
      quaternions: Array.from(quaternions).slice(0, count * 4),
      ids: Array.from(ids).slice(0, count),
    });
  }
  tier(tier: CoinTierId): Written {
    const written = this.written.get(tier);
    if (!written) throw new Error(`nothing written for ${tier}`);
    return written;
  }
}

const copper = (_id: number): CoinTierId => 'copper';

function blendOne(from: FrameView, to: FrameView, alpha: number, tierOf = copper): RecordingTarget {
  const blender = new FrameBlender(1);
  blender.blend(from, to, alpha, tierOf);
  const target = new RecordingTarget();
  blender.writeTo(target);
  return target;
}

describe('FrameBlender', () => {
  it('lerps positions and keeps rotations unit length at every alpha', () => {
    const a = frame(10, [pose(1, 0, 0)]);
    const b = frame(11, [pose(1, 0.01, 0.6)]);
    for (const alpha of [0, 0.25, 0.5, 0.75, 1]) {
      const { positions, quaternions } = blendOne(a, b, alpha).tier('copper');
      expect(positions[0]).toBeCloseTo(0.01 * alpha, 7);
      const [x = 0, y = 0, z = 0, w = 0] = quaternions;
      expect(Math.hypot(x, y, z, w)).toBeCloseTo(1, 6);
      expect(2 * Math.atan2(y, w)).toBeCloseTo(0.6 * alpha, 2);
    }
  });

  it('turns the short way when the next quaternion has the opposite sign', () => {
    const a = frame(1, [pose(1, 0, 0.2)]);
    const flipped: CoinPose = {
      id: 1,
      translation: { x: 0, y: 0.0013, z: 0 },
      rotation: { x: 0, y: -Math.sin(0.15), z: 0, w: -Math.cos(0.15) },
    };
    const b = frame(2, [flipped]);
    const [, y = 0, , w = 0] = blendOne(a, b, 0.5).tier('copper').quaternions;
    const yaw = 2 * Math.atan2(y * Math.sign(w), Math.abs(w));
    expect(yaw).toBeCloseTo(0.25, 3);
  });

  it('shows a new coin at its pose and drops a coin that left the table', () => {
    const a = frame(5, [pose(1, 0), pose(2, 0.05)]);
    const b = frame(6, [pose(2, 0.06), pose(3, 0.1)]);
    const { ids, positions } = blendOne(a, b, 0.5).tier('copper');
    expect(ids).toEqual([2, 3]);
    expect(positions[0]).toBeCloseTo(0.055, 6);
    expect(positions[3]).toBeCloseTo(0.1, 6);
  });

  it('places a teleported coin instead of sweeping it, scaled by the tick span', () => {
    const far = TELEPORT_METRES_PER_TICK * 1.5;
    const a = frame(1, [pose(1, 0)]);
    expect(blendOne(a, frame(2, [pose(1, far)]), 0.5).tier('copper').positions[0]).toBeCloseTo(
      far,
      6,
    );
    expect(blendOne(a, frame(3, [pose(1, far)]), 0.5).tier('copper').positions[0]).toBeCloseTo(
      far / 2,
      6,
    );
  });

  it('holds a single frame when from and to are the same', () => {
    const a = frame(1, [pose(4, 0.02, 0.3)]);
    const { positions } = blendOne(a, a, 1).tier('copper');
    expect(positions[0]).toBeCloseTo(0.02, 6);
  });

  it('splits coins by tier, clears empty tiers and grows past its initial size', () => {
    const coins = Array.from({ length: 40 }, (_, i) => pose(i, i * 0.001));
    const a = frame(1, coins);
    const target = blendOne(a, a, 1, (id) => (id % 4 === 0 ? 'gold' : 'copper'));
    expect(target.tier('gold').ids).toEqual([0, 4, 8, 12, 16, 20, 24, 28, 32, 36]);
    expect(target.tier('copper').ids).toHaveLength(30);
    expect(target.tier('heirloom').ids).toEqual([]);
    expect(target.tier('gold').positions[3]).toBeCloseTo(0.004, 6);
  });
});
