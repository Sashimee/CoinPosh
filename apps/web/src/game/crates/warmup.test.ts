import {
  BufferGeometry,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  PerspectiveCamera,
  Scene,
  type Object3D,
} from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindCrateWarmup, type WarmBatch } from './warmup.ts';

const PLAYABLE = 'coinposh:boot:playable';

/** What the renderer does to a drawn object once its draw call is issued. */
function draw(part: Object3D): void {
  part.onAfterRender(
    null as never,
    new Scene(),
    new PerspectiveCamera(),
    new BufferGeometry(),
    new MeshBasicNodeMaterial(),
    new Group(),
  );
}

function batch(...names: string[]): WarmBatch & { released: number } {
  const parts = names.map((name) => {
    const mesh = new Mesh();
    mesh.name = name;
    return mesh;
  });
  const result = {
    parts,
    released: 0,
    release() {
      result.released += 1;
    },
  };
  return result;
}

function rig(names: readonly string[] = ['lacquer', 'gold', 'flare']) {
  const scene = new Group();
  const listeners = new Set<(deltaSeconds: number) => void>();
  const stage = {
    scene,
    renderer: {} as object,
    onFrame(listener: (deltaSeconds: number) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const batches: ReturnType<typeof batch>[] = [];
  const unbox = {
    warmParts: () => {
      const made = batch(...names);
      batches.push(made);
      return made;
    },
    prime: vi.fn(),
  };
  const warmup = bindCrateWarmup(stage, unbox);
  /** One table frame: listeners, then every warm prop in the scene draws, then the frame task ends. */
  const frame = async (): Promise<string[]> => {
    for (const listener of listeners) listener(1 / 60);
    const drawn = [...scene.children];
    for (const part of drawn) draw(part);
    await Promise.resolve();
    return drawn.map((part) => part.name);
  };
  return { scene, stage, unbox, batches, warmup, frame, listeners };
}

describe('bindCrateWarmup', () => {
  afterEach(() => {
    performance.clearMarks(PLAYABLE);
  });

  it('draws nothing until the boot marks the table playable', async () => {
    const { scene, unbox, warmup, frame } = rig();
    performance.mark('coinposh:boot:laid');
    for (let i = 0; i < 10; i++) expect(await frame()).toEqual([]);
    expect(warmup.warming).toBe(false);
    expect(scene.children).toEqual([]);
    expect(unbox.prime).not.toHaveBeenCalled();
    performance.clearMarks('coinposh:boot:laid');
  });

  it('draws one prop per frame, out of sight and unculled, then hands over to the unbox primer', async () => {
    const { scene, unbox, batches, warmup, frame } = rig();
    performance.mark(PLAYABLE);

    expect(await frame()).toEqual(['lacquer']);
    expect(warmup.warming).toBe(true);
    const parts = batches[0]?.parts ?? [];
    expect(parts.every((part) => !part.frustumCulled && part.position.y < -100)).toBe(true);
    expect(await frame()).toEqual(['gold']);
    expect(unbox.prime).not.toHaveBeenCalled();
    expect(await frame()).toEqual(['flare']);

    expect(unbox.prime).toHaveBeenCalledOnce();
    expect(batches[0]?.released).toBe(1);
    expect(warmup.warming).toBe(false);
    expect(scene.children).toEqual([]);
    expect(await frame()).toEqual([]);
    expect(batches).toHaveLength(1);
  });

  it('moves on only after the frame task that drew a prop, and once however often it drew', async () => {
    const { scene, frame } = rig();
    performance.mark(PLAYABLE);
    await frame();
    const [second] = scene.children;
    if (!second) throw new Error('The warm-up drew nothing');
    draw(second);
    draw(second);
    expect(scene.children.map((part) => part.name)).toEqual(['gold']);
    await Promise.resolve();
    expect(scene.children.map((part) => part.name)).toEqual(['flare']);
  });

  it('starts over on a swapped renderer, dropping the warm-up in flight', async () => {
    const { stage, unbox, batches, frame } = rig();
    performance.mark(PLAYABLE);
    await frame();
    stage.renderer = {};

    expect(await frame()).toEqual(['lacquer']);
    expect(batches).toHaveLength(2);
    expect(batches[0]?.released).toBe(1);
    expect(await frame()).toEqual(['gold']);
    expect(await frame()).toEqual(['flare']);
    expect(unbox.prime).toHaveBeenCalledOnce();
    expect(batches[1]?.released).toBe(1);

    stage.renderer = {};
    expect(await frame()).toEqual(['lacquer']);
    expect(batches).toHaveLength(3);
  });

  it('leaves a swap before playable to the first warm-up, which draws on the live renderer', async () => {
    const { stage, batches, frame } = rig();
    stage.renderer = {};
    await frame();
    expect(batches).toEqual([]);
    performance.mark(PLAYABLE);
    await frame();
    await frame();
    expect(batches).toHaveLength(1);
  });

  it('finishes an empty batch at once', async () => {
    const { unbox, warmup, frame } = rig([]);
    performance.mark(PLAYABLE);
    expect(await frame()).toEqual([]);
    expect(unbox.prime).toHaveBeenCalledOnce();
    expect(warmup.warming).toBe(false);
  });

  it('takes its props out of the scene and stops listening on dispose, mid-warm-up', async () => {
    const { scene, unbox, batches, warmup, frame, listeners } = rig();
    performance.mark(PLAYABLE);
    await frame();
    warmup.dispose();
    expect(scene.children).toEqual([]);
    expect(listeners.size).toBe(0);
    expect(batches[0]?.released).toBe(1);
    expect(warmup.warming).toBe(false);
    expect(await frame()).toEqual([]);
    expect(unbox.prime).not.toHaveBeenCalled();
  });
});
