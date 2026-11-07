import type { Rotation, Vector } from '@dimforge/rapier3d-deterministic-compat';
import { COIN } from '../coin.ts';
import { COIN_MATERIAL } from '../table/tuning.ts';

const RIM = COIN_MATERIAL.rimRadius;
/** The coin collider is this cylinder grown by a ball of the rim radius. */
const CORE_HALF = COIN.halfThickness - RIM;
const CORE_RADIUS = COIN.radius - RIM;
const PROJECTIONS = 6;

interface Point {
  x: number;
  y: number;
  z: number;
}

/** A coin's centre and face normal, in metres. */
export interface CoinFrame {
  readonly centre: Readonly<Vector>;
  readonly axis: Readonly<Vector>;
}

export function coinFrame(centre: Readonly<Vector>, q: Readonly<Rotation>): CoinFrame {
  return {
    centre,
    axis: {
      x: 2 * (q.x * q.y - q.w * q.z),
      y: 1 - 2 * (q.x * q.x + q.z * q.z),
      z: 2 * (q.y * q.z + q.w * q.x),
    },
  };
}

/** How far the coin reaches along the unit vector (ux, uy, uz) from its centre. */
function support(axis: Readonly<Vector>, ux: number, uy: number, uz: number): number {
  const along = Math.abs(axis.x * ux + axis.y * uy + axis.z * uz);
  return CORE_HALF * along + CORE_RADIUS * Math.sqrt(Math.max(0, 1 - along * along)) + RIM;
}

/**
 * A lower bound on the surface distance of two coins, in metres: the widest gap
 * between their shadows on the line between their centres and on either face normal.
 * Never above the true distance; negative when the shadows overlap on every one.
 */
export function distanceLowerBound(a: CoinFrame, b: CoinFrame): number {
  const dx = b.centre.x - a.centre.x;
  const dy = b.centre.y - a.centre.y;
  const dz = b.centre.z - a.centre.z;
  const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
  let best = Number.NEGATIVE_INFINITY;
  const gapAlong = (ux: number, uy: number, uz: number): void => {
    const apart = Math.abs(dx * ux + dy * uy + dz * uz);
    best = Math.max(best, apart - support(a.axis, ux, uy, uz) - support(b.axis, ux, uy, uz));
  };
  if (length > 0) {
    gapAlong(dx / length, dy / length, dz / length);
  }
  gapAlong(a.axis.x, a.axis.y, a.axis.z);
  gapAlong(b.axis.x, b.axis.y, b.axis.z);
  return best;
}

/** The point of a coin's core cylinder nearest to p, written into out. */
function nearestOnCore(coin: CoinFrame, p: Readonly<Point>, out: Point): Point {
  const { centre: c, axis: n } = coin;
  const vx = p.x - c.x;
  const vy = p.y - c.y;
  const vz = p.z - c.z;
  const along = vx * n.x + vy * n.y + vz * n.z;
  let wx = vx - along * n.x;
  let wy = vy - along * n.y;
  let wz = vz - along * n.z;
  const radial = Math.sqrt(wx * wx + wy * wy + wz * wz);
  if (radial > CORE_RADIUS) {
    const shrink = CORE_RADIUS / radial;
    wx *= shrink;
    wy *= shrink;
    wz *= shrink;
  }
  const t = Math.min(CORE_HALF, Math.max(-CORE_HALF, along));
  out.x = c.x + t * n.x + wx;
  out.y = c.y + t * n.y + wy;
  out.z = c.z + t * n.z + wz;
  return out;
}

/**
 * A point on each coin's core, found by projecting back and forth between the two
 * cores a few times. Each projection only brings the points closer.
 */
export function nearCorePoints(a: CoinFrame, b: CoinFrame): { onA: Point; onB: Point } {
  const onA: Point = { x: 0, y: 0, z: 0 };
  const onB: Point = { x: b.centre.x, y: b.centre.y, z: b.centre.z };
  for (let i = 0; i < PROJECTIONS; i++) {
    nearestOnCore(a, onB, onA);
    nearestOnCore(b, onA, onB);
  }
  return { onA, onB };
}

/**
 * An upper bound on the surface distance of two coins, in metres: the distance of
 * the nearCorePoints less both rims. A rim's ball around a core point lies inside the
 * coin, so it is never below the true distance, and for coins lying on or beside each
 * other it is within a hair of it.
 */
export function distanceUpperBound(a: CoinFrame, b: CoinFrame): number {
  const { onA, onB } = nearCorePoints(a, b);
  const dx = onB.x - onA.x;
  const dy = onB.y - onA.y;
  const dz = onB.z - onA.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - 2 * RIM;
}
