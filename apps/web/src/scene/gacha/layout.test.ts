import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import {
  CHUTE_POINTS,
  createChuteCurve,
  createChuteTrack,
  exitCapsule,
  GACHA,
  packPile,
  PILE_TINTS,
} from './layout.ts';

describe('packPile', () => {
  const pile = packPile(38);
  const c = GACHA.capsuleRadius;

  it('places every capsule inside the glass', () => {
    const inner = GACHA.globe.radius - GACHA.globe.wall;
    for (const capsule of pile) {
      const d = Math.hypot(capsule.x, capsule.y - GACHA.globe.centerY, capsule.z);
      expect(d + c).toBeLessThanOrEqual(inner + 1e-6);
    }
  });

  it('never overlaps two capsules', () => {
    for (let i = 0; i < pile.length; i++) {
      for (let j = i + 1; j < pile.length; j++) {
        const a = pile[i];
        const b = pile[j];
        if (!a || !b) throw new Error('pile index out of range');
        expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeGreaterThanOrEqual(2 * c - 1e-6);
      }
    }
  });

  it('settles in the bottom of the globe, clear of the cap', () => {
    for (const capsule of pile) expect(capsule.y).toBeLessThan(GACHA.globe.centerY + 0.04);
  });

  it('is deterministic per seed and varies across seeds', () => {
    expect(packPile(20, 3)).toEqual(packPile(20, 3));
    expect(packPile(20, 3)).not.toEqual(packPile(20, 4));
  });

  it('only uses the listed tints', () => {
    for (const capsule of pile) {
      expect(capsule.tint).toBeGreaterThanOrEqual(0);
      expect(capsule.tint).toBeLessThan(PILE_TINTS.length);
    }
  });

  it('throws when the globe cannot hold the pile', () => {
    expect(() => packPile(400)).toThrow(/no room/);
  });
});

describe('exitCapsule', () => {
  it('picks the capsule nearest the chute port', () => {
    const pile = packPile(30);
    const exit = pile[exitCapsule(pile)];
    const [px, py, pz] = CHUTE_POINTS[0] ?? [0, 0, 0];
    if (!exit) throw new Error('no exit capsule');
    const best = Math.hypot(exit.x - px, exit.y - py, exit.z - pz);
    for (const capsule of pile)
      expect(Math.hypot(capsule.x - px, capsule.y - py, capsule.z - pz)).toBeGreaterThanOrEqual(
        best,
      );
  });

  it('throws on an empty globe', () => {
    expect(() => exitCapsule([])).toThrow(/empty/);
  });
});

describe('chute track', () => {
  const curve = createChuteCurve();
  const track = createChuteTrack(curve);

  it('matches the curve at its ends and along it', () => {
    const point = new Vector3();
    const expected = new Vector3();
    for (const u of [0, 0.25, 0.5, 0.75, 1]) {
      track.pointAt(u, point);
      curve.getPointAt(u, expected);
      expect(point.distanceTo(expected)).toBeLessThan(5e-4);
    }
  });

  it('runs downhill from the port to the mouth', () => {
    const point = new Vector3();
    let last = Infinity;
    for (let i = 0; i <= 40; i++) {
      track.pointAt(i / 40, point);
      expect(point.y).toBeLessThanOrEqual(last + 1e-4);
      last = point.y;
    }
  });

  it('gives unit tangents and clamps out-of-range shares', () => {
    const tangent = new Vector3();
    expect(track.tangentAt(0.4, tangent).length()).toBeCloseTo(1, 6);
    const end = track.pointAt(1, new Vector3());
    expect(track.pointAt(3, new Vector3()).distanceTo(end)).toBe(0);
  });

  it('ends inside the tray', () => {
    const mouth = track.pointAt(1, new Vector3());
    expect(mouth.z).toBeGreaterThan(GACHA.body.halfDepth);
    expect(mouth.z).toBeLessThan(GACHA.tray.front);
    expect(Math.abs(mouth.x)).toBeLessThan(GACHA.tray.halfWidth);
  });
});
