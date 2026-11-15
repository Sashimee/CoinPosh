import { Vector3 } from 'three/webgpu';
import { RIVIERA_TABLE, rivieraCameraPreset } from '../venues/riviera/layout.ts';

const T = RIVIERA_TABLE;
const BACKBOARD_TOP = T.pusherHeight + 0.004 + T.backboardHeight;

/**
 * Where a figure stands, in table space, at its full size: in the cabinet's back bay between the
 * backboard and the cabinet back, off to one side so the Vault plaque over the crest never hides
 * it, its waist below the backboard top so only the head, the shoulders and the prop peek over
 * the wall. `bossStand` shrinks and tucks it in from here wherever the frame is tighter.
 */
export const BOSS_STAND = {
  x: 0.142,
  y: BACKBOARD_TOP - 0.07,
  z: T.backboardFrontZ - T.backboardDepth - 0.06,
  /** Turned a touch towards the middle of the table, where the cascades fall. */
  yaw: -0.32,
  /** Figure size over its modelled proportions. */
  scale: 1.1,
} as const;

/**
 * How far the waist sits below the backboard top, per unit of figure scale: at full size the
 * shoulders and the prop clear the wall; a figure shrunk to fit a tight frame sinks towards
 * `DEEP_PEEK` (the head over the wall from the eyes up, Kilroy-style), so the room over the wall
 * goes to the face and the jump rather than to the torso.
 */
const FULL_PEEK = (BACKBOARD_TOP - BOSS_STAND.y) / BOSS_STAND.scale;
const DEEP_PEEK = 0.112;
const DEEP_SCALE = 0.55;

function peek(scale: number): number {
  const u = Math.min(Math.max((scale - DEEP_SCALE) / (BOSS_STAND.scale - DEEP_SCALE), 0), 1);
  return DEEP_PEEK + (FULL_PEEK - DEEP_PEEK) * u;
}

function waistY(scale: number): number {
  return BACKBOARD_TOP - peek(scale) * scale;
}
/** Smallest figure and innermost stand the fit falls back to, however tight the frame. */
const MIN_SCALE = 0.25;
const MIN_X = 0.09;
/** Highest NDC y and widest NDC |x| any part of a figure may reach, at the peak of a shock. */
export const BOSS_FRAME_MAX_Y = 0.95;
export const BOSS_FRAME_MAX_X = 0.95;
const FIT_ITERATIONS = 24;

/**
 * The figures' reach in their own frame (unscaled, +X towards the prop side mirrored per stand),
 * measured over every mood of both kinds: the hat top at the peak of the hardest shock (the
 * tycoon's top hat, the Inspector's cap on his recoil), and the widest arm swing to each side.
 */
const CROWN_REACH: readonly Vector3[] = [
  new Vector3(0, 0.302, -0.04),
  new Vector3(0, 0.254, 0.038),
  new Vector3(-0.025, 0.21, -0.111),
  new Vector3(-0.008, 0.237, -0.06),
];
const SIDE_REACH: readonly Vector3[] = [
  new Vector3(0.081, 0.027, 0.016),
  new Vector3(-0.08, 0.098, 0.022),
  new Vector3(-0.08, 0.077, 0.03),
];

export interface BossStand {
  readonly position: Vector3;
  readonly yaw: number;
  /** Uniform figure scale; the presence mirrors X by `side` on top of it. */
  readonly scale: number;
}

/** Projects table-space points through the Riviera camera preset for `aspect`, without a camera. */
function presetProjector(aspect: number): (p: Vector3) => { x: number; y: number } {
  const preset = rivieraCameraPreset(aspect);
  const forward = preset.target.clone().sub(preset.position).normalize();
  const right = new Vector3().crossVectors(forward, new Vector3(0, 1, 0)).normalize();
  const up = new Vector3().crossVectors(right, forward);
  const tanV = Math.tan((preset.fov * Math.PI) / 360);
  const tanH = tanV * aspect;
  const offset = new Vector3();
  return (p) => {
    offset.copy(p).sub(preset.position);
    const depth = Math.max(offset.dot(forward), 1e-6);
    return { x: offset.dot(right) / (depth * tanH), y: offset.dot(up) / (depth * tanV) };
  };
}

function place(side: 1 | -1, x: number, scale: number, local: Vector3, out: Vector3): Vector3 {
  const yaw = side * BOSS_STAND.yaw;
  const lx = side * scale * local.x;
  const lz = scale * local.z;
  return out.set(
    side * x + Math.cos(yaw) * lx + Math.sin(yaw) * lz,
    waistY(scale) + scale * local.y,
    BOSS_STAND.z - Math.sin(yaw) * lx + Math.cos(yaw) * lz,
  );
}

/**
 * The stand for a figure on the `side` of the cabinet (+1 right, -1 left, from the player),
 * framed for the Riviera camera at `aspect`: as large as `BOSS_STAND` allows while the hat at
 * the peak of a shock stays under the top edge, and pulled in from the side edge where the
 * screen is narrow.
 */
export function bossStand(side: 1 | -1, aspect: number): BossStand {
  const project = presetProjector(Number.isFinite(aspect) && aspect > 0 ? aspect : 1);
  const at = new Vector3();
  const maxAbs = (points: readonly Vector3[], x: number, scale: number, axis: 'x' | 'y') => {
    let m = -Infinity;
    for (const q of points) {
      const ndc = project(place(side, x, scale, q, at));
      m = Math.max(m, axis === 'x' ? Math.abs(ndc.x) : ndc.y);
    }
    return m;
  };
  const xFor = (scale: number): number => {
    if (maxAbs(SIDE_REACH, BOSS_STAND.x, scale, 'x') <= BOSS_FRAME_MAX_X) return BOSS_STAND.x;
    let lo = MIN_X;
    let hi: number = BOSS_STAND.x;
    for (let i = 0; i < FIT_ITERATIONS; i++) {
      const mid = (lo + hi) / 2;
      if (maxAbs(SIDE_REACH, mid, scale, 'x') <= BOSS_FRAME_MAX_X) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  const fits = (scale: number): boolean =>
    maxAbs(CROWN_REACH, xFor(scale), scale, 'y') <= BOSS_FRAME_MAX_Y;

  let scale: number = BOSS_STAND.scale;
  if (!fits(scale)) {
    let lo = MIN_SCALE;
    let hi: number = BOSS_STAND.scale;
    for (let i = 0; i < FIT_ITERATIONS; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    scale = lo;
  }
  const x = xFor(scale);
  return {
    position: new Vector3(side * x, waistY(scale), BOSS_STAND.z),
    yaw: side * BOSS_STAND.yaw,
    scale,
  };
}
