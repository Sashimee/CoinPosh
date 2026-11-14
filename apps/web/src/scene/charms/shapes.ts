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
 * Per-vertex finish for the painted material: `metal` blends lacquer into polished metal,
 * `rough` is the base roughness, `glow` marks trims that answer the activation flash and
 * `lamp` marks jewels and visors that carry their own light.
 */
export interface Finish {
  readonly metal?: number;
  readonly rough?: number;
  readonly glow?: number;
  readonly lamp?: number;
}

/** Attribute names every merged charm geometry carries, so any two parts can merge. */
const KEPT = ['position', 'normal', 'uv', 'color', 'finish'] as const;

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
): BufferGeometry {
  const curve = new CatmullRomCurve3(points.map(([x, y, z]) => new Vector3(x, y, z)));
  return new TubeGeometry(curve, tubular, radius, radial, false);
}

/** A helix of `turns` around +Y from `y0` to `y1`, as a tube of wire. */
export function helix(
  radius: number,
  wire: number,
  y0: number,
  y1: number,
  turns: number,
): BufferGeometry {
  const steps = Math.ceil(turns * 18);
  const points: [number, number, number][] = [];
  for (let i = 0; i <= steps; i += 1) {
    const f = i / steps;
    const a = f * turns * Math.PI * 2;
    points.push([Math.cos(a) * radius, y0 + (y1 - y0) * f, Math.sin(a) * radius]);
  }
  return tube(points, wire, steps * 3, 8);
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

/** Writes a flat colour and finish into every vertex, so differently finished parts can merge. */
export function paint(geometry: BufferGeometry, hex: string, finish: Finish = {}): BufferGeometry {
  const count = geometry.getAttribute('position').count;
  const color = new Color(hex);
  const colors = new Float32Array(count * 3);
  const finishes = new Float32Array(count * 4);
  for (let i = 0; i < count; i += 1) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
    finishes[i * 4] = finish.metal ?? 0;
    finishes[i * 4 + 1] = finish.rough ?? 0.3;
    finishes[i * 4 + 2] = finish.glow ?? 0;
    finishes[i * 4 + 3] = finish.lamp ?? 0;
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.setAttribute('finish', new BufferAttribute(finishes, 4));
  return geometry;
}

/**
 * Merges parts into one geometry (one draw call) and frees the parts. Every part must carry
 * the same attribute set: all painted, or none.
 */
export function merge(parts: readonly BufferGeometry[], name: string): BufferGeometry {
  for (const part of parts) {
    for (const key of Object.keys(part.attributes)) {
      if (!(KEPT as readonly string[]).includes(key)) part.deleteAttribute(key);
    }
    if (!part.index) indexAll(part);
  }
  // mergeGeometries returns null (and logs) on mismatched parts, though its typings say otherwise.
  const merged = mergeGeometries([...parts], false) as BufferGeometry | null;
  for (const part of parts) part.dispose();
  if (!merged) {
    throw new Error(
      `Charm geometry "${name}" could not merge: its parts carry different attributes`,
    );
  }
  merged.name = name;
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
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
