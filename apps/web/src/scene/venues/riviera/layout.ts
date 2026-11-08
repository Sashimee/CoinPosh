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
/**
 * Catch tray length ahead of the payout edge: one coin lands flat behind the front moulding.
 * Any longer and the empty velvet reads as a dark box under the lip at the game camera.
 */
const TRAY_LENGTH = 0.05;
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
 * Bearing of the low sunset in the backdrop frame: almost dead astern and a touch to port. The
 * camera looks down at the cabinet and keeps the sky out of frame, so the disc itself is never
 * seen; it sets the warm glow on the sea and the glints the lacquer and gold pick up.
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
/** Clearance kept between the coin floor and the band edges, in NDC. */
const BAND_MARGIN = 0.025;
/**
 * Widest NDC x the coin floor may reach on a portrait phone. P-131 settles it at 0.92, not the
 * 0.7 agreed with P-119 nor the 0.85 P-99 needed: a portrait frame is width-bound, and below
 * 0.92 the 36 cm floor is too narrow on screen for the cabinet to run from the backboard crest
 * at the top down to a lip in the lower 40 % of the frame; bare deck fills the gap above. The
 * side meters keep to the 4 % left at each edge beside the lip, or go translucent (P-133).
 */
export const PORTRAIT_FIELD_MAX_X = 0.92;
/** Widest NDC x the coin floor may reach on any other screen. */
const FIELD_MAX_X = 0.96;
/**
 * NDC y of the backboard crest, and the lowest it may drop to on a portrait phone so the lip
 * reaches the lower 40 %: at most 13 % of the frame shows deck above the backboard, so the
 * table, not the yacht, fills the screen.
 */
const CREST_NDC_Y = 0.78;
const CREST_MIN_NDC_Y = 0.74;
/** Highest NDC y of the payout edge: the lip sits in the lower 40 % of the frame. */
const LIP_MAX_NDC_Y = -0.22;
/**
 * Share of the HUD band the playfield fills, from the backboard crest (or the band top, if the
 * crest is under the Vault plaque) down to the payout lip, wherever the width allows it.
 */
const PLAYFIELD_SHARE = 0.84;
/**
 * Lowest NDC y of the top of the stern bulwark: past it is open sea and sky, held to a sliver
 * along the top edge. Every frame looks down at the table; none is a seascape.
 */
const SEA_MIN_NDC_Y = 0.92;

const T = RIVIERA_TABLE;
const CREST = new Vector3(
  0,
  T.pusherHeight + 0.004 + T.backboardHeight + 0.034,
  T.backboardFrontZ - T.backboardDepth,
);

/** The payout edge of the coin floor, on the centre line. */
export const COIN_FLOOR_FRONT = new Vector3(0, 0, T.fieldFrontZ);
const STERN_BULWARK_TOP = new Vector3(0, T.deckY + RIVIERA_DECK.bulwarkHeight, RIVIERA_DECK.sternZ);

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

/** The coin floor corners: inside the HUD band, and clear of the side meters on a phone. */
function floorCorners(band: Band, maxX: number): FramePoint[] {
  const window = { maxX, minY: band.bottom + BAND_MARGIN, maxY: band.top - BAND_MARGIN };
  const points: FramePoint[] = [];
  for (const side of [-1, 1]) {
    const x = side * T.fieldHalfWidth;
    points.push(
      { at: new Vector3(x, 0, T.fieldFrontZ), ...window },
      { at: new Vector3(x, T.pusherHeight, T.backboardFrontZ), ...window },
    );
  }
  return points;
}

const ANCHOR = new Vector3(0, 0.1, -0.1);
const DEGREES = Math.PI / 180;
/**
 * Pitch below the horizontal: the 35 to 45 degrees of a player standing at the cabinet, low
 * enough that coin rims and stack heights read and the overhang at the lip is a ledge, not a
 * line.
 */
const PITCH_WIDE = 40 * DEGREES;
const PITCH_TALL = 43 * DEGREES;
const PITCH_SHORT = 38 * DEGREES;
/** A long lens keeps the backboard nearly as large as the lip, so the cabinet fills the frame. */
const VERTICAL_FOV = 35;
const FIT_ITERATIONS = 48;
const MAX_DISTANCE = 12;

/**
 * Frames the table for any aspect ratio from a player's pitch over the cabinet: the backboard
 * crest near the top edge and the payout lip low in the HUD band, so the playfield fills the
 * screen and the sea and sky stay out of it. Where the screen is too narrow for that (a portrait
 * phone) the coin floor's width sets the distance instead, and the frame drops until the lip
 * is in the lower 40 %, as far as the crest allows. The coin floor always stays in the band the
 * HUD leaves free, and the stern bulwark hides the sea behind the cabinet.
 */
export function rivieraCameraPreset(aspect: number): CameraPreset {
  const safeAspect = Number.isFinite(aspect) ? Math.max(aspect, 0.1) : 1;
  const tall = Math.min(Math.max((1.3 - safeAspect) / (1.3 - 0.5), 0), 1);
  const short = Math.min(Math.max((safeAspect - 1.8) / (2.16 - 1.8), 0), 1);
  const fov = VERTICAL_FOV;
  const tanV = Math.tan((fov * Math.PI) / 360);
  const tanH = tanV * safeAspect;
  const phonePitch = tall >= short ? PITCH_TALL : PITCH_SHORT;
  const pitch = PITCH_WIDE + (phonePitch - PITCH_WIDE) * Math.max(tall, short);
  const band = {
    top: HUD_BAND_TALL.top + (HUD_BAND_SHORT.top - HUD_BAND_TALL.top) * short,
    bottom: HUD_BAND_TALL.bottom + (HUD_BAND_SHORT.bottom - HUD_BAND_TALL.bottom) * short,
  };
  const forward = new Vector3(0, -Math.sin(pitch), -Math.cos(pitch));
  const up = new Vector3(0, Math.cos(pitch), -Math.sin(pitch));
  const local = (at: Vector3): { along: number; height: number } => {
    const offset = at.clone().sub(ANCHOR);
    return { along: offset.dot(forward), height: offset.dot(up) };
  };
  const maxX = FIELD_MAX_X + (PORTRAIT_FIELD_MAX_X - FIELD_MAX_X) * tall;
  const points = floorCorners(band, maxX).map((p) => ({ ...p, ...local(p.at) }));

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

  // The crest at CREST_NDC_Y and the lip at lipY fix both the distance and the lift.
  const lipY = Math.min(LIP_MAX_NDC_Y, band.top - PLAYFIELD_SHARE * (band.top - band.bottom));
  const crest = local(CREST);
  const lip = local(COIN_FLOOR_FRONT);
  const composed =
    ((crest.height - lip.height) / tanV - CREST_NDC_Y * crest.along + lipY * lip.along) /
    (CREST_NDC_Y - lipY);
  const distance = Math.max(far, composed);
  const { low, high } = liftRange(distance);
  const sea = local(STERN_BULWARK_TOP);
  const liftFor = (p: { along: number; height: number }, y: number): number =>
    p.height - y * (p.along + distance) * tanV;
  const composedLift = Math.min(
    Math.max(liftFor(crest, CREST_NDC_Y), liftFor(lip, LIP_MAX_NDC_Y)),
    liftFor(crest, CREST_MIN_NDC_Y),
  );
  const lift = Math.min(Math.max(Math.min(composedLift, liftFor(sea, SEA_MIN_NDC_Y)), low), high);

  const position = ANCHOR.clone().addScaledVector(forward, -distance).addScaledVector(up, lift);
  const target = position.clone().addScaledVector(forward, distance);
  return { position, target, fov };
}

export function applyCameraPreset(camera: PerspectiveCamera, preset: CameraPreset): void {
  camera.fov = preset.fov;
  camera.position.copy(preset.position);
  camera.lookAt(preset.target);
  camera.updateProjectionMatrix();
}
