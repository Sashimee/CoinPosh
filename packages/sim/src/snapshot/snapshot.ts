import type { Rotation, Vector } from '@dimforge/rapier3d-deterministic-compat';

export const SIM_SNAPSHOT_VERSION = 1;

/** Metres per position unit: 10 µm, 1/20 of TABLE_SOLVER.separationSlop. */
export const POSITION_UNIT = 1e-5;
/** A quaternion component of 1, as an int16. */
export const ROTATION_UNIT = 32767;

/**
 * `frozen` is reserved for a static-crust tier the sim does not have yet; a restore
 * refuses it.
 */
export type RestState = 'awake' | 'asleep' | 'frozen';

export interface CoinPose {
  /** The coin's sim id when the snapshot was taken. */
  readonly id: number;
  /** Centre x, y, z in POSITION_UNIT. */
  readonly p: readonly [number, number, number];
  /** Rotation x, y, z, w in ROTATION_UNIT, canonical: w >= 0, and when w is 0 the first non-zero component is positive. */
  readonly q: readonly [number, number, number, number];
  readonly rest: RestState;
}

export interface SimTableSnapshot {
  readonly version: typeof SIM_SNAPSHOT_VERSION;
  /** 0 .. PUSHER.periodTicks − 1. */
  readonly pusherTickInCycle: number;
  /** In ascending id order. */
  readonly coins: readonly CoinPose[];
}

function whole(n: number): number {
  const r = Math.round(n);
  return r === 0 ? 0 : r;
}

export function quantizePosition(v: Readonly<Vector>): [number, number, number] {
  return [whole(v.x / POSITION_UNIT), whole(v.y / POSITION_UNIT), whole(v.z / POSITION_UNIT)];
}

/**
 * The int16 rotation whose decode, as Rapier stores it in f32, quantizes back to itself,
 * so a coin restored at rest snapshots to the same values. Rounding alone does not
 * promise that: renormalizing a rounded quaternion can move a component by more than
 * half a unit. Starting from the rounded value, it decodes and rounds again until
 * nothing changes, which takes one or two rounds.
 */
export function quantizeRotation(r: Readonly<Rotation>): [number, number, number, number] {
  const sign = r.w < 0 ? -1 : 1;
  let q = canonical([
    whole(sign * r.x * ROTATION_UNIT),
    whole(sign * r.y * ROTATION_UNIT),
    whole(sign * r.z * ROTATION_UNIT),
    whole(sign * r.w * ROTATION_UNIT),
  ]);
  for (let round = 0; round < MAX_ROTATION_ROUNDS; round++) {
    const stored = dequantizeRotation(q);
    const next = canonical([
      whole(Math.fround(stored.x) * ROTATION_UNIT),
      whole(Math.fround(stored.y) * ROTATION_UNIT),
      whole(Math.fround(stored.z) * ROTATION_UNIT),
      whole(Math.fround(stored.w) * ROTATION_UNIT),
    ]);
    if (next.every((c, i) => c === q[i])) {
      break;
    }
    q = next;
  }
  return q;
}

const MAX_ROTATION_ROUNDS = 8;

function canonical(q: [number, number, number, number]): [number, number, number, number] {
  if (q[3] === 0 && (q.find((c) => c !== 0) ?? 0) < 0) {
    return [whole(-q[0]), whole(-q[1]), whole(-q[2]), 0];
  }
  return q;
}

export function dequantizePosition(p: CoinPose['p']): Vector {
  return { x: p[0] * POSITION_UNIT, y: p[1] * POSITION_UNIT, z: p[2] * POSITION_UNIT };
}

/** The pose's rotation as a unit quaternion; its norm before renormalizing is checked by checkPose. */
export function dequantizeRotation(q: CoinPose['q']): Rotation {
  const [x, y, z, w] = q;
  const norm = Math.sqrt(x * x + y * y + z * z + w * w);
  return { x: x / norm, y: y / norm, z: z / norm, w: w / norm };
}
