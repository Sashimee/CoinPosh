import {
  Group,
  Mesh,
  PerspectiveCamera,
  Scene,
  Sprite,
  type Camera,
  type Material,
  type Object3D,
} from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { UnboxAssets } from './stage.ts';

type Drawable = Mesh | Sprite;

/** Every drawable the light carries: the primer is the only thing that hangs there. */
function primed(assets: UnboxAssets): Drawable[] {
  const parts: Drawable[] = [];
  assets.light.traverse((object) => {
    if (object instanceof Mesh || object instanceof Sprite) parts.push(object);
  });
  return parts;
}

/** What a frame of the renderer does to each drawn object once its draw call is issued. */
function draw(object: Drawable): void {
  object.onAfterRender(
    null as never,
    new Scene(),
    new PerspectiveCamera(),
    object.geometry,
    object.material as Material,
    new Group(),
  );
}

describe('UnboxAssets primer', () => {
  it('draws every unbox material, out of sight and unculled, from the moment it mounts', () => {
    const parent = new Group();
    const assets = new UnboxAssets(parent);
    expect(parent.children).toEqual([assets.light]);
    expect(assets.priming).toBe(true);
    const parts = primed(assets);
    const materials = new Set(parts.map((part) => part.material));
    expect(materials).toEqual(
      new Set([
        assets.lacquer,
        assets.gold,
        assets.velvet,
        assets.seamMaterial,
        assets.heroMaterial,
        assets.rayMaterial,
        assets.flareMaterial,
      ]),
    );
    for (const part of parts) {
      expect(part.frustumCulled).toBe(false);
      expect(part.getWorldPosition(part.position.clone()).y).toBeLessThan(-100);
    }
    assets.dispose();
  });

  it('leaves the scene once every material has been drawn, not before', async () => {
    const assets = new UnboxAssets(new Group());
    const [first, ...rest] = primed(assets);
    if (!first) throw new Error('The primer drew nothing');
    draw(first);
    draw(first);
    await Promise.resolve();
    expect(assets.priming).toBe(true);
    for (const part of rest) draw(part);
    expect(assets.priming).toBe(true);
    await Promise.resolve();
    expect(assets.priming).toBe(false);
    expect(primed(assets)).toEqual([]);
    assets.dispose();
  });

  it('compiles the primer against the scene lights when the host can await it', async () => {
    const scene = new Scene();
    const assets = new UnboxAssets(scene);
    const camera = new PerspectiveCamera();
    const calls: [Object3D, Camera, Object3D | null | undefined][] = [];
    const renderer = {
      compileAsync: (object: Object3D, at: Camera, target?: Object3D | null) => {
        calls.push([object, at, target]);
        return Promise.resolve();
      },
    };
    await assets.warm(renderer, camera, scene);
    expect(calls).toHaveLength(1);
    const [object, at, target] = calls[0] ?? [];
    expect(object?.name).toBe('unbox-primer');
    expect(at).toBe(camera);
    expect(target).toBe(scene);

    for (const part of primed(assets)) draw(part);
    await Promise.resolve();
    await assets.warm(renderer, camera, scene);
    expect(calls).toHaveLength(1);
    assets.dispose();
  });

  it('takes the primer down with the assets, even before it was drawn', () => {
    const parent = new Group();
    const assets = new UnboxAssets(parent);
    assets.dispose();
    expect(assets.priming).toBe(false);
    expect(parent.children).toEqual([]);
  });
});
