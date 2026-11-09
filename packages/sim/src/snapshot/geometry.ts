/**
 * Penetration depth between coins and boxes without Rapier, for the pose checks the
 * server runs and for laying a restored table. Both shapes are convex and symmetric
 * about their centres, so the depth is the least overlap of their extents along any
 * direction, and a negative depth is the gap between them. The least overlap is found
 * by a local search over directions, seeded with every axis that can be the answer for
 * two flat coins or a coin and a box. Built from + − * / and sqrt only, so V8 and
 * JavaScriptCore agree bit for bit. Units are the caller's.
 */

/** A coin's dimensions: a cylinder core swept by a sphere of radius `rim`. */
export interface DiscShape {
  readonly coreHalfHeight: number;
  readonly coreRadius: number;
  readonly rim: number;
}

/** A coin's centre and the unit normal of its faces. */
export interface Disc {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly ax: number;
  readonly ay: number;
  readonly az: number;
}

/** An axis-aligned box by its centre and half extents. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly hx: number;
  readonly hy: number;
  readonly hz: number;
}

const FIRST_STEP = 0.2;
const LAST_STEP = 0.005;
const NUDGES = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/** The unit face normal of a coin turned by the unit quaternion (x, y, z, w). */
export function discAxis(
  x: number,
  y: number,
  z: number,
  w: number,
): { ax: number; ay: number; az: number } {
  return {
    ax: 2 * (x * y - w * z),
    ay: 1 - 2 * (x * x + z * z),
    az: 2 * (y * z + w * x),
  };
}

/** Furthest a coin reaches from its centre: the radius of the sphere around it. */
export function discReach(shape: DiscShape): number {
  const { coreHalfHeight: h, coreRadius: r } = shape;
  return Math.sqrt(h * h + r * r) + shape.rim;
}

function discExtent(shape: DiscShape, disc: Disc, dx: number, dy: number, dz: number): number {
  const along = dx * disc.ax + dy * disc.ay + dz * disc.az;
  const across = 1 - along * along;
  return (
    shape.coreHalfHeight * Math.abs(along) +
    shape.coreRadius * Math.sqrt(across > 0 ? across : 0) +
    shape.rim
  );
}

function boxExtent(box: Box, dx: number, dy: number, dz: number): number {
  return box.hx * Math.abs(dx) + box.hy * Math.abs(dy) + box.hz * Math.abs(dz);
}

type Overlap = (dx: number, dy: number, dz: number) => number;

function leastOverlap(
  overlap: Overlap,
  seeds: readonly (readonly [number, number, number])[],
): number {
  let best = Infinity;
  let nx = 0;
  let ny = 1;
  let nz = 0;
  for (const [x, y, z] of seeds) {
    const length = Math.sqrt(x * x + y * y + z * z);
    if (!(length > 1e-9)) {
      continue;
    }
    const o = overlap(x / length, y / length, z / length);
    if (o < best) {
      best = o;
      nx = x / length;
      ny = y / length;
      nz = z / length;
    }
  }
  for (let step = FIRST_STEP; step >= LAST_STEP; step /= 2) {
    let improved = true;
    while (improved) {
      improved = false;
      let ux: number;
      let uy: number;
      let uz: number;
      if (Math.abs(nx) < 0.5) {
        ux = 0;
        uy = nz;
        uz = -ny;
      } else {
        ux = -nz;
        uy = 0;
        uz = nx;
      }
      const u = Math.sqrt(ux * ux + uy * uy + uz * uz);
      ux /= u;
      uy /= u;
      uz /= u;
      const vx = ny * uz - nz * uy;
      const vy = nz * ux - nx * uz;
      const vz = nx * uy - ny * ux;
      for (const [p, q] of NUDGES) {
        const mx = nx + step * (p * ux + q * vx);
        const my = ny + step * (p * uy + q * vy);
        const mz = nz + step * (p * uz + q * vz);
        const m = Math.sqrt(mx * mx + my * my + mz * mz);
        const o = overlap(mx / m, my / m, mz / m);
        if (o < best) {
          best = o;
          nx = mx / m;
          ny = my / m;
          nz = mz / m;
          improved = true;
          break;
        }
      }
    }
  }
  return best;
}

/** How deep two coins of `shape` interpenetrate; negative while apart. */
export function discDiscDepth(shape: DiscShape, a: Disc, b: Disc): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  return leastOverlap(
    (x, y, z) =>
      discExtent(shape, a, x, y, z) +
      discExtent(shape, b, x, y, z) -
      Math.abs(x * dx + y * dy + z * dz),
    [
      [a.ax, a.ay, a.az],
      [b.ax, b.ay, b.az],
      [dx, dy, dz],
      [dx, 0, dz],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
  );
}

/** How deep a coin of `shape` and an axis-aligned box interpenetrate; negative while apart. */
export function discBoxDepth(shape: DiscShape, disc: Disc, box: Box): number {
  const dx = box.x - disc.x;
  const dy = box.y - disc.y;
  const dz = box.z - disc.z;
  return leastOverlap(
    (x, y, z) =>
      discExtent(shape, disc, x, y, z) +
      boxExtent(box, x, y, z) -
      Math.abs(x * dx + y * dy + z * dz),
    [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [disc.ax, disc.ay, disc.az],
      [dx, dy, dz],
      [0, dy, dz],
      [dx, dy, 0],
    ],
  );
}
