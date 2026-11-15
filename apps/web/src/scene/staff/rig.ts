import {
  Bone,
  Euler,
  Group,
  Matrix4,
  type Object3D,
  Quaternion,
  Skeleton,
  Vector3,
} from 'three/webgpu';

/**
 * Every figure carries the same skeleton, so all three share one shader program. Props ride
 * bones too (a salver lid, a pour, a fill line, the trunk they sit on when on leave): a prop
 * that is not in play is scaled to nothing instead of costing a mesh of its own.
 */
export const BONES = [
  'root',
  'pelvis',
  'spine',
  'chest',
  'head',
  'hat',
  'shoulderL',
  'elbowL',
  'handL',
  'propL',
  'lid',
  'fill',
  'shoulderR',
  'elbowR',
  'handR',
  'propR',
  'hipL',
  'kneeL',
  'hipR',
  'kneeR',
  'trunk',
  'stream',
] as const;

export type BoneName = (typeof BONES)[number];

const PARENT: Readonly<Record<BoneName, BoneName | null>> = {
  root: null,
  pelvis: 'root',
  spine: 'pelvis',
  chest: 'spine',
  head: 'chest',
  hat: 'head',
  shoulderL: 'chest',
  elbowL: 'shoulderL',
  handL: 'elbowL',
  propL: 'handL',
  lid: 'propL',
  fill: 'propL',
  shoulderR: 'chest',
  elbowR: 'shoulderR',
  handR: 'elbowR',
  propR: 'handR',
  hipL: 'pelvis',
  kneeL: 'hipL',
  hipR: 'pelvis',
  kneeR: 'hipR',
  trunk: 'root',
  stream: 'root',
};

export const BONE_INDEX: Readonly<Record<BoneName, number>> = Object.fromEntries(
  BONES.map((name, i) => [name, i]),
) as Record<BoneName, number>;

export type Vec3 = readonly [number, number, number];

/**
 * Joint positions in the bind pose, metres in the figure's frame: +Y up, facing +Z, the floor at
 * y = 0, the figure's left hand on +X. Arms hang straight and legs stand straight; every pose is
 * a rotation of these joints.
 */
export const JOINTS: Readonly<Record<BoneName, Vec3>> = {
  root: [0, 0, 0],
  pelvis: [0, 0.029, 0],
  spine: [0, 0.0335, 0],
  chest: [0, 0.0445, 0],
  head: [0, 0.0585, 0],
  hat: [0, 0.0752, 0],
  shoulderL: [0.0098, 0.0536, 0],
  elbowL: [0.0106, 0.0412, 0],
  handL: [0.0112, 0.0297, 0],
  propL: [0.0112, 0.0269, 0],
  lid: [0.0112, 0.0294, -0.0066],
  fill: [0.0112, 0.0298, 0.0026],
  shoulderR: [-0.0098, 0.0536, 0],
  elbowR: [-0.0106, 0.0412, 0],
  handR: [-0.0112, 0.0297, 0],
  propR: [-0.0112, 0.0269, 0],
  hipL: [0.0047, 0.0272, 0],
  kneeL: [0.0047, 0.0142, 0],
  hipR: [-0.0047, 0.0272, 0],
  kneeR: [-0.0047, 0.0142, 0],
  trunk: [0, 0, -0.0035],
  stream: [0, 0.01, 0],
};

/** Floats per bone in a pose: Euler rotation (XYZ), offset from the bind joint, uniform scale. */
export const CHANNELS = 7;
export const POSE_SIZE = BONES.length * CHANNELS;

export type Pose = Float32Array;

export interface BoneTransform {
  readonly rx?: number;
  readonly ry?: number;
  readonly rz?: number;
  readonly px?: number;
  readonly py?: number;
  readonly pz?: number;
  readonly s?: number;
}

/** A pose at bind: no rotation, no offset, every bone at full size. */
export function restPose(target: Pose = new Float32Array(POSE_SIZE)): Pose {
  target.fill(0);
  for (let i = 0; i < BONES.length; i += 1) target[i * CHANNELS + 6] = 1;
  return target;
}

/** Adds rotation and offset to a bone and multiplies its scale. */
export function add(pose: Pose, bone: BoneName, t: BoneTransform): void {
  const o = BONE_INDEX[bone] * CHANNELS;
  pose[o] = (pose[o] ?? 0) + (t.rx ?? 0);
  pose[o + 1] = (pose[o + 1] ?? 0) + (t.ry ?? 0);
  pose[o + 2] = (pose[o + 2] ?? 0) + (t.rz ?? 0);
  pose[o + 3] = (pose[o + 3] ?? 0) + (t.px ?? 0);
  pose[o + 4] = (pose[o + 4] ?? 0) + (t.py ?? 0);
  pose[o + 5] = (pose[o + 5] ?? 0) + (t.pz ?? 0);
  pose[o + 6] = (pose[o + 6] ?? 1) * (t.s ?? 1);
}

export function channel(pose: Pose, bone: BoneName, c: number): number {
  return pose[BONE_INDEX[bone] * CHANNELS + c] ?? 0;
}

/** Blends `from` towards `to` by `w` into `out` (which may be `from`). */
export function mixPose(out: Pose, from: Pose, to: Pose, w: number): Pose {
  for (let i = 0; i < POSE_SIZE; i += 1) {
    const a = from[i] ?? 0;
    out[i] = a + ((to[i] ?? 0) - a) * w;
  }
  return out;
}

/** Bones hidden in a pose shrink to this, not to zero, so their normals stay finite. */
export const HIDDEN_SCALE = 1e-4;

export interface Rig {
  /** The skeleton's parent; its matrix is the figure's frame. */
  readonly frame: Group;
  readonly bones: readonly Bone[];
  readonly skeleton: Skeleton;
  bone(name: BoneName): Bone;
  /** Writes a pose onto the bones and refreshes their matrices. */
  apply(pose: Pose): void;
  /** A bone's position in the figure's frame, after `apply`. */
  positionOf(name: BoneName, local?: Vec3, target?: Vector3): Vector3;
  /**
   * Turns `name` so its +Y axis points along `direction` (figure frame), blended in by `w`,
   * then refreshes the matrices below it.
   */
  aim(name: BoneName, direction: Vector3, w: number): void;
}

const euler = new Euler();
const inverseFrame = new Matrix4();
const relative = new Matrix4();
const parentQuat = new Quaternion();
const aimQuat = new Quaternion();
const up = new Vector3(0, 1, 0);
const scratchPos = new Vector3();
const scratchScale = new Vector3();

export function createRig(): Rig {
  const frame = new Group();
  frame.name = 'staff-rig';
  const bones = BONES.map((name) => {
    const bone = new Bone();
    bone.name = `staff/${name}`;
    return bone;
  });
  const byName = (name: BoneName): Bone => {
    const bone = bones[BONE_INDEX[name]];
    if (!bone) throw new Error(`Staff rig has no bone "${name}"`);
    return bone;
  };
  for (const name of BONES) {
    const bone = byName(name);
    const parent = PARENT[name];
    const [x, y, z] = JOINTS[name];
    if (parent === null) {
      bone.position.set(x, y, z);
      frame.add(bone);
    } else {
      const [px, py, pz] = JOINTS[parent];
      bone.position.set(x - px, y - py, z - pz);
      byName(parent).add(bone);
    }
  }
  frame.updateMatrixWorld(true);
  const skeleton = new Skeleton(bones);

  const relativeMatrix = (bone: Object3D): Matrix4 => {
    inverseFrame.copy(frame.matrixWorld).invert();
    return relative.multiplyMatrices(inverseFrame, bone.matrixWorld);
  };

  return {
    frame,
    bones,
    skeleton,
    bone: byName,
    apply(pose) {
      for (let i = 0; i < BONES.length; i += 1) {
        const name = BONES[i] ?? 'root';
        const bone = bones[i];
        if (!bone) continue;
        const o = i * CHANNELS;
        const [jx, jy, jz] = JOINTS[name];
        const parent = PARENT[name];
        const [px, py, pz] = parent === null ? [0, 0, 0] : JOINTS[parent];
        bone.position.set(
          jx - px + (pose[o + 3] ?? 0),
          jy - py + (pose[o + 4] ?? 0),
          jz - pz + (pose[o + 5] ?? 0),
        );
        euler.set(pose[o] ?? 0, pose[o + 1] ?? 0, pose[o + 2] ?? 0);
        bone.quaternion.setFromEuler(euler);
        bone.scale.setScalar(Math.max(pose[o + 6] ?? 1, HIDDEN_SCALE));
      }
      frame.updateMatrixWorld(true);
    },
    positionOf(name, local = [0, 0, 0], target = new Vector3()) {
      return target.set(local[0], local[1], local[2]).applyMatrix4(relativeMatrix(byName(name)));
    },
    aim(name, direction, w) {
      if (w <= 0) return;
      const bone = byName(name);
      const parent = bone.parent;
      if (!(parent instanceof Bone)) throw new Error(`Staff bone "${name}" has no parent bone`);
      relativeMatrix(parent).decompose(scratchPos, parentQuat, scratchScale);
      aimQuat.setFromUnitVectors(up, scratchPos.copy(direction).normalize());
      aimQuat.premultiply(parentQuat.invert());
      bone.quaternion.slerp(aimQuat, Math.min(w, 1));
      bone.updateMatrixWorld(true);
    },
  };
}
