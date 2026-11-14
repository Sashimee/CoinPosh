import { CatmullRomCurve3, Vector3 } from 'three/webgpu';
import { createRng } from '../../audio/rng.ts';

/**
 * Gacha machine dimensions in metres: a countertop capsule machine about 44 cm tall. The origin
 * is the centre of the plinth's underside, +Y is up and the crank, slot and tray face +Z.
 */
export const GACHA = {
  plinth: { halfWidth: 0.114, halfDepth: 0.099, height: 0.014, corner: 0.024 },
  body: { halfWidth: 0.1, halfDepth: 0.085, bottom: 0.014, top: 0.19, corner: 0.02 },
  column: { radius: 0.0115, inset: 0.0065, flutes: 14 },
  globe: { centerY: 0.28, radius: 0.1, wall: 0.003 },
  collarTop: 0.213,
  capBase: 0.352,
  capsuleRadius: 0.0145,
  crank: { pivotY: 0.112, arm: 0.038, plateRadius: 0.047 },
  slotY: 0.168,
  tray: { halfWidth: 0.052, front: 0.137, floor: 0.017, top: 0.041, wall: 0.004 },
  chuteRadius: 0.0195,
} as const;

/** Centre of a capsule resting on the tray's velvet, where `dispense` leaves it. */
export const TRAY_REST = new Vector3(
  0,
  GACHA.tray.floor + 0.003 + GACHA.capsuleRadius,
  (GACHA.body.halfDepth + GACHA.tray.front) / 2 + 0.002,
);

/** Where `pop` lifts the capsule to open it: over the tray, nearer the player. */
export const POP_POINT = new Vector3(0, 0.094, 0.15);

/**
 * The glass chute's centreline, from the port in the collar to the mouth inside the tray. It
 * wraps the right front column on the way down, clearing it and the body by a few millimetres.
 */
export const CHUTE_POINTS: readonly (readonly [number, number, number])[] = [
  [0.064, 0.204, 0.018],
  [0.096, 0.199, 0.03],
  [0.122, 0.184, 0.048],
  [0.137, 0.146, 0.072],
  [0.134, 0.1, 0.103],
  [0.104, 0.062, 0.123],
  [0.064, 0.042, 0.116],
  [0.036, 0.036, 0.111],
];

export function createChuteCurve(): CatmullRomCurve3 {
  return new CatmullRomCurve3(
    CHUTE_POINTS.map(([x, y, z]) => new Vector3(x, y, z)),
    false,
    'centripetal',
  );
}

/** Arc-length samples of the chute, read every frame of the roll without touching the curve. */
export interface ChuteTrack {
  readonly length: number;
  readonly samples: number;
  readonly points: Float32Array;
  readonly tangents: Float32Array;
  /** Writes the centreline point at arc-length share `u` (0 = port, 1 = mouth) into `out`. */
  pointAt(u: number, out: Vector3): Vector3;
  tangentAt(u: number, out: Vector3): Vector3;
}

export const CHUTE_SAMPLES = 96;

export function createChuteTrack(curve = createChuteCurve()): ChuteTrack {
  const count = CHUTE_SAMPLES + 1;
  const points = new Float32Array(count * 3);
  const tangents = new Float32Array(count * 3);
  const p = new Vector3();
  const t = new Vector3();
  for (let i = 0; i < count; i++) {
    const u = i / CHUTE_SAMPLES;
    curve.getPointAt(u, p).toArray(points, i * 3);
    curve.getTangentAt(u, t).toArray(tangents, i * 3);
  }
  const read = (buffer: Float32Array, u: number, out: Vector3): Vector3 => {
    const x = Math.min(Math.max(u, 0), 1) * CHUTE_SAMPLES;
    const i = Math.min(Math.floor(x), CHUTE_SAMPLES - 1);
    const f = x - i;
    const at = (k: number): number => {
      const from = buffer[i * 3 + k] ?? 0;
      return from + ((buffer[i * 3 + 3 + k] ?? 0) - from) * f;
    };
    return out.set(at(0), at(1), at(2));
  };
  return {
    length: curve.getLength(),
    samples: CHUTE_SAMPLES,
    points,
    tangents,
    pointAt: (u, out) => read(points, u, out),
    tangentAt: (u, out) => read(tangents, u, out).normalize(),
  };
}

/** One capsule of the pile in the globe, in the machine's space. */
export interface PileCapsule {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Euler angles, so each capsule's seam ring sits at its own tilt. */
  readonly rx: number;
  readonly ry: number;
  readonly rz: number;
  /** Index into PILE_TINTS. */
  readonly tint: number;
}

/**
 * Capsule shell colours of the pile: every rarity colour, weighted towards the warm golds and
 * the jewel tones so the globe reads as a jar of sweets in the venue's palette.
 */
export const PILE_TINTS = [
  '#F5B942',
  '#FF7A59',
  '#3B82F6',
  '#A855F7',
  '#3CCB7F',
  '#7FD1C7',
  '#F3E5C0',
  '#E9E4D8',
] as const;
const TINT_WEIGHTS = [5, 4, 3, 3, 3, 3, 2, 1] as const;

/**
 * Settles `count` capsules into the bottom of the globe, one at a time: each tries a handful of
 * seeded spots and keeps the lowest at which it rests on the glass or on the capsules below,
 * which is how a scooped handful of spheres lands. Exact for spheres, so none overlap.
 */
export function packPile(count: number, seed = 7): PileCapsule[] {
  const rng = createRng(seed);
  const c = GACHA.capsuleRadius;
  const inner = GACHA.globe.radius - GACHA.globe.wall - c;
  const cy = GACHA.globe.centerY;
  const totalWeight = TINT_WEIGHTS.reduce((sum, w) => sum + w, 0);
  const pile: PileCapsule[] = [];
  const contact = (2 * c) ** 2;
  for (let n = 0; n < count; n++) {
    let best: { x: number; y: number; z: number } | null = null;
    for (let attempt = 0; attempt < 28; attempt++) {
      const radius = Math.sqrt(rng()) * inner * 0.98;
      const angle = rng() * Math.PI * 2;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      let y = cy - Math.sqrt(Math.max(inner * inner - radius * radius, 0));
      for (const other of pile) {
        const d2 = (other.x - x) ** 2 + (other.z - z) ** 2;
        if (d2 < contact) y = Math.max(y, other.y + Math.sqrt(contact - d2));
      }
      if ((y - cy) ** 2 + radius * radius > inner * inner) continue;
      if (!best || y < best.y) best = { x, y, z };
    }
    if (!best) throw new Error(`The gacha globe has no room for capsule ${n + 1} of ${count}`);
    let pick = rng() * totalWeight;
    let tint = 0;
    while (tint < TINT_WEIGHTS.length - 1 && pick >= (TINT_WEIGHTS[tint] ?? 0)) {
      pick -= TINT_WEIGHTS[tint] ?? 0;
      tint++;
    }
    pile.push({
      ...best,
      rx: (rng() - 0.5) * Math.PI,
      ry: rng() * Math.PI * 2,
      rz: (rng() - 0.5) * Math.PI,
      tint,
    });
  }
  return pile;
}

/** The pile capsule nearest the chute's port: the one a dispense takes from the globe. */
export function exitCapsule(pile: readonly PileCapsule[]): number {
  const [px, py, pz] = CHUTE_POINTS[0] ?? [0, 0, 0];
  let best = -1;
  let bestDistance = Infinity;
  pile.forEach((capsule, i) => {
    const d = (capsule.x - px) ** 2 + (capsule.y - py) ** 2 + (capsule.z - pz) ** 2;
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  });
  if (best < 0) throw new Error('The gacha globe is empty, so no capsule can be dispensed');
  return best;
}
