import { BufferGeometry, Float32BufferAttribute, Vector2, Vector3 } from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * A 2D moulding cross-section in (s, t): s runs across the moulding, t protrudes from the
 * surface it sits on. Points are ordered clockwise so the outward normal is on the left of
 * the direction of travel.
 */
export type Profile = readonly Vector2[];

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new RangeError(`Index ${index} is outside 0..${items.length - 1}`);
  return item;
}

export function halfRoundProfile(radius: number, segments = 12): Profile {
  const points: Vector2[] = [];
  for (let i = 0; i <= segments; i += 1) {
    const a = Math.PI - (Math.PI * i) / segments;
    points.push(new Vector2(Math.cos(a) * radius, Math.sin(a) * radius));
  }
  return points;
}

export function roundProfile(radius: number, segments = 16): Profile {
  const points: Vector2[] = [];
  for (let i = 0; i <= segments; i += 1) {
    const a = Math.PI * 2 - (Math.PI * 2 * i) / segments;
    points.push(new Vector2(Math.cos(a) * radius, Math.sin(a) * radius));
  }
  return points;
}

/**
 * Classic bolection-style moulding: a fillet, a cove, then a proud bead on the outer edge.
 * Width runs from s = 0 to s = width.
 */
export function beadAndCoveProfile(width: number, height: number, segments = 8): Profile {
  const points: Vector2[] = [new Vector2(0, 0), new Vector2(0, height * 0.35)];
  const coveEnd = width * 0.45;
  for (let i = 1; i <= segments; i += 1) {
    const a = (Math.PI / 2) * (i / segments);
    points.push(
      new Vector2(coveEnd * Math.sin(a), height * 0.35 + height * 0.25 * (1 - Math.cos(a))),
    );
  }
  const beadRadius = (width - coveEnd) / 2;
  const beadCentre = new Vector2(coveEnd + beadRadius, height - beadRadius);
  for (let i = 0; i <= segments * 2; i += 1) {
    const a = Math.PI - (Math.PI * 1.5 * i) / (segments * 2);
    points.push(
      new Vector2(beadCentre.x + Math.cos(a) * beadRadius, beadCentre.y + Math.sin(a) * beadRadius),
    );
  }
  points.push(new Vector2(width, 0));
  return points;
}

/**
 * A rounded rectangle in the plane spanned by `xAxis` and `yAxis` around `centre`, sampled
 * so that a swept profile turns its corners smoothly.
 */
export function roundedRectPath(
  centre: Vector3,
  xAxis: Vector3,
  yAxis: Vector3,
  width: number,
  height: number,
  radius: number,
  cornerSegments = 6,
): Vector3[] {
  const r = Math.min(radius, width / 2, height / 2);
  const hx = width / 2 - r;
  const hy = height / 2 - r;
  const corners: [number, number, number][] = [
    [hx, hy, 0],
    [-hx, hy, Math.PI / 2],
    [-hx, -hy, Math.PI],
    [hx, -hy, (Math.PI * 3) / 2],
  ];
  const points: Vector3[] = [];
  for (const [cx, cy, start] of corners) {
    for (let i = 0; i <= cornerSegments; i += 1) {
      const a = start + ((Math.PI / 2) * i) / cornerSegments;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      points.push(centre.clone().addScaledVector(xAxis, x).addScaledVector(yAxis, y));
    }
  }
  return points;
}

export interface SweepOptions {
  /** Direction the profile's t axis protrudes towards (the surface normal it sits on). */
  readonly up: Vector3;
  readonly closed?: boolean;
  /** Flip the profile's s axis, for mouldings whose bead must face the other way. */
  readonly mirror?: boolean;
}

/**
 * Sweeps a profile along a polyline. U is arc length along the path in metres and V is arc
 * length around the profile, so brushed materials can rely on the UV tangent frame.
 */
export function sweepProfile(
  path: readonly Vector3[],
  profile: Profile,
  options: SweepOptions,
): BufferGeometry {
  const closed = options.closed ?? false;
  const count = path.length;
  if (count < 2) throw new Error('sweepProfile needs a path of at least two points');
  if (profile.length < 2) throw new Error('sweepProfile needs a profile of at least two points');
  const pathPoints = closed ? [...path, at(path, 0)] : [...path];
  const rings = pathPoints.length;
  const sign = options.mirror ? -1 : 1;

  const profileNormals = profile.map((_, j) => {
    const prev = at(profile, Math.max(j - 1, 0));
    const next = at(profile, Math.min(j + 1, profile.length - 1));
    const d = next.clone().sub(prev).normalize();
    return new Vector2(-d.y, d.x);
  });
  const profileLength: number[] = [0];
  for (let j = 1; j < profile.length; j += 1) {
    profileLength.push(at(profileLength, j - 1) + at(profile, j).distanceTo(at(profile, j - 1)));
  }

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const tangent = new Vector3();
  const side = new Vector3();
  const up = new Vector3();
  let travelled = 0;

  for (let i = 0; i < rings; i += 1) {
    const here = at(pathPoints, i);
    const prev = at(pathPoints, i === 0 ? (closed ? count - 1 : 0) : i - 1);
    const next = at(pathPoints, i === rings - 1 ? (closed ? 1 : rings - 1) : i + 1);
    tangent.subVectors(next, prev).normalize();
    if (i > 0) travelled += here.distanceTo(at(pathPoints, i - 1));
    up.copy(options.up).addScaledVector(tangent, -options.up.dot(tangent)).normalize();
    side.crossVectors(tangent, up).multiplyScalar(sign);

    for (let j = 0; j < profile.length; j += 1) {
      const { x: s, y: t } = at(profile, j);
      const n = at(profileNormals, j);
      positions.push(
        here.x + side.x * s + up.x * t,
        here.y + side.y * s + up.y * t,
        here.z + side.z * s + up.z * t,
      );
      normals.push(side.x * n.x + up.x * n.y, side.y * n.x + up.y * n.y, side.z * n.x + up.z * n.y);
      uvs.push(travelled, at(profileLength, j));
    }
  }

  const stride = profile.length;
  for (let i = 0; i < rings - 1; i += 1) {
    for (let j = 0; j < stride - 1; j += 1) {
      const a = i * stride + j;
      const b = a + stride;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  orientOutward(geometry);
  return geometry;
}

/** Flips the winding when the first face points against its vertex normals. */
function orientOutward(geometry: BufferGeometry): void {
  const index = geometry.getIndex();
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  if (!index || index.count < 3) return;
  const a = new Vector3().fromBufferAttribute(position, index.getX(0));
  const b = new Vector3().fromBufferAttribute(position, index.getX(1));
  const c = new Vector3().fromBufferAttribute(position, index.getX(2));
  const face = new Vector3().crossVectors(b.sub(a), c.sub(a));
  const n = new Vector3().fromBufferAttribute(normal, index.getX(0));
  if (face.dot(n) >= 0) return;
  const array = index.array;
  for (let i = 0; i < array.length; i += 3) {
    const b = array[i + 1] ?? 0;
    array[i + 1] = array[i + 2] ?? 0;
    array[i + 2] = b;
  }
  index.needsUpdate = true;
}

export function line(from: Vector3, to: Vector3): Vector3[] {
  return [from.clone(), to.clone()];
}

/** A box with rounded edges, positioned by its centre. */
export function roundedBox(
  size: Vector3,
  centre: Vector3,
  radius: number,
  segments = 3,
): BufferGeometry {
  const geometry = new RoundedBoxGeometry(size.x, size.y, size.z, segments, radius);
  geometry.translate(centre.x, centre.y, centre.z);
  return geometry;
}

/** Merges pieces that share one material into a single draw call. */
export function mergeAll(pieces: BufferGeometry[], label: string): BufferGeometry {
  for (const piece of pieces) {
    if (!piece.index) {
      piece.setIndex(Array.from({ length: piece.getAttribute('position').count }, (_, i) => i));
    }
    for (const name of Object.keys(piece.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') piece.deleteAttribute(name);
    }
  }
  // mergeGeometries is typed as non-null but returns null when the pieces' attributes differ.
  const merged = mergeGeometries(pieces, false) as BufferGeometry | null;
  for (const piece of pieces) piece.dispose();
  if (!merged)
    throw new Error(`Could not merge the ${label} geometry; pieces have mismatched attributes`);
  merged.name = label;
  merged.computeBoundingSphere();
  merged.computeBoundingBox();
  return merged;
}
