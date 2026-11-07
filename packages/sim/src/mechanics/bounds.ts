import type { Rotation, Vector } from '@dimforge/rapier3d-deterministic-compat';
import { COIN } from '../coin.ts';
import { COIN_MATERIAL } from '../table/tuning.ts';

const RIM = COIN_MATERIAL.rimRadius;
/** The coin collider is this cylinder grown by a ball of the rim radius. */
const CORE_HALF = COIN.halfThickness - RIM;
const CORE_RADIUS = COIN.radius - RIM;
const PROJECTIONS = 6;
/** Rounds of projection withinGap runs before it settles on the middle of its bracket. */
const MAX_REFINEMENTS = 32;
/** The longest stride extrapolate tries, in multiples of the last projection step. */
const MAX_STRIDE = 1024;

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
  const na = a.axis;
  const nb = b.axis;
  let best = Math.max(
    gapAlong(dx, dy, dz, a, b, na.x, na.y, na.z),
    gapAlong(dx, dy, dz, a, b, nb.x, nb.y, nb.z),
  );
  if (length > 0) {
    best = Math.max(best, gapAlong(dx, dy, dz, a, b, dx / length, dy / length, dz / length));
  }
  return best;
}

/** The gap between the shadows of two coins `(dx, dy, dz)` apart on the unit vector u. */
function gapAlong(
  dx: number,
  dy: number,
  dz: number,
  a: CoinFrame,
  b: CoinFrame,
  ux: number,
  uy: number,
  uz: number,
): number {
  return (
    Math.abs(dx * ux + dy * uy + dz * uz) -
    support(a.axis, ux, uy, uz) -
    support(b.axis, ux, uy, uz)
  );
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

function between(p: Readonly<Point>, q: Readonly<Point>): number {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const dz = q.z - p.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** The point of a coin's core cylinder reaching furthest along the unit vector u. */
function supportOnCore(coin: CoinFrame, ux: number, uy: number, uz: number, out: Point): Point {
  const { centre: c, axis: n } = coin;
  const along = ux * n.x + uy * n.y + uz * n.z;
  const wx = ux - along * n.x;
  const wy = uy - along * n.y;
  const wz = uz - along * n.z;
  const radial = Math.sqrt(wx * wx + wy * wy + wz * wz);
  const reach = radial > 0 ? CORE_RADIUS / radial : 0;
  const t = along >= 0 ? CORE_HALF : -CORE_HALF;
  out.x = c.x + t * n.x + wx * reach;
  out.y = c.y + t * n.y + wy * reach;
  out.z = c.z + t * n.z + wz * reach;
  return out;
}

/**
 * Starts the projection from the edge of one coin that reaches furthest towards the
 * other's face, if that pair is nearer than the one in (onA, onB). Projecting back and
 * forth from the centres slides along nearly parallel faces at a crawl, while the
 * nearest pair of two faces lying on each other is at such an edge point.
 */
function seedFromFace(
  from: CoinFrame,
  face: CoinFrame,
  onFrom: Point,
  onFace: Point,
  best: number,
): number {
  const n = face.axis;
  const toFace =
    (face.centre.x - from.centre.x) * n.x +
      (face.centre.y - from.centre.y) * n.y +
      (face.centre.z - from.centre.z) * n.z >=
    0
      ? 1
      : -1;
  const edge = supportOnCore(from, toFace * n.x, toFace * n.y, toFace * n.z, seedEdge);
  const near = nearestOnCore(face, edge, seedNear);
  const length = between(edge, near);
  if (length >= best) {
    return best;
  }
  onFrom.x = edge.x;
  onFrom.y = edge.y;
  onFrom.z = edge.z;
  onFace.x = near.x;
  onFace.y = near.y;
  onFace.z = near.z;
  return length;
}

/**
 * Pushes onA on along its last step (from `was`), doubling the stride while the pair
 * keeps getting nearer. Where both surfaces are nearly flat around the nearest pair,
 * plain projection only creeps towards it, a shorter step every round.
 */
function extrapolate(a: CoinFrame, b: CoinFrame, onA: Point, onB: Point, was: Point): void {
  const sx = onA.x - was.x;
  const sy = onA.y - was.y;
  const sz = onA.z - was.z;
  let best = between(onA, onB);
  for (let stride = 2; stride <= MAX_STRIDE; stride *= 2) {
    probe.x = onA.x + stride * sx;
    probe.y = onA.y + stride * sy;
    probe.z = onA.z + stride * sz;
    const aimA = nearestOnCore(a, probe, probeA);
    const aimB = nearestOnCore(b, aimA, probeB);
    const length = between(aimA, aimB);
    if (length >= best) {
      return;
    }
    best = length;
    onA.x = aimA.x;
    onA.y = aimA.y;
    onA.z = aimA.z;
    onB.x = aimB.x;
    onB.y = aimB.y;
    onB.z = aimB.z;
  }
}

const scratchA: Point = { x: 0, y: 0, z: 0 };
const scratchB: Point = { x: 0, y: 0, z: 0 };
const seedEdge: Point = { x: 0, y: 0, z: 0 };
const seedNear: Point = { x: 0, y: 0, z: 0 };
const lastA: Point = { x: 0, y: 0, z: 0 };
const probe: Point = { x: 0, y: 0, z: 0 };
const probeA: Point = { x: 0, y: 0, z: 0 };
const probeB: Point = { x: 0, y: 0, z: 0 };

/**
 * Whether the surface distance of two coins is at most `gap` metres, from their poses
 * alone. Both bounds above are refined until one of them settles it: each round of
 * projection between the cores brings the near points closer (the upper bound), and
 * the line through them is an axis to read the shadow gap on (the lower bound), which
 * meets the true distance as the points meet the nearest pair. The projection starts
 * from the nearest of the centres and the face edges (seedFromFace). A pair still undecided
 * after MAX_REFINEMENTS rounds is within a hair of the gap and is settled by the
 * middle of the bracket, so the answer is always a pure function of the two poses.
 */
export function withinGap(a: CoinFrame, b: CoinFrame, gap: number): boolean {
  const dx = b.centre.x - a.centre.x;
  const dy = b.centre.y - a.centre.y;
  const dz = b.centre.z - a.centre.z;
  const onA = scratchA;
  const onB = scratchB;
  onB.x = b.centre.x;
  onB.y = b.centre.y;
  onB.z = b.centre.z;
  nearestOnCore(a, onB, onA);
  let start = between(onA, onB);
  start = seedFromFace(a, b, onA, onB, start);
  seedFromFace(b, a, onB, onA, start);
  let lower = Number.NEGATIVE_INFINITY;
  let upper = Number.POSITIVE_INFINITY;
  for (let i = 0; i < MAX_REFINEMENTS; i++) {
    lastA.x = onA.x;
    lastA.y = onA.y;
    lastA.z = onA.z;
    nearestOnCore(b, onA, onB);
    nearestOnCore(a, onB, onA);
    extrapolate(a, b, onA, onB, lastA);
    const wx = onB.x - onA.x;
    const wy = onB.y - onA.y;
    const wz = onB.z - onA.z;
    const length = Math.sqrt(wx * wx + wy * wy + wz * wz);
    upper = Math.min(upper, length - 2 * RIM);
    if (upper <= gap) {
      return true;
    }
    lower = Math.max(lower, gapAlong(dx, dy, dz, a, b, wx / length, wy / length, wz / length));
    if (i === 0) {
      lower = Math.max(lower, distanceLowerBound(a, b));
    }
    if (lower > gap) {
      return false;
    }
  }
  return (lower + upper) / 2 <= gap;
}
