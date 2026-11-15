import { STAFF_ROLES, type StaffRole, type StaffStatus } from '@coinposh/shared';
import {
  type BufferGeometry,
  Group,
  type Material,
  Matrix4,
  Mesh,
  type Object3D,
  SkinnedMesh,
  Sphere,
  Vector3,
} from 'three/webgpu';
import { easeInOutCubic, progress } from '../../vfx/easing.ts';
import { QUALITY_PROFILES, type QualityTier } from '../quality/tiers.ts';
import { buildFigureParts } from './figures.ts';
import { createStaffGlass, createStaffMaterial, createStaffUniforms } from './materials.ts';
import { ACTION_SECONDS, composePose, LEAVE_SECONDS, settleProps } from './motion.ts';
import { createRig, restPose } from './rig.ts';
import { assemble } from './shapes.ts';

export { ACTION_SECONDS, LEAVE_SECONDS } from './motion.ts';

/** Radial segments of every turned part, per quality tier. */
export const STAFF_SEGMENTS: Readonly<Record<QualityTier, number>> = {
  low: 10,
  medium: 14,
  high: 18,
};

/**
 * What the whole household (butler, valet and sommelier on screen together) may cost a frame.
 * Draw calls count the shadow pass when the tier casts shadows.
 */
export const STAFF_BUDGET = {
  drawCalls: 8,
  triangles: { low: 18_000, medium: 26_000, high: 34_000 },
  /** Median CPU milliseconds to pose all three figures for one frame. */
  updateMs: 0.5,
} as const;

/** Standing height of a figure, metres: small enough to stand at the table edge. */
export const STAFF_HEIGHT = 0.075;

export interface StaffFigureOptions {
  readonly status?: StaffStatus;
  readonly reducedMotion?: boolean;
  readonly quality?: QualityTier;
  /** Offsets the idle clock so neighbouring figures do not breathe in step. Seconds. */
  readonly phase?: number;
}

export interface StaffFigure {
  readonly role: StaffRole;
  /** Stands on the floor at its origin, facing +Z; position and turn it as a whole. */
  readonly object3d: Object3D;
  /** Seconds the role's action plays before the figure is back at idle. */
  readonly actionSeconds: number;
  readonly status: StaffStatus;
  /** Poses the figure for absolute time `t` (seconds). Call once per frame. */
  update(t: number): void;
  /** Plays the role's action from the next `update`; ignored unless employed. */
  act(): void;
  /** Vacant hides the figure; on leave it sits on its trunk, greyed, until employed again. */
  setStatus(status: StaffStatus): void;
  setReducedMotion(reduced: boolean): void;
  /** Frees every geometry and material and detaches the figure from its parent. */
  dispose(): void;
}

function isStaffRole(value: unknown): value is StaffRole {
  return (STAFF_ROLES as readonly unknown[]).includes(value);
}

/**
 * Builds one member of staff: a low-poly figure in livery skinned to a shared 22-bone rig (one
 * draw call, plus the sommelier's glass), with an idle loop, the role's action (the butler's
 * bow and cloche reveal, the valet's carry and hat tip, the sommelier's pour and sip) and a
 * seated, greyed pose on leave. Faces are left blank on purpose: porcelain, no eyes.
 */
export function createStaffFigure(role: StaffRole, opts: StaffFigureOptions = {}): StaffFigure {
  if (!isStaffRole(role)) throw new Error(`Unknown staff role "${String(role)}"`);
  const tier = opts.quality ?? 'high';
  const phase = opts.phase ?? 0;
  let reduced = opts.reducedMotion ?? false;
  let status: StaffStatus = opts.status ?? 'employed';

  const root = new Group();
  root.name = `staff/${role}`;
  root.userData.staffRole = role;
  const rig = createRig();
  root.add(rig.frame);
  const uniforms = createStaffUniforms();
  const parts = buildFigureParts(role, STAFF_SEGMENTS[tier]);
  const bounds = new Sphere(new Vector3(0, 0.038, 0.004), 0.062);
  const identity = new Matrix4();
  const skinned = (geometry: BufferGeometry, material: Material, name: string): SkinnedMesh => {
    const mesh = new SkinnedMesh(geometry, material);
    mesh.name = name;
    mesh.bind(rig.skeleton, identity);
    mesh.boundingSphere = bounds.clone();
    geometry.boundingSphere = bounds.clone();
    root.add(mesh);
    return mesh;
  };
  const livery = skinned(
    assemble(parts.livery, `staff/${role}/livery`),
    createStaffMaterial(tier, uniforms),
    `staff/${role}/livery`,
  );
  livery.castShadow = QUALITY_PROFILES[tier].coinShadows;
  livery.receiveShadow = true;
  if (parts.glass.length > 0) {
    const glass = skinned(
      assemble(parts.glass, `staff/${role}/glass`),
      createStaffGlass(uniforms),
      `staff/${role}/glass`,
    );
    glass.renderOrder = 1;
  }

  const pose = restPose();
  let pending = false;
  let actionAt = Number.NaN;
  let leaveFrom = status === 'onLeave' ? 1 : 0;
  let leaveTo = leaveFrom;
  let leaveAt = Number.NEGATIVE_INFINITY;
  let leaveChanged = false;
  let leave = leaveFrom;
  let disposed = false;
  root.visible = status !== 'vacant';

  const figure: StaffFigure = {
    role,
    object3d: root,
    actionSeconds: ACTION_SECONDS[role],
    get status() {
      return status;
    },
    update(t) {
      if (disposed || !Number.isFinite(t)) return;
      if (leaveChanged) {
        leaveAt = t;
        leaveChanged = false;
      }
      leave = reduced
        ? leaveTo
        : leaveFrom +
          (leaveTo - leaveFrom) * easeInOutCubic(progress(t - leaveAt, 0, LEAVE_SECONDS));
      if (pending) {
        actionAt = t;
        pending = false;
      }
      let action = Number.isNaN(actionAt) ? -1 : t - actionAt;
      if (action < 0 || action >= ACTION_SECONDS[role]) {
        action = -1;
        actionAt = Number.NaN;
      }
      if (!root.visible) return;
      const clock = { t: reduced ? 0 : t + phase, action, leave, reduced };
      const cues = composePose(role, clock, pose);
      rig.apply(pose);
      settleProps(role, rig, clock, cues);
      uniforms.leave.value = leave;
      uniforms.glint.value = cues.glint;
    },
    act() {
      if (!disposed && status === 'employed') pending = true;
    },
    setStatus(next) {
      if (disposed || next === status) return;
      const wasVacant = status === 'vacant';
      status = next;
      root.visible = next !== 'vacant';
      const target = next === 'onLeave' ? 1 : 0;
      if (next === 'vacant' || wasVacant) {
        leaveFrom = leaveTo = leave = target;
        leaveChanged = false;
      } else if (target !== leaveTo) {
        leaveFrom = leave;
        leaveTo = target;
        leaveChanged = true;
      }
      if (next !== 'employed') {
        pending = false;
        actionAt = Number.NaN;
      }
    },
    setReducedMotion(on) {
      reduced = on;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const geometries = new Set<BufferGeometry>();
      const materials = new Set<Material>();
      root.traverse((node) => {
        if (node instanceof Mesh) {
          geometries.add(node.geometry as BufferGeometry);
          const material = node.material as Material | Material[];
          for (const m of Array.isArray(material) ? material : [material]) materials.add(m);
        }
      });
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      rig.skeleton.dispose();
      root.removeFromParent();
    },
  };
  figure.update(0);
  return figure;
}
