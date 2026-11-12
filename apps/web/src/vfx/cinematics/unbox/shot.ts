import { PerspectiveCamera, Vector3 } from 'three/webgpu';
import type { CameraPreset } from '../../../scene/venues/riviera/layout.ts';
import { CRATE_SIZE, LID_OVERHANG } from './stage.ts';

/** Where the crate's centre sits on screen at the venue framing, in NDC (centre is 0, 0). */
const SHOT_NDC_Y = -0.12;
/** Share of the viewport width the crate spans at rest, corner on, before the push-in. */
const REST_WIDTH = 0.5;
/**
 * Most of the viewport height the crate may span at full push-in, hopping and stretched. On a
 * wide landscape screen this is the binding limit, so the crate is never cropped there.
 */
const MAX_HEIGHT = 0.8;
/** How far along the line to the crate the camera pushes in at the dolly's deepest. */
export const SHOT_PUSH = 0.14;
/** Headroom the stage may use above the crate's resting top while it hops in or stretches. */
const HEADROOM = CRATE_SIZE;
const FIT_ITERATIONS = 40;
const NEAREST = 0.05;

/** The hero placement of one unbox for one viewport aspect. */
export interface UnboxShot {
  /** Centre of the crate's base, in world space. */
  readonly base: Vector3;
  /** Centre of the crate body: what the push-in travels toward. */
  readonly center: Vector3;
  /** Resting yaw: one corner points at the camera, so two lacquer faces and the top read. */
  readonly yaw: number;
  /** Unit vector from the crate toward the camera, for the key light. */
  readonly toCamera: Vector3;
}

/**
 * Stages the crate in front of the venue framing instead of in the catch tray, which the
 * cabinet front hides: on the view ray a little below the centre of the frame, at the distance
 * where it spans `REST_WIDTH` of the screen, or less where the screen is too short for that.
 * Pure geometry on the venue preset, so the framing can be tested without a GPU.
 */
export function unboxShot(framing: CameraPreset, aspect: number): UnboxShot {
  const camera = presetCamera(framing, aspect);
  const ray = new Vector3(0, SHOT_NDC_Y, 0.5).unproject(camera).sub(camera.position).normalize();
  const reach = framing.position.distanceTo(framing.target);
  const at = (distance: number): UnboxShot => shotAt(camera.position, ray, distance);
  const fill = (distance: number): number => {
    const shot = at(distance);
    const rest = crateExtent(camera, shot, 0);
    const pushed = crateExtent(pushedCamera(framing, aspect, shot.center, 1), shot, HEADROOM);
    return Math.max(rest.width / REST_WIDTH, pushed.height / MAX_HEIGHT);
  };
  let near = NEAREST;
  let far = reach;
  if (fill(far) >= 1) return at(far);
  for (let i = 0; i < FIT_ITERATIONS; i++) {
    const mid = (near + far) / 2;
    if (fill(mid) > 1) near = mid;
    else far = mid;
  }
  return at(far);
}

/** The eye and look-at of the push-in: the venue framing slid toward the crate by `dolly`. */
export function pushIn(
  framing: CameraPreset,
  center: Vector3,
  dolly: number,
  eye: Vector3,
  look: Vector3,
): void {
  eye
    .copy(center)
    .sub(framing.position)
    .multiplyScalar(SHOT_PUSH * dolly);
  look.copy(framing.target).add(eye);
  eye.add(framing.position);
}

function presetCamera(framing: CameraPreset, aspect: number): PerspectiveCamera {
  const camera = new PerspectiveCamera(framing.fov, aspect, 0.01, 100);
  camera.position.copy(framing.position);
  camera.lookAt(framing.target);
  camera.updateMatrixWorld(true);
  return camera;
}

function pushedCamera(
  framing: CameraPreset,
  aspect: number,
  center: Vector3,
  dolly: number,
): PerspectiveCamera {
  const eye = new Vector3();
  const look = new Vector3();
  pushIn(framing, center, dolly, eye, look);
  return presetCamera({ position: eye, target: look, fov: framing.fov }, aspect);
}

function shotAt(eye: Vector3, ray: Vector3, distance: number): UnboxShot {
  const center = eye.clone().addScaledVector(ray, distance);
  const base = center.clone();
  base.y -= CRATE_SIZE / 2;
  const toCamera = eye.clone().sub(center).normalize();
  const yaw = Math.atan2(toCamera.x, toCamera.z) + Math.PI / 4;
  return { base, center, yaw, toCamera };
}

const corner = new Vector3();

/** NDC extent of the crate (lid overhang included) seen from `camera`, as shares of the view. */
function crateExtent(
  camera: PerspectiveCamera,
  shot: UnboxShot,
  headroom: number,
): { width: number; height: number } {
  const half = (CRATE_SIZE * LID_OVERHANG) / 2;
  const cos = Math.cos(shot.yaw);
  const sin = Math.sin(shot.yaw);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const x of [-half, half]) {
    for (const z of [-half, half]) {
      for (const y of [0, CRATE_SIZE + headroom]) {
        corner
          .set(x * cos + z * sin, y, -x * sin + z * cos)
          .add(shot.base)
          .project(camera);
        minX = Math.min(minX, corner.x);
        maxX = Math.max(maxX, corner.x);
        minY = Math.min(minY, corner.y);
        maxY = Math.max(maxY, corner.y);
      }
    }
  }
  return { width: (maxX - minX) / 2, height: (maxY - minY) / 2 };
}
