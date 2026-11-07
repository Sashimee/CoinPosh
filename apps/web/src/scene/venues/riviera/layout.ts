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

export interface CameraPreset {
  readonly position: Vector3;
  readonly target: Vector3;
  readonly fov: number;
}

const TABLE_CENTRE = new Vector3(0, 0.04, -0.08);
const ELEVATION = (25 * Math.PI) / 180;
const LOOK_PITCH_WIDE = (20.5 * Math.PI) / 180;
const LOOK_PITCH_TALL = (24 * Math.PI) / 180;
const VERTICAL_FOV = 44;
const FIT_HALF_WIDTH = 0.5;
const MIN_DISTANCE = 1.7;

/**
 * Frames the table for any aspect ratio. The camera sits on a fixed elevation above the table
 * centre and backs off until the cabinet's full width fits, but looks a little shallower than
 * its elevation so the table sits low in frame and the sunset horizon stays visible above it.
 * Tall (portrait) frames have sky to spare, so they look further down to keep the tray in shot.
 */
export function rivieraCameraPreset(aspect: number): CameraPreset {
  const halfV = (VERTICAL_FOV * Math.PI) / 360;
  const halfH = Math.atan(Math.tan(halfV) * Math.max(aspect, 0.1));
  const distance = Math.max(FIT_HALF_WIDTH / Math.tan(halfH), MIN_DISTANCE);
  const position = new Vector3(
    0,
    TABLE_CENTRE.y + Math.sin(ELEVATION) * distance,
    TABLE_CENTRE.z + Math.cos(ELEVATION) * distance,
  );
  const tall = Math.min(Math.max((1.3 - aspect) / (1.3 - 0.45), 0), 1);
  const pitch = LOOK_PITCH_WIDE + (LOOK_PITCH_TALL - LOOK_PITCH_WIDE) * tall;
  const target = position
    .clone()
    .add(new Vector3(0, -Math.sin(pitch), -Math.cos(pitch)).multiplyScalar(distance));
  return { position, target, fov: VERTICAL_FOV };
}

export function applyCameraPreset(camera: PerspectiveCamera, preset: CameraPreset): void {
  camera.fov = preset.fov;
  camera.position.copy(preset.position);
  camera.lookAt(preset.target);
  camera.updateProjectionMatrix();
}
