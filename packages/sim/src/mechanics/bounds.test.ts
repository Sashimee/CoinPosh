import type { Rotation, Vector } from '@dimforge/rapier3d-deterministic-compat';
import { describe, expect, it } from 'vitest';
import { COIN } from '../coin.ts';
import { Xoshiro128ss } from '../prng.ts';
import { loadRapier } from '../rapier.ts';
import { COIN_MATERIAL, TABLE_SOLVER } from '../table/tuning.ts';
import {
  coinFrame,
  distanceLowerBound,
  distanceUpperBound,
  nearCorePoints,
  withinGap,
} from './bounds.ts';

const rapier = await loadRapier();
const SCALE = TABLE_SOLVER.worldScale;
const RIM = COIN_MATERIAL.rimRadius;
const shape = new rapier.RoundCylinder(
  (COIN.halfThickness - RIM) * SCALE,
  (COIN.radius - RIM) * SCALE,
  RIM * SCALE,
);
const CORE_HALF = COIN.halfThickness - RIM;
const CORE_RADIUS = COIN.radius - RIM;
/** How far Rapier's distance was seen to stray from the true one, with headroom. */
const RAPIER_SLACK = 0.00015;
const RAPIER_SLACK_PER_METRE = 0.1;
const FLAT: Rotation = { x: 0, y: 0, z: 0, w: 1 };

const scaled = (p: Vector): Vector => ({ x: p.x * SCALE, y: p.y * SCALE, z: p.z * SCALE });

function exact(pa: Vector, qa: Rotation, pb: Vector, qb: Rotation): number {
  const hit = shape.contactShape(scaled(pa), qa, shape, scaled(pb), qb, 1);
  if (!hit) {
    throw new Error('exact: coins out of query range');
  }
  return hit.distance / SCALE;
}

/**
 * Whether p lies on the coin's core cylinder, read in the coin's own frame by turning
 * p - centre back through the conjugate rotation (v + 2w(u x v) + 2u x (u x v), u = -q.xyz).
 */
function onCore(centre: Vector, q: Rotation, p: Vector): boolean {
  const vx = p.x - centre.x;
  const vy = p.y - centre.y;
  const vz = p.z - centre.z;
  const [ux, uy, uz] = [-q.x, -q.y, -q.z];
  const cx = uy * vz - uz * vy;
  const cy = uz * vx - ux * vz;
  const cz = ux * vy - uy * vx;
  const lx = vx + 2 * q.w * cx + 2 * (uy * cz - uz * cy);
  const ly = vy + 2 * q.w * cy + 2 * (uz * cx - ux * cz);
  const lz = vz + 2 * q.w * cz + 2 * (ux * cy - uy * cx);
  const slack = 1e-12;
  return Math.abs(ly) <= CORE_HALF + slack && Math.sqrt(lx * lx + lz * lz) <= CORE_RADIUS + slack;
}

function randomRotation(rng: Xoshiro128ss, tilt: number): Rotation {
  const x = rng.nextRange(-tilt, tilt);
  const y = rng.nextRange(-1, 1);
  const z = rng.nextRange(-tilt, tilt);
  const norm = Math.sqrt(x * x + y * y + z * z + 1);
  return { x: x / norm, y: y / norm, z: z / norm, w: 1 / norm };
}

describe('coin distance bounds', () => {
  it('bracket the true distance of the collider shapes, whatever the poses', () => {
    const rng = Xoshiro128ss.fromSeed(0xb0d5);
    let tight = 0;
    const trials = 2000;
    for (let i = 0; i < trials; i++) {
      const tilt = i % 2 === 0 ? 0.1 : 3;
      const pa = { x: 0, y: 0, z: 0 };
      const pb = {
        x: rng.nextRange(-0.03, 0.03),
        y: rng.nextRange(-0.006, 0.006),
        z: rng.nextRange(-0.03, 0.03),
      };
      const qa = randomRotation(rng, tilt);
      const qb = randomRotation(rng, tilt);
      const a = coinFrame(pa, qa);
      const b = coinFrame(pb, qb);
      const lower = distanceLowerBound(a, b);
      const upper = distanceUpperBound(a, b);
      // Rapier's iterative query on these rounded shapes reads up to about 0.4 mm long
      // when the coins are tilted against each other, so the upper bound is proven by its witnesses instead: a point on
      // each core, whose rim-sized balls lie inside the coins.
      const { onA, onB } = nearCorePoints(a, b);
      expect(onCore(pa, qa, onA)).toBe(true);
      expect(onCore(pb, qb, onB)).toBe(true);
      const [wx, wy, wz] = [onB.x - onA.x, onB.y - onA.y, onB.z - onA.z];
      const witnessed = Math.sqrt(wx * wx + wy * wy + wz * wz);
      expect(upper).toBeCloseTo(witnessed - 2 * RIM, 12);
      const truth = exact(pa, qa, pb, qb);
      const slack = RAPIER_SLACK + Math.abs(truth) * RAPIER_SLACK_PER_METRE;
      // Both bounds speak only to separated coins: an overlap's depth is neither.
      if (lower > 0) {
        expect(lower).toBeLessThanOrEqual(upper + 1e-12);
        expect(lower).toBeLessThanOrEqual(truth + slack);
      }
      if (truth > 0 && upper - truth < 0.0002) {
        tight += 1;
      }
    }
    expect(tight).toBeGreaterThan(trials / 4);
  });

  it('settle whether two coins are within a gap as the true distance does', () => {
    const rng = Xoshiro128ss.fromSeed(0x9a95);
    const gap = 0.001;
    let touching = 0;
    let apart = 0;
    for (let i = 0; i < 3000; i++) {
      const tilt = i % 2 === 0 ? 0.1 : 3;
      const pa = { x: 0, y: 0, z: 0 };
      const pb = {
        x: rng.nextRange(-0.03, 0.03),
        y: rng.nextRange(-0.006, 0.006),
        z: rng.nextRange(-0.03, 0.03),
      };
      const qa = randomRotation(rng, tilt);
      const qb = randomRotation(rng, tilt);
      const a = coinFrame(pa, qa);
      const b = coinFrame(pb, qb);
      const within = withinGap(a, b, gap);
      expect(withinGap(a, b, gap)).toBe(within);
      if (distanceUpperBound(a, b) <= gap) {
        expect(within).toBe(true);
      }
      // Rapier mostly reads long on tilted pairs (see above), so it vouches only for a
      // pair being within the gap, and only where the shadows do not prove a wider one:
      // it has been seen to read a pair 0.35 mm apart as overlapping.
      if (distanceLowerBound(a, b) > gap) {
        expect(within).toBe(false);
        apart += 1;
      } else if (exact(pa, qa, pb, qb) <= gap) {
        expect(within).toBe(true);
        touching += 1;
      }
    }
    expect(touching).toBeGreaterThan(300);
    expect(apart).toBeGreaterThan(300);
  });

  it('are exact for flat coins side by side and stacked', () => {
    const a = coinFrame({ x: 0, y: 0, z: 0 }, FLAT);
    const beside = coinFrame({ x: 2 * COIN.radius + 0.0005, y: 0, z: 0 }, FLAT);
    const above = coinFrame({ x: 0.004, y: 2 * COIN.halfThickness + 0.0005, z: 0 }, FLAT);
    for (const b of [beside, above]) {
      expect(distanceLowerBound(a, b)).toBeCloseTo(0.0005, 9);
      expect(distanceUpperBound(a, b)).toBeCloseTo(0.0005, 9);
    }
  });

  it('read the face normal from the rotation', () => {
    const half = Math.sqrt(0.5);
    expect(coinFrame({ x: 0, y: 0, z: 0 }, FLAT).axis).toEqual({ x: 0, y: 1, z: 0 });
    const onEdge = coinFrame({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: half, w: half }).axis;
    expect(onEdge.x).toBeCloseTo(-1, 12);
    expect(onEdge.y).toBeCloseTo(0, 12);
  });
});
