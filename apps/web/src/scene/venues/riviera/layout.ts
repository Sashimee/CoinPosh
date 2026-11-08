import type { PerspectiveCamera } from 'three/webgpu';
import { Vector3 } from 'three/webgpu';
// TODO(lead-architect, #20): import from '@coinposh/sim' once it exposes the table layout without
// pulling Rapier into the main bundle. This module has no imports of its own: constants only.
import {
  BACKBOARD,
  GUTTER_START_Z,
  PLAYFIELD,
  PUSHER,
} from '../../../../../../packages/sim/src/table/layout.ts';

/** Lacquer side wall height; the glass above it carries the wall up to the sim's wall height. */
const SIDE_WALL_HEIGHT = 0.07;
/** Rear clearance between the fully retracted pusher block and the back of the cabinet. */
const PUSHER_REAR_CLEARANCE = 0.01;
/** Catch tray length ahead of the payout edge: room for about three coins side by side. */
const TRAY_LENGTH = 0.09;
/** How far the backboard face rises above the sim's back wall, to seat the gold crest. */
const BACKBOARD_HEADROOM = 0.016;

/**
 * Riviera table dimensions in metres. +Y is up, the player stands at +Z, and the lower
 * playfield surface is y = 0. Everything a coin can touch comes from the sim's table layout
 * (T-1.01), so rendered coins sit on the rendered table; the rest is the visual shell around
 * it, proportioned to that table.
 */
export const RIVIERA_TABLE = {
  fieldHalfWidth: PLAYFIELD.fieldHalfWidth,
  fieldFrontZ: PLAYFIELD.fieldFrontZ,
  gutterWidth: PLAYFIELD.gutterWidth,
  /** Behind this z, guide walls hug the coin floor at ±fieldHalfWidth; ahead of it the gutters open. */
  gutterStartZ: GUTTER_START_Z,
  gutterDepth: 0.04,
  wallThickness: 0.028,
  wallHeight: SIDE_WALL_HEIGHT,
  glassHeight: PLAYFIELD.wallHeight - SIDE_WALL_HEIGHT,
  pusherHeight: PUSHER.height,
  pusherFrontZ: PUSHER.frontZ,
  pusherStroke: PUSHER.stroke,
  pusherDepth: PUSHER.depth,
  backboardFrontZ: BACKBOARD.frontZ,
  backboardDepth: 0.05,
  /** Back of the cabinet: far enough that the retracted block never pokes out of it. */
  cabinetBackZ: PUSHER.frontZ - PUSHER.depth - PUSHER_REAR_CLEARANCE,
  backboardHeight: PLAYFIELD.wallHeight - PUSHER.height + BACKBOARD_HEADROOM,
  cabinetFrontZ: PLAYFIELD.fieldFrontZ + TRAY_LENGTH,
  /** Catch tray floor depth below the coin floor. */
  trayDepth: 0.075,
  deckY: -0.85,
} as const;

export type RivieraTableLayout = { readonly [K in keyof typeof RIVIERA_TABLE]: number };

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
 * dock, measured in Demo Mode, whose banner pushes the plaque down (390x844: plaque bottom
 * 164 px, dock top 774 px; 844x390: 137 px and 324 px). Without the banner the band is only
 * taller, so the table still clears the HUD.
 */
export const HUD_BAND_TALL = { top: 0.611, bottom: -0.834 } as const;
export const HUD_BAND_SHORT = { top: 0.297, bottom: -0.662 } as const;
/** Clearance kept between the framed play area and the band edges, in NDC. */
const BAND_MARGIN = 0.025;
/**
 * Widest NDC x the coin floor may reach on a portrait phone, so the Decorum and Cascade meters
 * pinned to the screen edges (P-119) sit beside the coins, not over them.
 */
export const PORTRAIT_FIELD_MAX_X = 0.7;
/** NDC y of the sea horizon on desktop: the sun hangs just above it. */
const HORIZON_WIDE = 0.7;
/**
 * On desktop the backboard crest stays this far below the horizon, in NDC, so the sea line runs
 * unbroken behind the cabinet and the low sun never sets behind the backboard.
 */
const CREST_HORIZON_CLEARANCE = 0.32;

const T = RIVIERA_TABLE;
const INNER_HALF_WIDTH = T.fieldHalfWidth + T.gutterWidth;
/** Outermost gold at the cabinet front: the finials and the plinth rods. */
const CABINET_HALF_WIDTH = INNER_HALF_WIDTH + T.wallThickness + 0.03;
const CABINET_FRONT_Z = T.cabinetFrontZ + 0.035;
const CREST_BACK_Z = T.backboardFrontZ - T.backboardDepth;
const CREST_Y = T.pusherHeight + 0.004 + T.backboardHeight + 0.034;
const FINIAL_TOP_Y = T.wallHeight + 0.036;
const TRAY_FLOOR_Y = -T.trayDepth;

/**
 * The play area: the coin floor's front corners, the back of the upper tier where it meets the
 * backboard, and the top of the sim's back wall, the highest anything in play can reach.
 */
export const PLAYFIELD_FRONT = new Vector3(0, 0, T.fieldFrontZ);
export const PLAYFIELD_TOP = new Vector3(0, PLAYFIELD.wallHeight, T.backboardFrontZ);
const UPPER_TIER_REAR = new Vector3(0, T.pusherHeight, T.backboardFrontZ);
/** Where paid-out coins land: the catch tray floor just ahead of the payout edge. */
const PAYOUT_LANDING = new Vector3(0, TRAY_FLOOR_Y, T.fieldFrontZ + 0.03);
/** Top of the front panel's gold frame; desktop frames keep it clear of the bottom edge. */
const FRONT_FRAME = new Vector3(0, TRAY_FLOOR_Y - 0.05, CABINET_FRONT_Z);

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

const OFF_SCREEN = 3;

/**
 * Three kinds of frame point. The coin floor always sits inside the HUD band, clear of the side
 * meters on a portrait phone. The rest of the play area (the top of the back wall, the payout
 * landing) shares the band too, except on a short landscape phone (`short`), where there is
 * not the height for it and the coins come first. The cabinet points (finials, front panel,
 * backboard crest) keep the whole cabinet in frame on desktop, the crest below the horizon; on
 * a phone, `relax` (0..1) lets them run off the edges and under the HUD so the coins come closer.
 */
function framePoints(band: Band, tall: number, short: number, relax: number): FramePoint[] {
  const off = OFF_SCREEN * relax;
  const cabinet = { maxX: 0.98 + off, minY: -0.97 - off, maxY: 0.97 + off };
  const crest = { ...cabinet, maxY: HORIZON_WIDE - CREST_HORIZON_CLEARANCE + off };
  const floor = {
    maxX: 0.98 + (PORTRAIT_FIELD_MAX_X - 0.98) * tall,
    minY: band.bottom + BAND_MARGIN,
    maxY: band.top - BAND_MARGIN,
  };
  const reach = {
    maxX: 0.98 + off,
    minY: floor.minY - OFF_SCREEN * short,
    maxY: floor.maxY + OFF_SCREEN * short,
  };
  const points: FramePoint[] = [
    { at: FRONT_FRAME, ...cabinet, minY: -0.9 - off },
    { at: PAYOUT_LANDING, ...reach },
    { at: PLAYFIELD_TOP, ...reach },
  ];
  for (const side of [-1, 1]) {
    const outer = side * CABINET_HALF_WIDTH;
    const field = side * T.fieldHalfWidth;
    points.push(
      { at: new Vector3(outer, FINIAL_TOP_Y, CABINET_FRONT_Z), ...cabinet },
      { at: new Vector3(outer, TRAY_FLOOR_Y, CABINET_FRONT_Z), ...cabinet },
      { at: new Vector3(outer, CREST_Y, CREST_BACK_Z), ...crest },
      { at: new Vector3(field, 0, T.fieldFrontZ), ...floor },
      { at: new Vector3(field, T.pusherHeight, T.backboardFrontZ), ...floor },
    );
  }
  return points;
}

const ANCHOR = new Vector3(0, 0.1, -0.1);
const PITCH_TALL = (62 * Math.PI) / 180;
const PITCH_SHORT = (52 * Math.PI) / 180;
const VERTICAL_FOV_WIDE = 40;
const VERTICAL_FOV_TALL = 66;
const FIT_ITERATIONS = 48;
const MAX_DISTANCE = 12;

/**
 * Frames the table for any aspect ratio. On desktop the pitch puts the sunset horizon at a
 * fixed height in frame, with the whole cabinet in view. Phones, portrait or short landscape,
 * blend towards a steeper fixed pitch and drop the horizon so the coins fill the screen. The
 * camera then comes in as close as the frame points allow and centres the play area (the top
 * of the back wall, or the upper tier on a short landscape phone, down to the payout landing,
 * or the payout edge) in the band the HUD leaves free.
 */
export function rivieraCameraPreset(aspect: number): CameraPreset {
  const safeAspect = Number.isFinite(aspect) ? Math.max(aspect, 0.1) : 1;
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
  const points = framePoints(band, tall, short, relax).map((p) => {
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
  const top = new Vector3().lerpVectors(PLAYFIELD_TOP, UPPER_TIER_REAR, short);
  const bottom = new Vector3().lerpVectors(PAYOUT_LANDING, PLAYFIELD_FRONT, short);
  const centred = centredLift([top, bottom], distance, tanV, forward, up, band);
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
