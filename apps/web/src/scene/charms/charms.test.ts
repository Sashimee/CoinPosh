import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Box3, BufferGeometry, Group, Material, Mesh, type Object3D, Vector3 } from 'three/webgpu';
import {
  CHARM_KINDS,
  CHARM_SOCKET,
  createCharmView,
  type CharmKind,
  type CharmView,
} from './index.ts';
import { loadCharmViews } from './lazy.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

function meshes(root: Object3D): Mesh[] {
  const found: Mesh[] = [];
  root.traverse((node) => {
    if (node instanceof Mesh) found.push(node as Mesh);
  });
  return found;
}

function visibleMeshes(root: Object3D): Mesh[] {
  const found: Mesh[] = [];
  root.traverseVisible((node) => {
    if (node instanceof Mesh) found.push(node as Mesh);
  });
  return found;
}

function restBounds(root: Object3D): Box3 {
  root.updateMatrixWorld(true);
  const bounds = new Box3();
  const part = new Box3();
  for (const mesh of visibleMeshes(root)) {
    const geometry = mesh.geometry;
    geometry.computeBoundingBox();
    if (!geometry.boundingBox) throw new Error(`${mesh.name} has no bounding box`);
    part.copy(geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
    bounds.union(part);
  }
  return bounds;
}

/** The farthest any visible vertex reaches from the socket axis, metres. */
function footprintRadius(root: Object3D): number {
  root.updateMatrixWorld(true);
  const v = new Vector3();
  let radius = 0;
  for (const mesh of visibleMeshes(root)) {
    const position = mesh.geometry.getAttribute('position');
    for (let i = 0; i < position.count; i += 1) {
      v.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
      radius = Math.max(radius, Math.hypot(v.x, v.z));
    }
  }
  return radius;
}

function poseSnapshot(root: Object3D): number[] {
  const values: number[] = [];
  root.traverse((node) => {
    if (node.name === 'charm-burst' || node.name === 'charm-ring') return;
    values.push(...node.position.toArray(), node.rotation.x, node.rotation.y, node.rotation.z);
    values.push(...node.scale.toArray());
  });
  return values;
}

function find(view: CharmView, name: string): Mesh {
  const mesh = view.object3d.getObjectByName(name);
  if (!(mesh instanceof Mesh)) throw new Error(`${view.kind} has no mesh named ${name}`);
  return mesh as Mesh;
}

describe.each(CHARM_KINDS.map((kind) => [kind]))('createCharmView(%s)', (kind: CharmKind) => {
  it('builds non-empty geometry for every part', () => {
    const view = createCharmView(kind);
    const parts = meshes(view.object3d);
    expect(parts.length).toBeGreaterThan(1);
    for (const mesh of parts) {
      const position = mesh.geometry.getAttribute('position');
      expect(position.count, mesh.name).toBeGreaterThan(0);
      for (let i = 0; i < Math.min(position.count, 64); i += 1) {
        expect(Number.isFinite(position.getX(i) + position.getY(i) + position.getZ(i))).toBe(true);
      }
    }
    view.dispose();
  });

  it('fits one socket at rest, standing on the table floor', () => {
    const view = createCharmView(kind);
    view.setIdle(0);
    const bounds = restBounds(view.object3d);
    expect(bounds.min.y).toBeGreaterThanOrEqual(-1e-6);
    expect(bounds.max.y).toBeLessThanOrEqual(CHARM_SOCKET.maxHeight);
    expect(bounds.max.y).toBeGreaterThan(0.02);
    expect(footprintRadius(view.object3d)).toBeLessThanOrEqual(CHARM_SOCKET.radius);
    view.dispose();
  });

  it('costs at most seven draw calls at idle and hides its burst', () => {
    const view = createCharmView(kind);
    view.setIdle(3.2);
    const drawn = visibleMeshes(view.object3d);
    expect(drawn.length).toBeLessThanOrEqual(7);
    expect(drawn.some((mesh) => mesh.name.startsWith('charm-'))).toBe(false);
    view.dispose();
  });

  it('animates at idle but holds still under reduced motion', () => {
    const moving = createCharmView(kind);
    moving.setIdle(0.4);
    const a = poseSnapshot(moving.object3d);
    moving.setIdle(1.7);
    expect(poseSnapshot(moving.object3d)).not.toEqual(a);

    const still = createCharmView(kind, { reducedMotion: true });
    still.setIdle(0.4);
    const b = poseSnapshot(still.object3d);
    still.setIdle(1.7);
    expect(poseSnapshot(still.object3d)).toEqual(b);
    moving.dispose();
    still.dispose();
  });

  it('plays the activation from the next frame, then returns to rest', () => {
    const view = createCharmView(kind);
    view.setIdle(10);
    view.activate();
    view.setIdle(10.05);
    const burst = find(view, 'charm-burst');
    expect(burst.visible).toBe(true);
    view.setIdle(10.05 + 0.25);
    const ring = view.object3d.getObjectByName('charm-ring');
    expect(ring?.visible).toBe(true);
    view.setIdle(10.05 + view.activationSeconds + 0.01);
    expect(burst.visible).toBe(false);
    expect(ring?.visible ?? false).toBe(false);
    view.dispose();
  });

  it('activates under reduced motion with a ring and no flying sparks', () => {
    const view = createCharmView(kind, { reducedMotion: true });
    view.setIdle(2);
    const rest = poseSnapshot(view.object3d);
    view.activate();
    view.setIdle(2);
    view.setIdle(2.2);
    expect(find(view, 'charm-burst').visible).toBe(false);
    expect(view.object3d.getObjectByName('charm-ring')?.visible).toBe(true);
    expect(poseSnapshot(view.object3d)).toEqual(rest);
    view.dispose();
  });

  it('frees every geometry and material and detaches on dispose', () => {
    const geometryDispose = vi.spyOn(BufferGeometry.prototype, 'dispose');
    const materialDispose = vi.spyOn(Material.prototype, 'dispose');
    const parent = new Group();
    const view = createCharmView(kind, { quality: 'low' });
    parent.add(view.object3d);
    const parts = meshes(view.object3d);
    const geometries = new Set(parts.map((mesh) => mesh.geometry));
    const materials = new Set(parts.map((mesh) => mesh.material));
    geometryDispose.mockClear();
    materialDispose.mockClear();
    view.dispose();
    expect(geometryDispose).toHaveBeenCalledTimes(geometries.size);
    expect(materialDispose).toHaveBeenCalledTimes(materials.size);
    expect(view.object3d.parent).toBeNull();
    view.dispose();
    expect(geometryDispose).toHaveBeenCalledTimes(geometries.size);
  });
});

describe('createCharmView', () => {
  it('throws on an unknown kind', () => {
    expect(() => createCharmView('lucky-dice' as CharmKind)).toThrow(
      /Unknown charm kind "lucky-dice"/,
    );
  });

  it('inlays one enamel arc per synergy tag in the plinth', () => {
    const one = createCharmView('golden-peg', { tags: ['gilded'] });
    const two = createCharmView('golden-peg', { tags: ['gilded', 'kinetic'] });
    const count = (view: CharmView): number => {
      const colors = find(view, 'golden-peg/painted').geometry.getAttribute('color');
      const seen = new Set<string>();
      for (let i = 0; i < colors.count; i += 1) {
        seen.add(
          `${colors.getX(i).toFixed(3)},${colors.getY(i).toFixed(3)},${colors.getZ(i).toFixed(3)}`,
        );
      }
      return seen.size;
    };
    expect(count(two)).toBe(count(one) + 1);
    one.dispose();
    two.dispose();
  });

  it('ignores frames with a non-finite time and calls after dispose', () => {
    const view = createCharmView('butler');
    view.setIdle(1);
    const pose = poseSnapshot(view.object3d);
    view.setIdle(Number.NaN);
    view.setIdle(Number.POSITIVE_INFINITY);
    expect(poseSnapshot(view.object3d)).toEqual(pose);
    view.dispose();
    view.activate();
    view.setIdle(2);
    expect(poseSnapshot(view.object3d)).toEqual(pose);
  });

  it('builds the low tier with lighter geometry', () => {
    const triangles = (view: CharmView): number =>
      meshes(view.object3d).reduce((sum, mesh) => sum + (mesh.geometry.index?.count ?? 0), 0);
    const high = createCharmView('brass-bumper');
    const low = createCharmView('brass-bumper', { quality: 'low' });
    expect(triangles(low)).toBeLessThan(triangles(high));
    high.dispose();
    low.dispose();
  });
});

describe('charm bundle split', () => {
  it('loads lazily through lazy.ts', async () => {
    const module = await loadCharmViews();
    expect(module.createCharmView).toBe(createCharmView);
  });

  it('is never imported statically from outside the charms folder', () => {
    const src = join(import.meta.dirname, '..', '..');
    const here = import.meta.dirname;
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          if (path !== here) walk(path);
        } else if (/\.tsx?$/.test(entry)) {
          const text = readFileSync(path, 'utf8');
          const statics = text.match(
            /^\s*(?:import|export)\s[^;]*?from\s+['"][^'"]*charms\/(?!lazy)[^'"]*['"]/gm,
          );
          if (statics?.some((line) => !/^\s*import\s+type\s/.test(line))) {
            offenders.push(relative(src, path).split(sep).join('/'));
          }
        }
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});
