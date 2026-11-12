import { Group, Mesh, MeshBasicNodeMaterial, PerspectiveCamera, Vector3 } from 'three/webgpu';
import type { CameraPreset } from '../../../scene/venues/riviera/layout.ts';
import { REDUCED_UNBOX, unboxPose, unboxTimeline, type UnboxPose } from './plan.ts';
import { buildCrate, CRATE_SIZE, crateGeometry, poseCrate } from './stage.ts';

/** Where the crate's centre sits on screen at the venue framing, in NDC (centre is 0, 0). */
const SHOT_NDC_Y = -0.12;
/** Share of the viewport width the crate spans at rest, corner on, before the push-in. */
const REST_WIDTH = 0.5;
/**
 * How far from the centre, in NDC, any part of the crate or its lid may reach on any frame of
 * the unbox. On a wide landscape screen the height is the binding limit, so the crate is never
 * cropped there and the camera kick has a margin to shake in.
 */
const FRAME_LIMIT = 0.9;
/** How far along the line to the crate the camera pushes in at the dolly's deepest. */
export const SHOT_PUSH = 0.14;
const FIT_ITERATIONS = 40;
const CENTRE_ITERATIONS = 4;
const NEAREST = 0.05;
const SAMPLE_MS = 1000 / 60;

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

/** NDC bounds of the crate on one frame, as shares of the view from the centre. */
interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * Stages the crate in front of the venue framing instead of in the catch tray, which the
 * cabinet front hides: on the view ray a little below the centre of the frame, at the distance
 * where it spans `REST_WIDTH` of the screen at rest. Where the screen is too short for that, it
 * comes as close as every posed frame of the variant's unbox (crate and lid, from the camera as
 * the push-in has it) allows inside `FRAME_LIMIT`, re-aimed so those frames sit centred in the
 * height. The reduced variant never hops or dollies, so its crate may stand closer. Pure geometry on the venue preset, so the framing is tested without a GPU.
 */
export function unboxShot(
  framing: CameraPreset,
  aspect: number,
  reducedMotion: boolean,
): UnboxShot {
  const camera = presetCamera(framing, aspect);
  const reach = framing.position.distanceTo(framing.target);
  const { rest, frames } = stagedFrames(reducedMotion);
  let ndcY = SHOT_NDC_Y;
  let shot = fitShot(framing, aspect, camera, reach, ndcY, rest, frames);
  for (let i = 0; i < CENTRE_ITERATIONS; i++) {
    const union = sweep(framing, aspect, shot, frames);
    const heightBound = Math.max(-union.minY, union.maxY) / FRAME_LIMIT;
    if (heightBound < 0.999 || restFill(camera, shot, rest) >= 0.999) break;
    ndcY -= (union.minY + union.maxY) / 2;
    shot = fitShot(framing, aspect, camera, reach, ndcY, rest, frames);
  }
  return shot;
}

function fitShot(
  framing: CameraPreset,
  aspect: number,
  camera: PerspectiveCamera,
  reach: number,
  ndcY: number,
  rest: readonly Vector3[],
  frames: readonly StagedFrame[],
): UnboxShot {
  const ray = new Vector3(0, ndcY, 0.5).unproject(camera).sub(camera.position).normalize();
  const at = (distance: number): UnboxShot => shotAt(camera.position, ray, distance);
  const fill = (distance: number): number => {
    const shot = at(distance);
    const union = sweep(framing, aspect, shot, frames);
    const frame = Math.max(-union.minX, union.maxX, -union.minY, union.maxY) / FRAME_LIMIT;
    return Math.max(restFill(camera, shot, rest), frame);
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

function restFill(camera: PerspectiveCamera, shot: UnboxShot, rest: readonly Vector3[]): number {
  const bounds = project(camera, shot, rest, emptyBounds());
  return (bounds.maxX - bounds.minX) / 2 / REST_WIDTH;
}

/** Union of the crate's NDC bounds over every staged frame, each seen from its pushed camera. */
function sweep(
  framing: CameraPreset,
  aspect: number,
  shot: UnboxShot,
  frames: readonly StagedFrame[],
): Bounds {
  const union = emptyBounds();
  let dolly = Number.NaN;
  let camera: PerspectiveCamera | null = null;
  for (const frame of frames) {
    if (camera === null || frame.dolly !== dolly) {
      dolly = frame.dolly;
      camera = pushedCamera(framing, aspect, shot.center, dolly);
    }
    project(camera, shot, frame.corners, union);
  }
  return union;
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

function emptyBounds(): Bounds {
  return { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
}

/** Widens `bounds` by `corners` (crate space, turned by the shot's yaw onto its base). */
function project(
  camera: PerspectiveCamera,
  shot: UnboxShot,
  corners: readonly Vector3[],
  bounds: Bounds,
): Bounds {
  const cos = Math.cos(shot.yaw);
  const sin = Math.sin(shot.yaw);
  for (const c of corners) {
    corner
      .set(c.x * cos + c.z * sin, c.y, -c.x * sin + c.z * cos)
      .add(shot.base)
      .project(camera);
    bounds.minX = Math.min(bounds.minX, corner.x);
    bounds.maxX = Math.max(bounds.maxX, corner.x);
    bounds.minY = Math.min(bounds.minY, corner.y);
    bounds.maxY = Math.max(bounds.maxY, corner.y);
  }
  return bounds;
}

/** One sampled frame of the unbox: the camera's dolly and the posed crate's box corners. */
interface StagedFrame {
  readonly dolly: number;
  readonly corners: readonly Vector3[];
}

interface Staged {
  readonly rest: readonly Vector3[];
  readonly frames: readonly StagedFrame[];
}

const staged = new Map<boolean, Staged>();

/**
 * Every frame the stage poses for one variant, from the drop to the reveal hold, measured on an
 * undrawn crate built the way `UnboxStage` builds it. The corners are in the crate's resting
 * space (yaw 0 at its base), so one sampling serves every shot; each variant is sampled once.
 */
function stagedFrames(reducedMotion: boolean): Staged {
  const cached = staged.get(reducedMotion);
  if (cached) return cached;
  const material = new MeshBasicNodeMaterial();
  const geometry = crateGeometry();
  const rig = buildCrate(geometry, { lacquer: material, gold: material, seam: material });
  const root = new Group();
  root.add(rig.crate);
  const measure = (pose: UnboxPose): Vector3[] => {
    root.rotation.y = pose.spin;
    // The shot's yaw turns one corner to the camera, so the camera bears -45 degrees off it.
    poseCrate(rig, pose, -Math.PI / 4 - pose.spin);
    root.updateMatrixWorld(true);
    const corners: Vector3[] = [];
    rig.crate.traverseVisible((object) => {
      if (!(object instanceof Mesh)) return;
      const mesh = object as Mesh;
      mesh.geometry.computeBoundingBox();
      const box = mesh.geometry.boundingBox;
      if (!box) throw new Error(`Unbox shot could not bound the crate part ${mesh.name}`);
      for (const x of [box.min.x, box.max.x])
        for (const y of [box.min.y, box.max.y])
          for (const z of [box.min.z, box.max.z])
            corners.push(new Vector3(x, y, z).applyMatrix4(mesh.matrixWorld));
    });
    return corners;
  };
  const timeline = unboxTimeline(reducedMotion);
  const frames: StagedFrame[] = [];
  for (let ms = 0; ms <= timeline.revealAtMs + SAMPLE_MS; ms += SAMPLE_MS) {
    const pose = unboxPose(ms, timeline, reducedMotion);
    frames.push({ dolly: pose.dolly, corners: measure(pose) });
  }
  const rest = measure(unboxPose(0, REDUCED_UNBOX, true));
  for (const part of [geometry.body, geometry.band, geometry.seam, geometry.lid, geometry.clasp])
    part.dispose();
  material.dispose();
  const variant = { rest, frames };
  staged.set(reducedMotion, variant);
  return variant;
}
