import { fields, numberAbove, oneOf, vec3 } from './params.ts';

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface Quat {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

/**
 * A prop's collider in its own frame, in metres, centred on the prop's translation.
 * Cylinders and capsules stand along their local y axis.
 */
export type PropShape =
  | { readonly kind: 'box'; readonly halfExtents: Vec3 }
  | { readonly kind: 'cylinder'; readonly halfHeight: number; readonly radius: number }
  | { readonly kind: 'ball'; readonly radius: number }
  | { readonly kind: 'capsule'; readonly halfHeight: number; readonly radius: number };

export const PROP_SHAPE_KINDS = ['box', 'cylinder', 'ball', 'capsule'] as const;

/** The largest half extent a prop shape may have along any axis. */
export const MAX_PROP_EXTENT = 0.1;
/** The smallest, so every prop is thicker than a coin's contact skin many times over. */
export const MIN_PROP_EXTENT = 0.001;

function extent(value: unknown, what: string): number {
  const n = numberAbove(value, what, 0, MAX_PROP_EXTENT);
  if (n < MIN_PROP_EXTENT) {
    throw new RangeError(`${what} must be at least ${MIN_PROP_EXTENT} m, got ${n}`);
  }
  return n;
}

export function parseShape(raw: unknown, what: string): PropShape {
  const kind = oneOf(
    fields(raw, what, ['kind', 'halfExtents', 'halfHeight', 'radius']).kind,
    `${what}.kind`,
    PROP_SHAPE_KINDS,
  );
  switch (kind) {
    case 'box': {
      const f = fields(raw, what, ['kind', 'halfExtents']);
      const h = vec3(f.halfExtents, `${what}.halfExtents`, MAX_PROP_EXTENT);
      return {
        kind,
        halfExtents: {
          x: extent(h.x, `${what}.halfExtents.x`),
          y: extent(h.y, `${what}.halfExtents.y`),
          z: extent(h.z, `${what}.halfExtents.z`),
        },
      };
    }
    case 'cylinder':
    case 'capsule': {
      const f = fields(raw, what, ['kind', 'halfHeight', 'radius']);
      return {
        kind,
        halfHeight: extent(f.halfHeight, `${what}.halfHeight`),
        radius: extent(f.radius, `${what}.radius`),
      };
    }
    case 'ball': {
      const f = fields(raw, what, ['kind', 'radius']);
      return { kind, radius: extent(f.radius, `${what}.radius`) };
    }
  }
}

/** The radius of the smallest sphere about the prop's centre that holds its shape. */
export function boundingRadius(shape: PropShape): number {
  switch (shape.kind) {
    case 'box': {
      const { x, y, z } = shape.halfExtents;
      return Math.sqrt(x * x + y * y + z * z);
    }
    case 'cylinder':
      return Math.sqrt(shape.halfHeight * shape.halfHeight + shape.radius * shape.radius);
    case 'ball':
      return shape.radius;
    case 'capsule':
      return shape.halfHeight + shape.radius;
  }
}

/** `v` turned by the unit quaternion `q`. */
export function rotate(q: Quat, v: Vec3): Vec3 {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

export function conjugate(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

/** The rotation `a` after `b`. */
export function multiply(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

function rounded(qx: number, qy: number): number {
  const ox = qx > 0 ? qx : 0;
  const oy = qy > 0 ? qy : 0;
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0);
}

/**
 * Signed distance from `point` (in the prop's frame) to the shape's surface: positive
 * outside, zero on it, negative inside.
 */
export function signedDistance(shape: PropShape, point: Vec3): number {
  switch (shape.kind) {
    case 'box': {
      const h = shape.halfExtents;
      const qx = Math.abs(point.x) - h.x;
      const qy = Math.abs(point.y) - h.y;
      const qz = Math.abs(point.z) - h.z;
      const ox = qx > 0 ? qx : 0;
      const oy = qy > 0 ? qy : 0;
      const oz = qz > 0 ? qz : 0;
      return Math.sqrt(ox * ox + oy * oy + oz * oz) + Math.min(Math.max(qx, qy, qz), 0);
    }
    case 'cylinder': {
      const radial = Math.sqrt(point.x * point.x + point.z * point.z);
      return rounded(radial - shape.radius, Math.abs(point.y) - shape.halfHeight);
    }
    case 'ball':
      return Math.sqrt(point.x * point.x + point.y * point.y + point.z * point.z) - shape.radius;
    case 'capsule': {
      const y = Math.min(Math.max(point.y, -shape.halfHeight), shape.halfHeight);
      const dy = point.y - y;
      return Math.sqrt(point.x * point.x + dy * dy + point.z * point.z) - shape.radius;
    }
  }
}

/** Signed distance from a world `point` to the shape placed at `translation` and `rotation`. */
export function distanceAt(
  shape: PropShape,
  translation: Vec3,
  rotation: Quat,
  point: Vec3,
): number {
  const local = rotate(conjugate(rotation), {
    x: point.x - translation.x,
    y: point.y - translation.y,
    z: point.z - translation.z,
  });
  return signedDistance(shape, local);
}
