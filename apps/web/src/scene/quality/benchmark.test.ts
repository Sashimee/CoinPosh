import { describe, expect, it, vi } from 'vitest';
import type { RenderTarget, Vector2, WebGPURenderer } from 'three/webgpu';
import {
  benchResolution,
  runBenchmark,
  runInterruptibleBenchmark,
  TIME_BUDGET_MS,
} from './benchmark.ts';
import { QUALITY_PROFILES, type QualityProfile } from './tiers.ts';

const postRender = vi.fn<(nowMs: number) => void>();
const disposed: string[] = [];
const benchPost: { profile: QualityProfile | null; dynamicScale: number; pipelineRatio: number } = {
  profile: null,
  dynamicScale: Number.NaN,
  pipelineRatio: Number.NaN,
};

vi.mock('./benchScene.ts', () => ({
  BENCH_LOOK: { exposure: 0.85, environmentIntensity: 0.9, shadows: true },
  createBenchScene: () => ({
    scene: {},
    camera: {},
    dispose: () => disposed.push('bench'),
  }),
}));

vi.mock('../post/postPipeline.ts', () => ({
  createPostPipeline: (
    _renderer: unknown,
    _scene: unknown,
    _camera: unknown,
    profile: QualityProfile,
    options: { devicePixelRatio: () => number },
  ) => {
    benchPost.profile = profile;
    benchPost.pipelineRatio = Math.min(options.devicePixelRatio(), profile.maxPixelRatio);
    return {
      render: postRender,
      setDynamicScale: (scale: number) => {
        benchPost.dynamicScale = scale;
      },
      dispose: () => disposed.push('post'),
    };
  },
}));

interface FakeGpu {
  readonly renderer: WebGPURenderer;
  readonly now: () => number;
  readonly targets: RenderTarget[];
}

/**
 * A renderer on a fake clock: compiling costs `compileMs`, each frame costs `frameMs`. Its
 * canvas is 320x240 CSS pixels at `pixelRatio`.
 */
function fakeGpu(compileMs: number, frameMs: number, pixelRatio = 1): FakeGpu {
  let clock = 0;
  postRender.mockReset();
  postRender.mockImplementation(() => {
    clock += frameMs;
  });
  disposed.length = 0;
  const targets: RenderTarget[] = [];
  const renderer = {
    compileAsync: () => {
      clock += compileMs;
      return Promise.resolve();
    },
    getSize: (target: Vector2) => target.set(320, 240),
    getPixelRatio: () => pixelRatio,
    getRenderTarget: () => null,
    setRenderTarget: (target: RenderTarget | null) => {
      if (target !== null) targets.push(target);
    },
    readRenderTargetPixelsAsync: () => {
      clock += 0.5;
      return Promise.resolve(new Uint8Array(4));
    },
  };
  return { renderer: renderer as unknown as WebGPURenderer, now: () => clock, targets };
}

/** Device pixels the bench scene pass fills: the drawing buffer times the pass scale. */
function scenePassPixels(pixelRatio: number): number {
  return (
    Math.floor(320 * pixelRatio * benchPost.dynamicScale) *
    Math.floor(240 * pixelRatio * benchPost.dynamicScale)
  );
}

describe('runBenchmark', () => {
  it('scores a fast device as high within the time budget', async () => {
    const gpu = fakeGpu(200, 3);
    const result = await runBenchmark(gpu.renderer, gpu.now);
    expect(result.tier).toBe('high');
    expect(result.msPerFrame).toBeCloseTo(3, 5);
    expect(result.complete).toBe(true);
    expect(result.samples).toHaveLength(5);
    expect(gpu.now()).toBeLessThanOrEqual(TIME_BUDGET_MS);
  });

  it('returns low without rendering a frame when compiling alone blows the budget', async () => {
    const gpu = fakeGpu(TIME_BUDGET_MS + 1, 3);
    const result = await runBenchmark(gpu.renderer, gpu.now);
    expect(result).toEqual({
      tier: 'low',
      complete: false,
      msPerFrame: TIME_BUDGET_MS + 1,
      samples: [],
    });
    expect(postRender).not.toHaveBeenCalled();
    expect(disposed.sort()).toEqual(['bench', 'post']);
  });

  it('stops after warm-up when setup used up the budget, scoring the warm-up frames', async () => {
    const gpu = fakeGpu(TIME_BUDGET_MS - 20, 3);
    const result = await runBenchmark(gpu.renderer, gpu.now);
    expect(result.tier).toBe('high');
    expect(result.complete).toBe(false);
    expect(result.samples).toHaveLength(1);
    expect(postRender).toHaveBeenCalledTimes(1 + 4 * 2);
    expect(gpu.now()).toBeLessThan(TIME_BUDGET_MS + 50);
  });

  it('counts compile time against the budget for the measured batches', async () => {
    const gpu = fakeGpu(1500, 12);
    const result = await runBenchmark(gpu.renderer, gpu.now);
    expect(result.tier).toBe('medium');
    expect(result.complete).toBe(false);
    expect(gpu.now()).toBeLessThan(TIME_BUDGET_MS + 4 * 12 + 1);
  });

  it('gives up after one batch on a hopeless device without claiming a complete run', async () => {
    const gpu = fakeGpu(100, 200);
    const result = await runBenchmark(gpu.renderer, gpu.now);
    expect(result).toMatchObject({ tier: 'low', complete: false });
    expect(result.msPerFrame).toBeGreaterThanOrEqual(200);
    expect(result.samples).toEqual([result.msPerFrame]);
    expect(postRender).toHaveBeenCalledTimes(1 + 4);
  });
});

describe('benchmark resolution', () => {
  it.each([
    ['low', QUALITY_PROFILES.low.maxPixelRatio],
    ['medium', QUALITY_PROFILES.medium.maxPixelRatio],
    ['high', QUALITY_PROFILES.high.maxPixelRatio],
  ])(
    'measures a DPR 3 display at the high-tier pixel count while the live tier is %s',
    async (_tier, liveRatio) => {
      const gpu = fakeGpu(100, 3, liveRatio);
      await runBenchmark(gpu.renderer, gpu.now, { devicePixelRatio: () => 3 });
      const highRatio = QUALITY_PROFILES.high.maxPixelRatio;
      expect(gpu.targets.map((target) => [target.width, target.height])).toEqual([
        [320 * highRatio, 240 * highRatio],
      ]);
      expect(scenePassPixels(liveRatio)).toBe(320 * highRatio * 240 * highRatio);
      expect(benchPost.pipelineRatio).toBe(liveRatio);
      expect(benchPost.profile?.bloom.resolutionScale).toBeCloseTo(
        (QUALITY_PROFILES.high.bloom.resolutionScale * highRatio) / liveRatio,
        10,
      );
      expect(benchPost.profile?.antiAlias).toBe(QUALITY_PROFILES.high.antiAlias);
    },
  );

  it('stays at the display ratio on a display below the high cap', () => {
    expect(benchResolution(390, 844, 1, 1.5)).toEqual({ width: 585, height: 1266, passScale: 1.5 });
    expect(benchResolution(390, 844, 1, 1)).toEqual({ width: 390, height: 844, passScale: 1 });
  });

  it('treats an unreadable device pixel ratio as 1', () => {
    expect(benchResolution(390, 844, 1, Number.NaN)).toEqual({
      width: 390,
      height: 844,
      passScale: 1,
    });
  });

  it('rejects a renderer without a pixel ratio', () => {
    expect(() => benchResolution(390, 844, 0, 2)).toThrow(/pixel ratio above 0/);
  });
});

describe('runInterruptibleBenchmark', () => {
  it('scores like runBenchmark when nothing interrupts it', async () => {
    const gpu = fakeGpu(200, 3);
    const result = await runInterruptibleBenchmark(gpu.renderer, () => false, gpu.now);
    expect(result).toMatchObject({ tier: 'high', complete: true });
  });

  it('stops within one batch of the interrupt and scores nothing', async () => {
    const gpu = fakeGpu(200, 3);
    let interrupt = false;
    postRender.mockImplementation(() => {
      if (postRender.mock.calls.length === 6) interrupt = true;
    });
    const result = await runInterruptibleBenchmark(gpu.renderer, () => interrupt, gpu.now);
    expect(result).toBeNull();
    expect(postRender).toHaveBeenCalledTimes(1 + 4 * 2);
    expect(disposed.sort()).toEqual(['bench', 'post']);
  });

  it('stops right after compiling when input arrived meanwhile', async () => {
    const gpu = fakeGpu(200, 3);
    const result = await runInterruptibleBenchmark(gpu.renderer, () => true, gpu.now);
    expect(result).toBeNull();
    expect(postRender).not.toHaveBeenCalled();
  });
});
