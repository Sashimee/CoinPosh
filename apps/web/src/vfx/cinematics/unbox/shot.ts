import { ConvexHull } from 'three/addons/math/ConvexHull.js';
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
const FIT_ITERATIONS = 32;
const CENTRE_ITERATIONS = 4;
const NEAREST = 0.05;
const SAMPLE_MS = 1000 / 60;
/** Aspects a session plausibly cycles through (rotations, a resized window) stay memoized. */
const MEMO_SIZE = 16;

/** The hero placement of one unbox for one viewport aspect. Shared by the memo: read only. */
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
 * Every posed frame of one variant folded into one rigid point set. The push-in only slides the
 * camera toward the crate centre by a share `s` of the way, and a perspective view is blind to
 * scaling the scene about its eye, so a frame seen from the pushed camera projects exactly like
 * that frame's corners scaled by 1 / (1 - s) about the crate centre, seen from the venue
 * framing. The extremes of a projected point set lie on its convex hull, so the hull of every
 * scaled frame stands in for the whole sweep: one short projection pass per candidate shot.
 */
interface Swept {
  readonly rest: readonly Vector3[];
  readonly hull: readonly Vector3[];
}

interface MutableShot {
  readonly base: Vector3;
  readonly center: Vector3;
  yaw: number;
  readonly toCamera: Vector3;
}

/**
 * Stages the crate in front of the venue framing instead of in the catch tray, which the
 * cabinet front hides: on the view ray a little below the centre of the frame, at the distance
 * where it spans `REST_WIDTH` of the screen at rest. Where the screen is too short for that, it
 * comes as close as every posed frame of the variant's unbox (crate and lid, from the camera as
 * the push-in has it) allows inside `FRAME_LIMIT`, re-aimed so those frames sit centred in the
 * height. The reduced variant never hops or dollies, so its crate may stand closer. Pure
 * geometry on the venue preset, so the framing is tested without a GPU; memoized per framing,
 * aspect and variant, so a remount or a rotation back costs a lookup.
 */
export function unboxShot(
  framing: CameraPreset,
  aspect: number,
  reducedMotion: boolean,
): UnboxShot {
  const key = memoKey(framing, aspect, reducedMotion);
  const memoized = memo.get(key);
  if (memoized) return memoized;
  const shot = frameShot(framing, aspect, sweptFrames(reducedMotion));
  if (memo.size >= MEMO_SIZE) {
    const oldest = memo.keys().next();
    if (!oldest.done) memo.delete(oldest.value);
  }
  memo.set(key, shot);
  return shot;
}

/** Samples both variants' sweeps ahead of the first unbox, so no crate reveal pays for it. */
export function warmUnboxShots(): void {
  sweptFrames(false);
  sweptFrames(true);
}

const memo = new Map<string, UnboxShot>();

function memoKey(framing: CameraPreset, aspect: number, reducedMotion: boolean): string {
  const { position: p, target: t } = framing;
  const variant = reducedMotion ? 'reduced' : 'full';
  return `${variant}|${aspect}|${framing.fov}|${p.x},${p.y},${p.z}|${t.x},${t.y},${t.z}`;
}

function frameShot(framing: CameraPreset, aspect: number, sweep: Swept): UnboxShot {
  const camera = presetCamera(framing, aspect);
  const reach = framing.position.distanceTo(framing.target);
  let ndcY = SHOT_NDC_Y;
  let distance = fitDistance(camera, reach, ndcY, sweep);
  for (let i = 0; i < CENTRE_ITERATIONS; i++) {
    const shot = shotAt(camera.position, distance);
    const union = project(camera, shot, sweep.hull, emptyBounds(sweepBounds));
    const heightBound = Math.max(-union.minY, union.maxY) / FRAME_LIMIT;
    if (heightBound < 0.999 || restFill(camera, shot, sweep) >= 0.999) break;
    ndcY -= (union.minY + union.maxY) / 2;
    distance = fitDistance(camera, reach, ndcY, sweep);
  }
  const shot = shotAt(camera.position, distance);
  return {
    base: shot.base.clone(),
    center: shot.center.clone(),
    yaw: shot.yaw,
    toCamera: shot.toCamera.clone(),
  };
}

/** Aims `ray` at `ndcY` and bisects the closest distance every frame still fits at. */
function fitDistance(camera: PerspectiveCamera, reach: number, ndcY: number, sweep: Swept): number {
  ray.set(0, ndcY, 0.5).unproject(camera).sub(camera.position).normalize();
  const fill = (distance: number): number => {
    const shot = shotAt(camera.position, distance);
    const union = project(camera, shot, sweep.hull, emptyBounds(sweepBounds));
    const frame = Math.max(-union.minX, union.maxX, -union.minY, union.maxY) / FRAME_LIMIT;
    return Math.max(restFill(camera, shot, sweep), frame);
  };
  let near = NEAREST;
  let far = reach;
  if (fill(far) >= 1) return far;
  for (let i = 0; i < FIT_ITERATIONS; i++) {
    const mid = (near + far) / 2;
    if (fill(mid) > 1) near = mid;
    else far = mid;
  }
  return far;
}

function restFill(camera: PerspectiveCamera, shot: MutableShot, sweep: Swept): number {
  const bounds = project(camera, shot, sweep.rest, emptyBounds(restBounds));
  return (bounds.maxX - bounds.minX) / 2 / REST_WIDTH;
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

/** The one camera every fit projects through, re-aimed per fit rather than rebuilt. */
const scratchCamera = new PerspectiveCamera(50, 1, 0.01, 100);
const ray = new Vector3();
const trial: MutableShot = {
  base: new Vector3(),
  center: new Vector3(),
  yaw: 0,
  toCamera: new Vector3(),
};
const sweepBounds: Bounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
const restBounds: Bounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
const corner = new Vector3();

function presetCamera(framing: CameraPreset, aspect: number): PerspectiveCamera {
  scratchCamera.fov = framing.fov;
  scratchCamera.aspect = aspect;
  scratchCamera.updateProjectionMatrix();
  scratchCamera.position.copy(framing.position);
  scratchCamera.lookAt(framing.target);
  scratchCamera.updateMatrixWorld(true);
  return scratchCamera;
}

/** Poses the scratch `trial` shot `distance` along `ray` from `eye`. */
function shotAt(eye: Vector3, distance: number): MutableShot {
  trial.center.copy(eye).addScaledVector(ray, distance);
  trial.base.copy(trial.center);
  trial.base.y -= CRATE_SIZE / 2;
  trial.toCamera.copy(eye).sub(trial.center).normalize();
  trial.yaw = Math.atan2(trial.toCamera.x, trial.toCamera.z) + Math.PI / 4;
  return trial;
}

function emptyBounds(bounds: Bounds): Bounds {
  bounds.minX = Infinity;
  bounds.maxX = -Infinity;
  bounds.minY = Infinity;
  bounds.maxY = -Infinity;
  return bounds;
}

/** Widens `bounds` by `corners` (crate space, turned by the shot's yaw onto its base). */
function project(
  camera: PerspectiveCamera,
  shot: MutableShot,
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
    if (corner.x < bounds.minX) bounds.minX = corner.x;
    if (corner.x > bounds.maxX) bounds.maxX = corner.x;
    if (corner.y < bounds.minY) bounds.minY = corner.y;
    if (corner.y > bounds.maxY) bounds.maxY = corner.y;
  }
  return bounds;
}

const swept = new Map<boolean, Swept>();

/**
 * Every frame the stage poses for one variant, from the drop to the reveal hold, measured on an
 * undrawn crate built the way `UnboxStage` builds it, then folded into the hull `Swept`
 * describes. The corners are in the crate's resting space (yaw 0 at its base), so one sampling
 * serves every shot; each variant is sampled once.
 */
function sweptFrames(reducedMotion: boolean): Swept {
  const cached = swept.get(reducedMotion);
  if (cached) return cached;
  const material = new MeshBasicNodeMaterial();
  const geometry = crateGeometry();
  const rig = buildCrate(geometry, { lacquer: material, gold: material, seam: material });
  const root = new Group();
  root.add(rig.crate);
  const half = CRATE_SIZE / 2;
  const measure = (pose: UnboxPose, scale: number, into: Vector3[]): Vector3[] => {
    root.rotation.y = pose.spin;
    // The shot's yaw turns one corner to the camera, so the camera bears -45 degrees off it.
    poseCrate(rig, pose, -Math.PI / 4 - pose.spin);
    root.updateMatrixWorld(true);
    rig.crate.traverseVisible((object) => {
      if (!(object instanceof Mesh)) return;
      const mesh = object as Mesh;
      mesh.geometry.computeBoundingBox();
      const box = mesh.geometry.boundingBox;
      if (!box) throw new Error(`Unbox shot could not bound the crate part ${mesh.name}`);
      for (const x of [box.min.x, box.max.x])
        for (const y of [box.min.y, box.max.y])
          for (const z of [box.min.z, box.max.z]) {
            const point = new Vector3(x, y, z).applyMatrix4(mesh.matrixWorld);
            point.y -= half;
            point.multiplyScalar(scale);
            point.y += half;
            into.push(point);
          }
    });
    return into;
  };
  const timeline = unboxTimeline(reducedMotion);
  const points: Vector3[] = [];
  for (let ms = 0; ms <= timeline.revealAtMs + SAMPLE_MS; ms += SAMPLE_MS) {
    const pose = unboxPose(ms, timeline, reducedMotion);
    measure(pose, 1 / (1 - SHOT_PUSH * pose.dolly), points);
  }
  const rest = measure(unboxPose(0, REDUCED_UNBOX, true), 1, []);
  for (const part of [geometry.body, geometry.band, geometry.seam, geometry.lid, geometry.clasp])
    part.dispose();
  material.dispose();
  const variant = { rest, hull: hullOf(points) };
  swept.set(reducedMotion, variant);
  return variant;
}

function hullOf(points: readonly Vector3[]): Vector3[] {
  const hull = new ConvexHull().setFromPoints([...points]);
  const vertices = new Set<Vector3>();
  for (const face of hull.faces) {
    let edge = face.edge;
    do {
      vertices.add(edge.head().point);
      edge = edge.next;
    } while (edge !== face.edge);
  }
  if (vertices.size < 4) throw new Error('Unbox shot sweep folded to fewer than 4 hull points');
  return [...vertices].map((point) => point.clone());
}
