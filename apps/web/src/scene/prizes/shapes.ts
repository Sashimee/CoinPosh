import {
  BufferAttribute,
  type BufferGeometry,
  CatmullRomCurve3,
  Color,
  Euler,
  LatheGeometry,
  Matrix4,
  Quaternion,
  TubeGeometry,
  Vector2,
  Vector3,
} from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Per-vertex finish read by every prize material: `metal` blends enamel into metal, `rough`
 * is the base roughness, `brush` streaks it (anisotropic brushing on metal, sheen on cloth)
 * and `coat` lays a lacquer clearcoat on top, or marks stitching thread on leather.
 */
export interface Finish {
  readonly metal?: number;
  readonly rough?: number;
  readonly brush?: number;
  readonly coat?: number;
}

/** Engine-turned decoration read from the part's UVs; `none` leaves the surface plain. */
export const PATTERNS = { none: 0, sunburst: 1, clous: 2, grain: 3 } as const;
export type Pattern = keyof typeof PATTERNS;

/** Attribute names every merged prize geometry carries, so any two parts can merge. */
const KEPT = ['position', 'normal', 'uv', 'color', 'finish', 'pattern'] as const;

export type Profile = readonly (readonly [radius: number, y: number])[];

export function lathe(profile: Profile, segments: number): BufferGeometry {
  return new LatheGeometry(
    profile.map(([r, y]) => new Vector2(Math.max(r, 0), y)),
    segments,
  );
}

export function tube(
  points: readonly (readonly [number, number, number])[],
  radius: number,
  tubular: number,
  radial: number,
  closed = false,
): BufferGeometry {
  const curve = new CatmullRomCurve3(
    points.map(([x, y, z]) => new Vector3(x, y, z)),
    closed,
  );
  return new TubeGeometry(curve, tubular, radius, radial, closed);
}

/** The outline of a rounded rectangle in the XZ plane at height `y`, as a closed point loop. */
export function roundedRectLoop(
  halfX: number,
  halfZ: number,
  corner: number,
  y: number,
  perCorner = 6,
): [number, number, number][] {
  const points: [number, number, number][] = [];
  const centres: readonly (readonly [number, number, number])[] = [
    [halfX - corner, halfZ - corner, 0],
    [-(halfX - corner), halfZ - corner, Math.PI / 2],
    [-(halfX - corner), -(halfZ - corner), Math.PI],
    [halfX - corner, -(halfZ - corner), (3 * Math.PI) / 2],
  ];
  for (const [cx, cz, start] of centres) {
    for (let i = 0; i <= perCorner; i += 1) {
      const a = start + (i / perCorner) * (Math.PI / 2);
      points.push([cx + Math.cos(a) * corner, y, cz + Math.sin(a) * corner]);
    }
  }
  return points;
}

export interface Placement {
  readonly at?: readonly [number, number, number];
  readonly rotate?: readonly [number, number, number];
  readonly scale?: number | readonly [number, number, number];
}

export function place(geometry: BufferGeometry, placement: Placement): BufferGeometry {
  const [x, y, z] = placement.at ?? [0, 0, 0];
  const [rx, ry, rz] = placement.rotate ?? [0, 0, 0];
  const s = placement.scale ?? 1;
  const scale = typeof s === 'number' ? new Vector3(s, s, s) : new Vector3(s[0], s[1], s[2]);
  geometry.applyMatrix4(
    new Matrix4().compose(
      new Vector3(x, y, z),
      new Quaternion().setFromEuler(new Euler(rx, ry, rz)),
      scale,
    ),
  );
  return geometry;
}

/** Writes a flat colour, finish and pattern into every vertex, so unlike parts can merge. */
export function paint(
  geometry: BufferGeometry,
  hex: string,
  finish: Finish = {},
  pattern: Pattern = 'none',
): BufferGeometry {
  const count = geometry.getAttribute('position').count;
  const color = new Color(hex);
  const colors = new Float32Array(count * 3);
  const finishes = new Float32Array(count * 4);
  const patterns = new Float32Array(count).fill(PATTERNS[pattern]);
  for (let i = 0; i < count; i += 1) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
    finishes[i * 4] = finish.metal ?? 0;
    finishes[i * 4 + 1] = finish.rough ?? 0.3;
    finishes[i * 4 + 2] = finish.brush ?? 0;
    finishes[i * 4 + 3] = finish.coat ?? 0;
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.setAttribute('finish', new BufferAttribute(finishes, 4));
  geometry.setAttribute('pattern', new BufferAttribute(patterns, 1));
  return geometry;
}

/**
 * Merges painted parts into one geometry (one draw call) and frees the parts. Throws when a
 * part was never painted, since it would merge without the attributes the materials read.
 */
export function merge(parts: readonly BufferGeometry[], name: string): BufferGeometry {
  for (const part of parts) {
    for (const key of Object.keys(part.attributes)) {
      if (!(KEPT as readonly string[]).includes(key)) part.deleteAttribute(key);
    }
    for (const key of KEPT) {
      if (!part.hasAttribute(key)) {
        throw new Error(`Prize geometry "${name}" has a part without "${key}": paint every part`);
      }
    }
    if (!part.index) indexAll(part);
  }
  // mergeGeometries returns null (and logs) on mismatched parts, though its typings say otherwise.
  const merged = mergeGeometries([...parts], false) as BufferGeometry | null;
  for (const part of parts) part.dispose();
  if (!merged) throw new Error(`Prize geometry "${name}" could not merge its parts`);
  merged.name = name;
  withTangents(merged);
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

/**
 * Anisotropic brushing runs along each vertex's UV tangent. three derives tangents from the UVs
 * when a geometry has none, but a vertex whose UVs collapse (a lathe's pole, a disc's centre)
 * gets a zero tangent, and the anisotropic specular then turns NaN and blooms across the frame.
 * So tangents are computed here and any degenerate one replaced by a direction in the surface.
 */
export function withTangents(geometry: BufferGeometry): BufferGeometry {
  geometry.computeTangents();
  const tangents = geometry.getAttribute('tangent');
  const normals = geometry.getAttribute('normal');
  const n = new Vector3();
  const t = new Vector3();
  const side = new Vector3();
  for (let i = 0; i < tangents.count; i += 1) {
    t.set(tangents.getX(i), tangents.getY(i), tangents.getZ(i));
    const w = tangents.getW(i);
    if (Number.isFinite(t.x + t.y + t.z + w) && t.lengthSq() > 1e-12 && w !== 0) continue;
    n.set(normals.getX(i), normals.getY(i), normals.getZ(i));
    if (n.lengthSq() < 1e-12) n.set(0, 1, 0);
    n.normalize();
    side.set(Math.abs(n.y) < 0.9 ? 0 : 1, Math.abs(n.y) < 0.9 ? 1 : 0, 0);
    t.crossVectors(side, n).normalize();
    tangents.setXYZW(i, t.x, t.y, t.z, 1);
  }
  return geometry;
}

function indexAll(geometry: BufferGeometry): BufferGeometry {
  const count = geometry.getAttribute('position').count;
  const index = new Uint32Array(count);
  for (let i = 0; i < count; i += 1) index[i] = i;
  geometry.setIndex(new BufferAttribute(index, 1));
  return geometry;
}

/** Splits shared vertices so each face shades flat: cut glass and facets. */
export function facet(geometry: BufferGeometry): BufferGeometry {
  if (!geometry.index) {
    geometry.computeVertexNormals();
    return geometry;
  }
  const flat = geometry.toNonIndexed();
  geometry.dispose();
  flat.computeVertexNormals();
  return flat;
}
