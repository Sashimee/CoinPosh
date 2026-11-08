import type { PerspectiveCamera } from 'three/webgpu';
import { Vector3 } from 'three/webgpu';
// TODO(lead-architect, #20): import '@coinposh/sim' once apps/web depends on it. The table layout
// module has no imports of its own, so this pulls in constants only, never Rapier.
import { BACKBOARD, PLAYFIELD, PUSHER } from '../../../../../../packages/sim/src/table/layout.ts';

/** Coin height above the field the catch tray, side gutters and cabinet body all bottom out at. */
const TRAY_FLOOR_Y = -0.12;
/** Lacquer side wall height; the glass above it carries the wall up to the sim's wall height. */
const SIDE_WALL_HEIGHT = 0.07;
/** Rear clearance between the fully retracted pusher block and the back of the cabinet. */
const PUSHER_REAR_CLEARANCE = 0.01;

/**
 * Riviera table dimensions in metres. +Y is up, the player stands at +Z, and the lower
 * playfield surface is y = 0. Everything a coin can touch comes from the sim's table layout
 * (T-1.01), so rendered coins sit on the rendered table; the rest is the visual shell around it.
 */
export const RIVIERA_TABLE = {
  fieldHalfWidth: PLAYFIELD.fieldHalfWidth,
  fieldFrontZ: PLAYFIELD.fieldFrontZ,
  gutterWidth: PLAYFIELD.gutterWidth,
  // The gutters drop straight to the catch tray floor, so the tray reads as one velvet well.
  gutterDepth: -TRAY_FLOOR_Y - 0.005,
  wallThickness: 0.028,
  wallHeight: SIDE_WALL_HEIGHT,
  glassHeight: PLAYFIELD.wallHeight - SIDE_WALL_HEIGHT,
  pusherHeight: PUSHER.height,
  pusherFrontZ: PUSHER.frontZ,
  pusherStroke: PUSHER.stroke,
  pusherDepth: PUSHER.depth,
  backboardFrontZ: BACKBOARD.frontZ,
  // Deep enough that the retracted block never pokes out of the back of the cabinet.
  backboardDepth: BACKBOARD.frontZ - (PUSHER.frontZ - PUSHER.depth) + PUSHER_REAR_CLEARANCE,
  backboardHeight: 0.36,
  // table.ts closes the cabinet body at z = 0.36, so the front panel starts just ahead of it.
  cabinetFrontZ: 0.375,
  trayDepth: 0.1,
  deckY: -0.85,
} as const;

export const RIVIERA_DECK = {
  sternZ: -2.3,
  halfWidth: 4.2,
  forwardZ: 3.2,
  bulwarkHeight: 0.42,
  railHeight: 0.62,
  stanchionSpacing: 0.62,
  seaLevel: -4.1,
} as const;

/**
 * Bearing of the low sunset in the backdrop frame: almost dead astern and a touch to port, so
 * the disc sits inside even a portrait frame, just above the horizon beside the backboard.
 */
export const RIVIERA_SUN_DIRECTION = new Vector3(-0.1, 0.035, -1).normalize();

export interface CameraPreset {
  readonly position: Vector3;
  readonly target: Vector3;
  readonly fov: number;
}

/**
 * Screen band the HUD leaves for the table, in NDC y: below the Vault plaque and above the
 * dock. The HUD is sized in CSS px, so the band is narrower in NDC on short landscape phones;
 * these match a 390x844 phone (plaque bottom 86 px, dock top 774 px) and an 844x390 one
 * (76 px, 324 px).
 */
const HUD_BAND_TALL = { top: 0.79, bottom: -0.83 } as const;
const HUD_BAND_SHORT = { top: 0.6, bottom: -0.65 } as const;
/** Clearance kept between the framed table and the band edges, in NDC. */
const BAND_MARGIN = 0.03;
/**
 * Widest NDC x the coin floor and gutters may reach on a portrait phone, so the Decorum and
 * Cascade meters pinned to the screen edges (P-101) sit over the side walls, not the coins.
 */
const PORTRAIT_FIELD_MAX_X = 0.7;

const T = RIVIERA_TABLE;
const INNER_HALF_WIDTH = T.fieldHalfWidth + T.gutterWidth;
/** Outermost gold at the cabinet front: the finials and the plinth rods. */
const CABINET_HALF_WIDTH = INNER_HALF_WIDTH + T.wallThickness + 0.03;
const CABINET_FRONT_Z = T.cabinetFrontZ + 0.035;
const CABINET_BACK_Z = T.backboardFrontZ - T.backboardDepth;
const CREST_Y = T.pusherHeight + 0.004 + T.backboardHeight + 0.034;
const FINIAL_TOP_Y = T.wallHeight + 0.036;
/**
 * Where paid-out coins land: the catch tray floor just ahead of the front edge. Keeping it
 * above the dock keeps the payout cascade on screen.
 */
const PAYOUT_LANDING = new Vector3(0, TRAY_FLOOR_Y, T.fieldFrontZ + 0.04);
const CREST = new Vector3(0, CREST_Y, T.backboardFrontZ);
const UPPER_TIER_REAR = new Vector3(0, T.pusherHeight, T.backboardFrontZ);
/** Top of the front panel's gold frame; desktop frames keep it clear of the bottom edge. */
const FRONT_FRAME = new Vector3(0, -0.2, CABINET_FRONT_Z);

interface Band {
  readonly top: number;
  readonly bottom: number;
}

/** A point the camera keeps inside an NDC window. */
interface FramePoint {
  readonly at: Vector3;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

/**
 * Two kinds of frame point. The play points (the coin floor's front corners, the back of the
 * upper tier and the payout landing) always sit inside the HUD band, the floor clear of the
 * side meters on a portrait phone. The cabinet points (finials, front panel, backboard crest)
 * keep the whole cabinet in frame on desktop; on a phone, `relax` (0..1) lets them run off
 * the edges and under the HUD so the coins can come closer.
 */
function framePoints(band: Band, tall: number, relax: number): FramePoint[] {
  const cabinet = { maxX: 0.98 + 3 * relax, minY: -0.97 - 3 * relax, maxY: 0.97 + 3 * relax };
  const play = {
    maxX: 0.98 + (PORTRAIT_FIELD_MAX_X - 0.98) * tall,
    minY: band.bottom + BAND_MARGIN,
    maxY: band.top - BAND_MARGIN,
  };
  const points: FramePoint[] = [
    { at: FRONT_FRAME, ...cabinet, minY: -0.9 - 3 * relax },
    { at: PAYOUT_LANDING, ...play },
  ];
  for (const side of [-1, 1]) {
    const outer = side * CABINET_HALF_WIDTH;
    const inner = side * INNER_HALF_WIDTH;
    points.push(
      { at: new Vector3(outer, FINIAL_TOP_Y, CABINET_FRONT_Z), ...cabinet },
      { at: new Vector3(outer, TRAY_FLOOR_Y, CABINET_FRONT_Z), ...cabinet },
      { at: new Vector3(outer, CREST_Y, CABINET_BACK_Z), ...cabinet },
      { at: new Vector3(inner, 0, T.fieldFrontZ), ...play },
      { at: new Vector3(inner, T.pusherHeight, T.backboardFrontZ), ...play },
    );
  }
  return points;
}

const ANCHOR = new Vector3(0, 0.1, -0.1);
const HORIZON_WIDE = 0.79;
const PITCH_TALL = (46 * Math.PI) / 180;
const PITCH_SHORT = (40 * Math.PI) / 180;
const VERTICAL_FOV_WIDE = 40;
const VERTICAL_FOV_TALL = 55;
const FIT_ITERATIONS = 48;
const MAX_DISTANCE = 12;

/**
 * Frames the table for any aspect ratio. On desktop the pitch puts the sunset horizon at a
 * fixed height in frame, with the whole cabinet in view. Phones, portrait or short landscape,
 * blend towards a steeper fixed pitch and drop the horizon so the coins fill the screen. The
 * camera then comes in as close as the frame points allow and centres the playfield,
 * backboard crest (upper tier on a short landscape phone) to payout landing, in the band the
 * HUD leaves free.
 */
export function rivieraCameraPreset(aspect: number): CameraPreset {
  const safeAspect = Math.max(aspect, 0.1);
  const tall = Math.min(Math.max((1.3 - safeAspect) / (1.3 - 0.5), 0), 1);
  const short = Math.min(Math.max((safeAspect - 1.8) / (2.16 - 1.8), 0), 1);
  const fov = VERTICAL_FOV_WIDE + (VERTICAL_FOV_TALL - VERTICAL_FOV_WIDE) * tall;
  const tanV = Math.tan((fov * Math.PI) / 360);
  const tanH = tanV * safeAspect;
  const horizonPitch = Math.atan(HORIZON_WIDE * tanV);
  const relax = Math.max(tall, short);
  const phonePitch = tall >= short ? PITCH_TALL : PITCH_SHORT;
  const pitch = horizonPitch + (phonePitch - horizonPitch) * relax;
  const band = {
    top: HUD_BAND_TALL.top + (HUD_BAND_SHORT.top - HUD_BAND_TALL.top) * short,
    bottom: HUD_BAND_TALL.bottom + (HUD_BAND_SHORT.bottom - HUD_BAND_TALL.bottom) * short,
  };
  const forward = new Vector3(0, -Math.sin(pitch), -Math.cos(pitch));
  const up = new Vector3(0, Math.cos(pitch), -Math.sin(pitch));
  const points = framePoints(band, tall, relax).map((p) => {
    const offset = p.at.clone().sub(ANCHOR);
    return { ...p, along: offset.dot(forward), height: offset.dot(up) };
  });

  // A point's depth is `along + distance` and its NDC y is (height - lift) / (depth * tanV), so
  // for a given distance every window bounds the lift linearly and the fit is exact.
  const liftRange = (distance: number): { low: number; high: number } => {
    let low = -Infinity;
    let high = Infinity;
    for (const p of points) {
      const depth = p.along + distance;
      low = Math.max(low, p.height - p.maxY * depth * tanV);
      high = Math.min(high, p.height - p.minY * depth * tanV);
    }
    return { low, high };
  };
  const fits = (distance: number): boolean => {
    const { low, high } = liftRange(distance);
    return low <= high;
  };
  let near = 0;
  for (const p of points) {
    near = Math.max(near, Math.abs(p.at.x) / (p.maxX * tanH) - p.along, 0.05 - p.along);
  }
  let far = Math.max(near, MAX_DISTANCE);
  if (fits(near)) {
    far = near;
  } else {
    for (let i = 0; i < FIT_ITERATIONS; i += 1) {
      const mid = (near + far) / 2;
      if (fits(mid)) far = mid;
      else near = mid;
    }
  }
  const distance = far;
  const { low, high } = liftRange(distance);
  const top = new Vector3().lerpVectors(CREST, UPPER_TIER_REAR, short);
  const centred = centredLift([top, PAYOUT_LANDING], distance, tanV, forward, up, band);
  const lift = Math.min(Math.max(centred, low), high);

  const position = ANCHOR.clone().addScaledVector(forward, -distance).addScaledVector(up, lift);
  const target = position.clone().addScaledVector(forward, distance);
  return { position, target, fov };
}

/** The lift that puts the mean NDC y of `ends` on the middle of the band. */
function centredLift(
  ends: readonly Vector3[],
  distance: number,
  tanV: number,
  forward: Vector3,
  up: Vector3,
  band: Band,
): number {
  let weights = 0;
  let weighted = 0;
  for (const end of ends) {
    const offset = end.clone().sub(ANCHOR);
    const inverseDepth = 1 / (offset.dot(forward) + distance);
    weights += inverseDepth;
    weighted += offset.dot(up) * inverseDepth;
  }
  return (weighted - ((band.top + band.bottom) / 2) * ends.length * tanV) / weights;
}

export function applyCameraPreset(camera: PerspectiveCamera, preset: CameraPreset): void {
  camera.fov = preset.fov;
  camera.position.copy(preset.position);
  camera.lookAt(preset.target);
  camera.updateProjectionMatrix();
}
