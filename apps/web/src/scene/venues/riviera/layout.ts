import type { PerspectiveCamera } from 'three/webgpu';
import { Vector3 } from 'three/webgpu';

/**
 * Riviera table dimensions in metres. +Y is up, the player stands at +Z, and the lower
 * playfield surface is y = 0. The sim (T-1.01) owns the physical table; these numbers are
 * the visual shell and should be aligned with it when the two are wired together.
 */
export const RIVIERA_TABLE = {
  fieldHalfWidth: 0.28,
  fieldFrontZ: 0.36,
  gutterWidth: 0.045,
  gutterDepth: 0.06,
  wallThickness: 0.05,
  wallHeight: 0.1,
  glassHeight: 0.16,
  pusherHeight: 0.07,
  pusherFrontZ: -0.3,
  pusherStroke: 0.12,
  pusherDepth: 0.5,
  backboardFrontZ: -0.5,
  backboardDepth: 0.12,
  backboardHeight: 0.36,
  cabinetFrontZ: 0.5,
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

const TABLE_CENTRE = new Vector3(0, 0.04, -0.08);
const ELEVATION = (22 * Math.PI) / 180;
const LOOK_PITCH_WIDE = (15 * Math.PI) / 180;
const LOOK_PITCH_TALL = (11 * Math.PI) / 180;
const VERTICAL_FOV_WIDE = 44;
const VERTICAL_FOV_TALL = 56;
const FIT_HALF_WIDTH = 0.56;
const MIN_DISTANCE = 2.4;

/**
 * Frames the table for any aspect ratio. The camera sits on a fixed elevation above the table
 * centre and backs off until the cabinet's full width fits (never closer than enough to keep
 * the tray, finials and the top of the front panel's gold frame clear of the bottom edge on
 * wide screens), but looks shallower than its elevation so the table sits low in frame with
 * the sunset horizon and sun above it. Tall
 * (portrait) frames widen the vertical field of view so the cabinet fits closer, and look up
 * a little so the sky fills the space above the backboard instead of the cabinet's front panel.
 */
export function rivieraCameraPreset(aspect: number): CameraPreset {
  const tall = Math.min(Math.max((1.3 - aspect) / (1.3 - 0.45), 0), 1);
  const fov = VERTICAL_FOV_WIDE + (VERTICAL_FOV_TALL - VERTICAL_FOV_WIDE) * tall;
  const halfV = (fov * Math.PI) / 360;
  const halfH = Math.atan(Math.tan(halfV) * Math.max(aspect, 0.1));
  const distance = Math.max(FIT_HALF_WIDTH / Math.tan(halfH), MIN_DISTANCE);
  const position = new Vector3(
    0,
    TABLE_CENTRE.y + Math.sin(ELEVATION) * distance,
    TABLE_CENTRE.z + Math.cos(ELEVATION) * distance,
  );
  const pitch = LOOK_PITCH_WIDE + (LOOK_PITCH_TALL - LOOK_PITCH_WIDE) * tall;
  const target = position
    .clone()
    .add(new Vector3(0, -Math.sin(pitch), -Math.cos(pitch)).multiplyScalar(distance));
  return { position, target, fov };
}

export function applyCameraPreset(camera: PerspectiveCamera, preset: CameraPreset): void {
  camera.fov = preset.fov;
  camera.position.copy(preset.position);
  camera.lookAt(preset.target);
  camera.updateProjectionMatrix();
}
