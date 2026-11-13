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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

/** Draws whatever the primer holds, as one table frame would, then lets the idle slot run. */
async function frame(assets: UnboxAssets): Promise<Drawable[]> {
  const drawn = primed(assets);
  for (const part of drawn) draw(part);
  await vi.runAllTimersAsync();
  return drawn;
}

describe('UnboxAssets primer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('adds nothing to draw until it is primed, so the table boots without unbox programs', () => {
    const parent = new Group();
    const assets = new UnboxAssets(parent);
    expect(parent.children).toEqual([assets.light]);
    expect(assets.priming).toBe(false);
    expect(primed(assets)).toEqual([]);
    assets.dispose();
  });

  it('draws every unbox material once, one per frame, out of sight and unculled', async () => {
    const assets = new UnboxAssets(new Group());
    assets.prime();
    expect(assets.priming).toBe(true);
    const materials: unknown[] = [];
    for (let i = 0; i < 20 && assets.priming; i++) {
      const parts = primed(assets);
      expect(parts).toHaveLength(1);
      for (const part of parts) {
        materials.push(part.material);
        expect(part.frustumCulled).toBe(false);
        expect(part.getWorldPosition(part.position.clone()).y).toBeLessThan(-100);
      }
      await frame(assets);
    }
    expect(assets.priming).toBe(false);
    expect(materials).toHaveLength(7);
    expect(new Set(materials)).toEqual(
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
    expect(primed(assets)).toEqual([]);
    assets.dispose();
  });

  it('waits for the frame that draws a part before it adds the next', async () => {
    const assets = new UnboxAssets(new Group());
    assets.prime();
    const [first] = primed(assets);
    if (!first) throw new Error('The primer drew nothing');
    await vi.runAllTimersAsync();
    expect(primed(assets)).toEqual([first]);
    draw(first);
    draw(first);
    await vi.runAllTimersAsync();
    const next = primed(assets);
    expect(next).toHaveLength(1);
    expect(next[0]?.material).not.toBe(first.material);
    assets.dispose();
  });

  it('primes once however often it is asked', async () => {
    const assets = new UnboxAssets(new Group());
    assets.prime();
    while (assets.priming) await frame(assets);
    assets.prime();
    expect(assets.priming).toBe(false);
    expect(primed(assets)).toEqual([]);
    assets.dispose();
  });

  it('compiles every unbox material at once against the scene lights when the host can await it', async () => {
    const scene = new Scene();
    const assets = new UnboxAssets(scene);
    const camera = new PerspectiveCamera();
    const calls: [Object3D, Camera, Object3D | null | undefined, number][] = [];
    const renderer = {
      compileAsync: (object: Object3D, at: Camera, target?: Object3D | null) => {
        calls.push([object, at, target, primed(assets).length]);
        return Promise.resolve();
      },
    };
    await assets.warm(renderer, camera, scene);
    expect(calls).toHaveLength(1);
    const [object, at, target, parts] = calls[0] ?? [];
    expect(object?.name).toBe('unbox-primer');
    expect(at).toBe(camera);
    expect(target).toBe(scene);
    expect(parts).toBe(7);

    await frame(assets);
    expect(assets.priming).toBe(false);
    await assets.warm(renderer, camera, scene);
    expect(calls).toHaveLength(1);
    assets.dispose();
  });

  it('takes the primer down with the assets, even before it was drawn', () => {
    const parent = new Group();
    const assets = new UnboxAssets(parent);
    assets.prime();
    assets.dispose();
    expect(assets.priming).toBe(false);
    expect(parent.children).toEqual([]);
    assets.prime();
    expect(assets.priming).toBe(false);
  });
});
