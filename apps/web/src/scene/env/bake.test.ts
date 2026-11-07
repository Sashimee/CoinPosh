import { describe, expect, it } from 'vitest';
import { NoColorSpace, type RenderTarget, type WebGPURenderer } from 'three/webgpu';
import { vec4 } from 'three/tsl';
import { bakeTexture } from './bake.ts';

/** Just enough renderer for bakeTexture: tracks the output target and serves fake readbacks. */
function fakeRenderer(backend: 'webgl' | 'webgpu') {
  const pending: (() => void)[] = [];
  let current: RenderTarget | null = null;
  const renderer = {
    backend: backend === 'webgl' ? { isWebGLBackend: true } : { isWebGPUBackend: true },
    init: () => Promise.resolve(renderer),
    getRenderTarget: () => current,
    setRenderTarget: (target: RenderTarget | null) => {
      current = target;
    },
    render: () => undefined,
    readRenderTargetPixelsAsync: (_t: RenderTarget, _x: number, _y: number, w: number, h: number) =>
      new Promise<Uint8Array>((resolve) => {
        pending.push(() => {
          resolve(Uint8Array.from({ length: w * h * 4 }, (_, i) => Math.floor(i / (w * 4))));
        });
      }),
  };
  return {
    renderer: renderer as unknown as WebGPURenderer,
    target: () => current,
    flush: () => {
      for (const resolve of pending.splice(0)) resolve();
    },
  };
}

const pattern = () => vec4(0, 0, 0, 1);
const options = { name: 'test', width: 2, height: 3, colorSpace: NoColorSpace } as const;

describe('bakeTexture', () => {
  it('leaves the renderer on its original target when bakes overlap', async () => {
    const fake = fakeRenderer('webgpu');
    const bakes = Promise.all([
      bakeTexture(fake.renderer, pattern, options),
      bakeTexture(fake.renderer, pattern, options),
    ]);
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.target()).toBeNull();
    fake.flush();
    const textures = await bakes;
    expect(fake.target()).toBeNull();
    for (const t of textures) t.dispose();
  });

  it('flips rows on WebGL so texel (u, v) matches the pattern on both backends', async () => {
    const rows = async (backend: 'webgl' | 'webgpu') => {
      const fake = fakeRenderer(backend);
      const baking = bakeTexture(fake.renderer, pattern, options);
      await Promise.resolve();
      await Promise.resolve();
      fake.flush();
      const texture = await baking;
      const data = texture.image.data as Uint8Array;
      return [0, 1, 2].map((row) => data[row * 8]);
    };
    expect(await rows('webgpu')).toEqual([0, 1, 2]);
    expect(await rows('webgl')).toEqual([2, 1, 0]);
  });

  it('rejects non-integer or empty sizes', async () => {
    const fake = fakeRenderer('webgpu');
    await expect(bakeTexture(fake.renderer, pattern, { ...options, width: 0 })).rejects.toThrow(
      RangeError,
    );
    await expect(bakeTexture(fake.renderer, pattern, { ...options, height: 1.5 })).rejects.toThrow(
      RangeError,
    );
  });
});
