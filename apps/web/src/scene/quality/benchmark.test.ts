import { describe, expect, it, vi } from 'vitest';
import type { Vector2, WebGPURenderer } from 'three/webgpu';
import { runBenchmark, TIME_BUDGET_MS } from './benchmark.ts';

const postRender = vi.fn<(nowMs: number) => void>();
const disposed: string[] = [];

vi.mock('./benchScene.ts', () => ({
  createBenchScene: () => ({
    scene: {},
    camera: {},
    dispose: () => disposed.push('bench'),
  }),
}));

vi.mock('../post/postPipeline.ts', () => ({
  createPostPipeline: () => ({
    render: postRender,
    dispose: () => disposed.push('post'),
  }),
}));

interface FakeGpu {
  readonly renderer: WebGPURenderer;
  readonly now: () => number;
}

/** A renderer on a fake clock: compiling costs `compileMs`, each frame costs `frameMs`. */
function fakeGpu(compileMs: number, frameMs: number): FakeGpu {
  let clock = 0;
  postRender.mockReset();
  postRender.mockImplementation(() => {
    clock += frameMs;
  });
  disposed.length = 0;
  const renderer = {
    compileAsync: () => {
      clock += compileMs;
      return Promise.resolve();
    },
    getDrawingBufferSize: (target: Vector2) => target.set(320, 240),
    getRenderTarget: () => null,
    setRenderTarget: vi.fn(),
    readRenderTargetPixelsAsync: () => {
      clock += 0.5;
      return Promise.resolve(new Uint8Array(4));
    },
  };
  return { renderer: renderer as unknown as WebGPURenderer, now: () => clock };
}

describe('runBenchmark', () => {
  it('scores a fast device as high within the time budget', async () => {
    const gpu = fakeGpu(200, 3);
    const result = await runBenchmark(gpu.renderer, gpu.now);
    expect(result.tier).toBe('high');
    expect(result.msPerFrame).toBeCloseTo(3, 5);
    expect(gpu.now()).toBeLessThanOrEqual(TIME_BUDGET_MS);
  });

  it('returns low without rendering a frame when compiling alone blows the budget', async () => {
    const gpu = fakeGpu(TIME_BUDGET_MS + 1, 3);
    const result = await runBenchmark(gpu.renderer, gpu.now);
    expect(result).toEqual({ tier: 'low', msPerFrame: TIME_BUDGET_MS + 1, samples: [] });
    expect(postRender).not.toHaveBeenCalled();
    expect(disposed.sort()).toEqual(['bench', 'post']);
  });

  it('stops after warm-up when setup used up the budget, scoring the warm-up frames', async () => {
    const gpu = fakeGpu(TIME_BUDGET_MS - 20, 3);
    const result = await runBenchmark(gpu.renderer, gpu.now);
    expect(result.tier).toBe('high');
    expect(result.samples).toHaveLength(1);
    expect(postRender).toHaveBeenCalledTimes(1 + 4 * 2);
    expect(gpu.now()).toBeLessThan(TIME_BUDGET_MS + 50);
  });

  it('counts compile time against the budget for the measured batches', async () => {
    const gpu = fakeGpu(1500, 12);
    const result = await runBenchmark(gpu.renderer, gpu.now);
    expect(result.tier).toBe('medium');
    expect(gpu.now()).toBeLessThan(TIME_BUDGET_MS + 4 * 12 + 1);
  });
});
