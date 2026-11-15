import {
  BufferAttribute,
  type BufferGeometry,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  LatheGeometry,
  Quaternion,
  SphereGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
} from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BONE_INDEX, type BoneName, type Vec3 } from './rig.ts';

/**
 * Per-vertex surface for the livery material. `sheen` lifts wool and velvet at grazing angles
 * (`sheenRough` sets how soft), `coat` is a lacquer clearcoat, `aniso` streaks turned gold and
 * `glow` lets wine carry a little of its own light.
 */
export interface Finish {
  readonly metal?: number;
  readonly rough?: number;
  readonly coat?: number;
  readonly sheen?: number;
  readonly sheenRough?: number;
  readonly aniso?: number;
  readonly glow?: number;
}

export const WOOL: Finish = { rough: 0.8, sheen: 0.6, sheenRough: 0.62 };
export const VELVET: Finish = { rough: 0.92, sheen: 1, sheenRough: 0.32 };
export const SILK: Finish = { rough: 0.38, sheen: 0.55, sheenRough: 0.22 };
export const COTTON: Finish = { rough: 0.72, sheen: 0.3, sheenRough: 0.7 };
export const PORCELAIN: Finish = { rough: 0.42, coat: 0.4 };
export const LACQUER: Finish = { rough: 0.24, coat: 1 };
export const LEATHER: Finish = { rough: 0.48, coat: 0.3, sheen: 0.15, sheenRough: 0.5 };
export const BOTTLE_GLASS: Finish = { rough: 0.05, coat: 1 };
export const BRUSHED_GOLD: Finish = { metal: 1, rough: 0.38, aniso: 0.55 };
export const POLISHED_GOLD: Finish = { metal: 1, rough: 0.2, aniso: 0.3 };

export const GOLD = {
  brushed: '#CC9A35',
  polished: '#E2BE52',
} as const;

/** Up to four bones and their weights; the weights are normalised by `dress`. */
export type Weights = readonly (readonly [BoneName, number])[];
export type Bind = BoneName | ((x: number, y: number, z: number) => Weights);

const KEPT = ['position', 'normal', 'uv', 'color', 'finish', 'trim', 'skinIndex', 'skinWeight'];

/** Writes colour, finish and skin weights into every vertex, so any two parts can merge. */
export function dress(
  geometry: BufferGeometry,
  hex: string,
  finish: Finish,
  bind: Bind,
): BufferGeometry {
  const position = geometry.getAttribute('position');
  const count = position.count;
  const color = new Color(hex);
  const colors = new Float32Array(count * 3);
  const finishes = new Float32Array(count * 4);
  const trims = new Float32Array(count * 3);
  const indices = new Uint16Array(count * 4);
  const weights = new Float32Array(count * 4);
  for (let i = 0; i < count; i += 1) {
    colors.set([color.r, color.g, color.b], i * 3);
    finishes.set(
      [finish.metal ?? 0, finish.rough ?? 0.5, finish.coat ?? 0, finish.sheen ?? 0],
      i * 4,
    );
    trims.set([finish.aniso ?? 0, finish.glow ?? 0, finish.sheenRough ?? 0.5], i * 3);
    const pairs: Weights =
      typeof bind === 'string'
        ? [[bind, 1]]
        : bind(position.getX(i), position.getY(i), position.getZ(i));
    if (pairs.length === 0 || pairs.length > 4) {
      throw new Error(`A staff vertex needs one to four bone weights, got ${pairs.length}`);
    }
    const total = pairs.reduce((sum, [, w]) => sum + w, 0);
    if (!(total > 0)) throw new Error('A staff vertex has bone weights that sum to zero');
    pairs.forEach(([bone, w], slot) => {
      indices[i * 4 + slot] = BONE_INDEX[bone];
      weights[i * 4 + slot] = w / total;
    });
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.setAttribute('finish', new BufferAttribute(finishes, 4));
  geometry.setAttribute('trim', new BufferAttribute(trims, 3));
  geometry.setAttribute('skinIndex', new BufferAttribute(indices, 4));
  geometry.setAttribute('skinWeight', new BufferAttribute(weights, 4));
  return geometry;
}

/** Blends two bones across a band of heights: `a` below `y0`, `b` above `y1`. */
export function across(a: BoneName, b: BoneName, y0: number, y1: number) {
  return (_x: number, y: number): Weights => {
    const f = Math.min(Math.max((y - y0) / (y1 - y0), 0), 1);
    const s = f * f * (3 - 2 * f);
    return s <= 0
      ? [[a, 1]]
      : s >= 1
        ? [[b, 1]]
        : [
            [a, 1 - s],
            [b, s],
          ];
  };
}

/** Merges dressed parts into one geometry (one draw call) and frees the parts. */
export function assemble(parts: readonly BufferGeometry[], name: string): BufferGeometry {
  for (const part of parts) {
    for (const key of Object.keys(part.attributes)) {
      if (!KEPT.includes(key)) part.deleteAttribute(key);
    }
    if (!part.index) {
      const count = part.getAttribute('position').count;
      const index = new Uint32Array(count);
      for (let i = 0; i < count; i += 1) index[i] = i;
      part.setIndex(new BufferAttribute(index, 1));
    }
  }
  // mergeGeometries returns null (and logs) on mismatched parts, though its typings say otherwise.
  const merged = mergeGeometries([...parts], false) as BufferGeometry | null;
  for (const part of parts) part.dispose();
  if (!merged) {
    throw new Error(
      `Staff geometry "${name}" could not merge: its parts carry different attributes`,
    );
  }
  merged.name = name;
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

export type Profile = readonly (readonly [radius: number, y: number])[];

/**
 * A lathe around a vertical axis at `at`, squashed front to back by `depth`. `phi` limits it
 * to an arc (0 faces +Z) for panels laid over a body.
 */
export function lathe(
  profile: Profile,
  segments: number,
  options: { at?: Vec3; depth?: number; phi?: readonly [start: number, length: number] } = {},
): BufferGeometry {
  const [start, length] = options.phi ?? [0, Math.PI * 2];
  const geometry = new LatheGeometry(
    profile.map(([r, y]) => new Vector2(Math.max(r, 0), y)),
    segments,
    start,
    length,
  );
  geometry.scale(1, 1, options.depth ?? 1);
  const [x, y, z] = options.at ?? [0, 0, 0];
  geometry.translate(x, y, z);
  return geometry;
}

/** The radius of a lathe profile at height `y`, by linear interpolation. */
export function radiusAt(profile: Profile, y: number): number {
  for (let i = 1; i < profile.length; i += 1) {
    const [r0, y0] = profile[i - 1] ?? [0, 0];
    const [r1, y1] = profile[i] ?? [0, 0];
    if ((y >= y0 && y <= y1) || (y <= y0 && y >= y1)) {
      return y1 === y0 ? Math.max(r0, r1) : r0 + ((r1 - r0) * (y - y0)) / (y1 - y0);
    }
  }
  return 0;
}

/** The slice of a body profile between two heights, pushed out by `lift` to lie over it. */
export function over(profile: Profile, y0: number, y1: number, lift: number, steps = 8): Profile {
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i += 1) {
    const y = y0 + ((y1 - y0) * i) / steps;
    out.push([radiusAt(profile, y) + lift, y]);
  }
  return out;
}

const UP = new Vector3(0, 1, 0);

/** A tapered cylinder from `from` to `to`. */
export function limb(
  rFrom: number,
  rTo: number,
  from: Vec3,
  to: Vec3,
  segments: number,
): BufferGeometry {
  const a = new Vector3(...from);
  const b = new Vector3(...to);
  const axis = b.clone().sub(a);
  const geometry = new CylinderGeometry(rTo, rFrom, axis.length(), segments, 1, true);
  geometry.applyQuaternion(new Quaternion().setFromUnitVectors(UP, axis.normalize()));
  const mid = a.add(b).multiplyScalar(0.5);
  geometry.translate(mid.x, mid.y, mid.z);
  return geometry;
}

/** An ellipsoid of radius `r` at `at`, stretched per axis by `scale`. */
export function ball(
  r: number,
  at: Vec3,
  segments: number,
  scale: Vec3 = [1, 1, 1],
): BufferGeometry {
  const geometry = new SphereGeometry(r, segments, Math.max(6, Math.round(segments * 0.6)));
  geometry.scale(...scale);
  geometry.translate(...at);
  return geometry;
}

/** A wire through `points` (a chain, a strap, a handle), open at both ends. */
export function tube(
  points: readonly Vec3[],
  radius: number,
  tubular: number,
  radial: number,
): BufferGeometry {
  const curve = new CatmullRomCurve3(points.map(([x, y, z]) => new Vector3(x, y, z)));
  return new TubeGeometry(curve, tubular, radius, radial, false);
}
