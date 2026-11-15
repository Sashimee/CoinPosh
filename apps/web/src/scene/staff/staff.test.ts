import { STAFF_ROLES, type StaffRole } from '@coinposh/shared';
import { Box3, type BufferGeometry, type Material, Mesh, SkinnedMesh } from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import {
  ACTION_SECONDS,
  createStaffFigure,
  LEAVE_SECONDS,
  STAFF_HEIGHT,
  type StaffFigure,
} from './index.ts';
import { composePose, env } from './motion.ts';
import { BONES, restPose } from './rig.ts';

function meshes(figure: StaffFigure): SkinnedMesh[] {
  const found: SkinnedMesh[] = [];
  figure.object3d.traverse((node) => {
    if (node instanceof SkinnedMesh) found.push(node as SkinnedMesh);
  });
  return found;
}

/** Every bone's figure-frame matrix, flattened: the whole visible pose of a figure. */
function snapshot(figure: StaffFigure): number[] {
  figure.object3d.updateMatrixWorld(true);
  return figure.object3d.children
    .flatMap((child) => (child instanceof SkinnedMesh ? [child] : []))
    .slice(0, 1)
    .flatMap((mesh) => mesh.skeleton.bones.flatMap((bone) => bone.matrixWorld.toArray()));
}

function distance(a: readonly number[], b: readonly number[]): number {
  return a.reduce((sum, v, i) => sum + Math.abs(v - (b[i] ?? 0)), 0);
}

describe('createStaffFigure', () => {
  it.each(STAFF_ROLES)('builds the %s as one skinned livery mesh on a shared rig', (role) => {
    const figure = createStaffFigure(role);
    const all = meshes(figure);
    const livery = all.find((mesh) => mesh.name === `staff/${role}/livery`);
    expect(livery).toBeDefined();
    expect(all).toHaveLength(role === 'sommelier' ? 2 : 1);
    for (const mesh of all) expect(mesh.skeleton.bones).toHaveLength(BONES.length);
    expect(new Set(all.map((mesh) => mesh.skeleton)).size).toBe(1);
    expect(figure.role).toBe(role);
    expect(figure.actionSeconds).toBe(ACTION_SECONDS[role]);
    expect(figure.object3d.userData.staffRole).toBe(role);
    figure.dispose();
  });

  it.each(STAFF_ROLES)('stands the %s at table-edge scale on its origin', (role) => {
    const figure = createStaffFigure(role);
    const livery = meshes(figure)[0];
    if (!livery) throw new Error('no livery mesh');
    livery.geometry.computeBoundingBox();
    const box = livery.geometry.boundingBox ?? new Box3();
    expect(box.max.y).toBeGreaterThan(STAFF_HEIGHT * 0.9);
    expect(box.max.y).toBeLessThan(STAFF_HEIGHT * 1.12);
    expect(box.min.y).toBeGreaterThanOrEqual(-1e-4);
    expect(box.min.x).toBeLessThan(-0.009);
    expect(box.max.x).toBeGreaterThan(0.009);
    expect(Math.abs(box.max.z + box.min.z)).toBeLessThan(0.03);
    const sphere = livery.boundingSphere;
    expect(sphere.containsPoint(box.max)).toBe(true);
    expect(sphere.containsPoint(box.min)).toBe(true);
    figure.dispose();
  });

  it('gives every role its own silhouette', () => {
    const counts = STAFF_ROLES.map((role) => {
      const figure = createStaffFigure(role);
      const count = meshes(figure)[0]?.geometry.getAttribute('position').count ?? 0;
      figure.dispose();
      return count;
    });
    expect(new Set(counts).size).toBe(STAFF_ROLES.length);
  });

  it('rejects a role outside the shared list', () => {
    expect(() => createStaffFigure('chef' as StaffRole)).toThrow(/Unknown staff role "chef"/);
  });

  it.each(STAFF_ROLES)('frees every geometry and material of the %s on dispose', (role) => {
    const figure = createStaffFigure(role, { quality: 'medium' });
    const parent = new Mesh();
    parent.add(figure.object3d);
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    for (const mesh of meshes(figure)) {
      geometries.add(mesh.geometry);
      materials.add(mesh.material as Material);
    }
    const freed = [...geometries, ...materials].map((item) => vi.spyOn(item, 'dispose'));
    figure.dispose();
    for (const spy of freed) expect(spy).toHaveBeenCalledOnce();
    expect(figure.object3d.parent).toBeNull();
    figure.dispose();
    for (const spy of freed) expect(spy).toHaveBeenCalledOnce();
  });

  it.each(STAFF_ROLES)('poses the %s the same way for the same time', (role) => {
    const a = createStaffFigure(role, { phase: 0.4 });
    const b = createStaffFigure(role, { phase: 0.4 });
    a.update(1);
    a.act();
    a.update(5);
    a.update(5 + ACTION_SECONDS[role] * 0.45);
    b.update(3);
    b.update(4);
    b.act();
    b.update(5);
    b.update(5 + ACTION_SECONDS[role] * 0.45);
    expect(distance(snapshot(a), snapshot(b))).toBe(0);
    a.dispose();
    b.dispose();
  });

  it.each(STAFF_ROLES)('keeps the %s alive at idle and moves it further in its action', (role) => {
    const figure = createStaffFigure(role);
    figure.update(2);
    const rest = snapshot(figure);
    figure.update(3.3);
    const later = snapshot(figure);
    expect(distance(rest, later)).toBeGreaterThan(1e-4);
    figure.act();
    figure.update(10);
    const start = snapshot(figure);
    figure.update(10 + ACTION_SECONDS[role] * 0.45);
    const mid = snapshot(figure);
    expect(distance(start, mid)).toBeGreaterThan(distance(rest, later) * 3);
    figure.update(10 + ACTION_SECONDS[role] + 0.01);
    figure.update(14);
    const after = createStaffFigure(role);
    after.update(14);
    expect(distance(snapshot(figure), snapshot(after))).toBeLessThan(1e-9);
    figure.dispose();
    after.dispose();
  });

  it.each(STAFF_ROLES)('holds the %s still under reduced motion', (role) => {
    const figure = createStaffFigure(role, { reducedMotion: true });
    figure.update(1);
    const first = snapshot(figure);
    figure.update(7.3);
    expect(distance(first, snapshot(figure))).toBe(0);
    figure.act();
    figure.update(10);
    figure.update(10 + ACTION_SECONDS[role] * 0.5);
    const key = snapshot(figure);
    figure.update(10 + ACTION_SECONDS[role] * 0.6);
    expect(distance(key, snapshot(figure))).toBe(0);
    expect(distance(first, key)).toBeGreaterThan(1e-3);
    figure.dispose();
  });

  it('lets reduced motion be switched on after creation', () => {
    const figure = createStaffFigure('valet');
    figure.setReducedMotion(true);
    figure.update(2);
    const first = snapshot(figure);
    figure.update(4);
    expect(distance(first, snapshot(figure))).toBe(0);
    figure.dispose();
  });

  it.each(STAFF_ROLES)('seats the %s on its trunk, greyed, while on leave', (role) => {
    const working = createStaffFigure(role);
    const away = createStaffFigure(role, { status: 'onLeave' });
    working.update(2);
    away.update(2);
    expect(away.status).toBe('onLeave');
    expect(away.object3d.visible).toBe(true);
    const pelvis = (figure: StaffFigure) =>
      meshes(figure)[0]?.skeleton.getBoneByName('staff/pelvis')?.matrixWorld.elements[13] ?? 0;
    const trunk = (figure: StaffFigure) =>
      meshes(figure)[0]?.skeleton.getBoneByName('staff/trunk')?.scale.x ?? 0;
    expect(pelvis(working) - pelvis(away)).toBeGreaterThan(0.009);
    expect(trunk(away)).toBeCloseTo(1, 5);
    expect(trunk(working)).toBeLessThan(1e-3);
    away.act();
    away.update(3);
    away.update(4);
    const seated = snapshot(away);
    const still = createStaffFigure(role, { status: 'onLeave' });
    still.update(4);
    expect(distance(seated, snapshot(still))).toBeLessThan(1e-9);
    for (const figure of [working, away, still]) figure.dispose();
  });

  it('stands back up over the leave blend when employed again', () => {
    const figure = createStaffFigure('butler', { status: 'onLeave' });
    const pelvisY = () =>
      meshes(figure)[0]?.skeleton.getBoneByName('staff/pelvis')?.matrixWorld.elements[13] ?? 0;
    figure.update(1);
    const seated = pelvisY();
    figure.setStatus('employed');
    figure.update(2);
    expect(pelvisY()).toBeCloseTo(seated, 6);
    figure.update(2 + LEAVE_SECONDS / 2);
    const halfway = pelvisY();
    figure.update(2 + LEAVE_SECONDS + 0.01);
    const standing = pelvisY();
    expect(halfway).toBeGreaterThan(seated);
    expect(standing).toBeGreaterThan(halfway);
    expect(standing).toBeCloseTo(0.029, 3);
    figure.dispose();
  });

  it('hides a vacant post and shows it again when filled', () => {
    const figure = createStaffFigure('sommelier', { status: 'vacant' });
    expect(figure.object3d.visible).toBe(false);
    figure.act();
    figure.setStatus('employed');
    expect(figure.object3d.visible).toBe(true);
    figure.update(1);
    figure.setStatus('vacant');
    expect(figure.status).toBe('vacant');
    expect(figure.object3d.visible).toBe(false);
    figure.dispose();
  });

  it('builds every quality tier', () => {
    for (const quality of ['low', 'medium', 'high'] as const) {
      const figure = createStaffFigure('butler', { quality });
      const livery = meshes(figure)[0];
      expect(livery?.castShadow).toBe(quality !== 'low');
      figure.dispose();
    }
  });

  it('rolls off the highlights of every staff material so a glint cannot flood the bloom', () => {
    const figure = createStaffFigure('sommelier');
    const materials = meshes(figure).map((mesh) => mesh.material as Material);
    expect(materials.map((m) => m.name)).toEqual(['staff/livery', 'staff/glass']);
    for (const material of materials) {
      expect((material as Material & { outputNode: unknown }).outputNode).toBeTruthy();
    }
    figure.dispose();
  });
});

describe('composePose', () => {
  it('is a pure function of role and clock', () => {
    for (const role of STAFF_ROLES) {
      const clock = { t: 4.2, action: 1.3, leave: 0.4, reduced: false };
      const a = restPose();
      const b = restPose();
      composePose(role, clock, a);
      composePose(role, { t: 9, action: -1, leave: 1, reduced: true }, b);
      composePose(role, clock, b);
      expect([...a]).toEqual([...b]);
      for (const value of a) expect(Number.isFinite(value)).toBe(true);
    }
  });

  it('pours only in the middle of the sommelier action', () => {
    const at = (action: number) =>
      composePose('sommelier', { t: 0, action, leave: 0, reduced: false }, restPose()).pour;
    expect(at(0.2)).toBe(0);
    expect(at(1.5)).toBe(1);
    expect(at(3)).toBe(0);
    expect(
      composePose('sommelier', { t: 0, action: 1.5, leave: 0, reduced: true }, restPose()).pour,
    ).toBe(0);
  });
});

describe('env', () => {
  it('rises, holds and falls inside its window only', () => {
    expect(env(0, 1, 2, 3, 4)).toBe(0);
    expect(env(1.5, 1, 2, 3, 4)).toBeCloseTo(0.5, 6);
    expect(env(2.5, 1, 2, 3, 4)).toBe(1);
    expect(env(3.5, 1, 2, 3, 4)).toBeCloseTo(0.5, 6);
    expect(env(4, 1, 2, 3, 4)).toBe(0);
  });
});
