import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Vector2, WebGPURenderer } from 'three/webgpu';
import { runBenchmark, softwareRasterizerOf, TIME_BUDGET_MS } from './benchmark.ts';

const postRender = vi.fn<(nowMs: number) => void>();
const disposed: string[] = [];

vi.mock('./benchScene.ts', () => ({
  BENCH_LOOK: { exposure: 0.85, environmentIntensity: 0.9, shadows: true },
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

const SYNC_MS = 0.5;

interface FakeGpuCosts {
  /** What `compileAsync` costs on the fake clock. */
  readonly compileMs: number;
  /** One high-tier post frame. */
  readonly frameMs: number;
  /** One bare frame of the bench scene; defaults to a third of `frameMs`. */
  readonly bareMs?: number;
  /** Replaces `compileAsync`, for compiles that settle on their own schedule. */
  readonly compile?: () => Promise<void>;
  readonly backend?: object;
}

interface FakeGpu {
  readonly renderer: WebGPURenderer;
  readonly now: () => number;
  readonly bareRenders: () => number;
  readonly compiles: () => number;
}

/** A renderer on a fake clock: each step advances it by what that step costs. */
function fakeGpu(costs: FakeGpuCosts): FakeGpu {
  let clock = 0;
  let bareRenders = 0;
  let compiles = 0;
  postRender.mockReset();
  postRender.mockImplementation(() => {
    clock += costs.frameMs;
  });
  disposed.length = 0;
  const renderer = {
    backend: costs.backend ?? {},
    compileAsync: () => {
      compiles++;
      if (costs.compile) return costs.compile();
      clock += costs.compileMs;
      return Promise.resolve();
    },
    render: () => {
      bareRenders++;
      clock += costs.bareMs ?? costs.frameMs / 3;
    },
    getDrawingBufferSize: (target: Vector2) => target.set(320, 240),
    getRenderTarget: () => null,
    setRenderTarget: vi.fn(),
    readRenderTargetPixelsAsync: () => {
      clock += SYNC_MS;
      return Promise.resolve(new Uint8Array(4));
    },
  };
  return {
    renderer: renderer as unknown as WebGPURenderer,
    now: () => clock,
    bareRenders: () => bareRenders,
    compiles: () => compiles,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('runBenchmark', () => {
  it('scores a fast device as high within the time budget', async () => {
    const gpu = fakeGpu({ compileMs: 200, frameMs: 3 });
    const result = await runBenchmark(gpu.renderer, gpu.now);
    expect(result.tier).toBe('high');
    expect(result.msPerFrame).toBeCloseTo(3, 5);
    expect(result.complete).toBe(true);
    expect(result.samples).toHaveLength(5);
    expect(result.softwareGpu).toBeUndefined();
    expect(gpu.now()).toBeLessThanOrEqual(TIME_BUDGET_MS);
    expect(disposed.sort()).toEqual(['bench', 'post']);
  });

  it('caps the whole run at 600 ms', () => {
    expect(TIME_BUDGET_MS).toBe(600);
  });

  it('returns low without rendering a frame when compiling alone blows the budget', async () => {
    const gpu = fakeGpu({ compileMs: TIME_BUDGET_MS + 1, frameMs: 3 });
    const result = await runBenchmark(gpu.renderer, gpu.now);
    expect(result).toEqual({
      tier: 'low',
      complete: false,
      msPerFrame: TIME_BUDGET_MS + 1,
      samples: [],
    });
    expect(postRender).not.toHaveBeenCalled();
    expect(gpu.bareRenders()).toBe(0);
    expect(disposed.sort()).toEqual(['bench', 'post']);
  });

  it('stops waiting for a compile at the deadline and frees the bench once it settles', async () => {
    vi.useFakeTimers();
    let finishCompile = (): void => undefined;
    const gpu = fakeGpu({
      compileMs: 0,
      frameMs: 3,
      compile: () =>
        new Promise<void>((resolve) => {
          finishCompile = resolve;
        }),
    });
    const running = runBenchmark(gpu.renderer, gpu.now);
    await vi.advanceTimersByTimeAsync(TIME_BUDGET_MS);
    const result = await running;
    expect(result).toMatchObject({ tier: 'low', complete: false, samples: [] });
    expect(postRender).not.toHaveBeenCalled();
    expect(disposed).toEqual([]);
    finishCompile();
    await vi.waitFor(() => {
      expect(disposed.sort()).toEqual(['bench', 'post']);
    });
  });

  it('picks low from one bare frame on a slow device, without compiling the post graph', async () => {
    const gpu = fakeGpu({ compileMs: 150, frameMs: 240, bareMs: 80 });
    const result = await runBenchmark(gpu.renderer, gpu.now);
    expect(result).toEqual({ tier: 'low', complete: false, msPerFrame: 80, samples: [80] });
    expect(postRender).not.toHaveBeenCalled();
    expect(gpu.now()).toBeLessThanOrEqual(TIME_BUDGET_MS);
  });

  it('never vouches for high from the bare frame alone when the budget runs out', async () => {
    const gpu = fakeGpu({ compileMs: TIME_BUDGET_MS - 6, frameMs: 3, bareMs: 1 });
    const result = await runBenchmark(gpu.renderer, gpu.now);
    expect(result).toMatchObject({ tier: 'medium', complete: false, msPerFrame: 1 });
    expect(postRender).not.toHaveBeenCalled();
  });

  it('stops before a batch that would overrun the budget, keeping the frames it has', async () => {
    const gpu = fakeGpu({ compileMs: TIME_BUDGET_MS - 120, frameMs: 6, bareMs: 1 });
    const result = await runBenchmark(gpu.renderer, gpu.now);
    expect(result.tier).toBe('high');
    expect(result.complete).toBe(false);
    expect(result.samples.length).toBeGreaterThan(0);
    expect(result.samples.length).toBeLessThan(5);
    expect(gpu.now()).toBeLessThanOrEqual(TIME_BUDGET_MS);
  });

  it('counts compile time against the budget for the measured batches', async () => {
    const gpu = fakeGpu({ compileMs: 350, frameMs: 12, bareMs: 4 });
    const result = await runBenchmark(gpu.renderer, gpu.now);
    expect(result.tier).toBe('medium');
    expect(result.complete).toBe(false);
    expect(gpu.now()).toBeLessThanOrEqual(TIME_BUDGET_MS);
  });

  // Only the first bare frame after the compile starts without a measured cost to admit it.
  it('runs at most one frame past the budget when frames cost what was measured before', async () => {
    for (const frameMs of [1, 4, 9, 12, 14, 30, 60, 120, 400]) {
      for (const compileMs of [0, 50, 250, 450, 590]) {
        const gpu = fakeGpu({ compileMs, frameMs, bareMs: frameMs });
        await runBenchmark(gpu.renderer, gpu.now);
        const limit = compileMs + 4 * SYNC_MS + frameMs <= TIME_BUDGET_MS ? 0 : frameMs + SYNC_MS;
        expect(gpu.now(), `compile ${compileMs} ms, frame ${frameMs} ms`).toBeLessThanOrEqual(
          TIME_BUDGET_MS + limit,
        );
      }
    }
  });

  it('overruns by at most the post graph frames that cost more than bare ones', async () => {
    for (const frameMs of [4, 14, 30, 50]) {
      for (const compileMs of [0, 250, 500]) {
        const gpu = fakeGpu({ compileMs, frameMs, bareMs: frameMs / 4 });
        await runBenchmark(gpu.renderer, gpu.now);
        expect(gpu.now(), `compile ${compileMs} ms, frame ${frameMs} ms`).toBeLessThanOrEqual(
          TIME_BUDGET_MS + 2 * frameMs,
        );
      }
    }
  });

  it('gives up after one post frame on a hopeless device without claiming a complete run', async () => {
    const gpu = fakeGpu({ compileMs: 100, frameMs: 200, bareMs: 10 });
    const result = await runBenchmark(gpu.renderer, gpu.now);
    expect(result).toMatchObject({ tier: 'low', complete: false });
    expect(result.msPerFrame).toBeGreaterThanOrEqual(199);
    expect(result.samples).toEqual([result.msPerFrame]);
    expect(postRender).toHaveBeenCalledTimes(2);
    expect(gpu.now()).toBeLessThanOrEqual(TIME_BUDGET_MS);
  });

  it('scores a software rasterizer as low without compiling or drawing anything', async () => {
    const gpu = fakeGpu({
      compileMs: 100,
      frameMs: 3,
      backend: { device: { adapterInfo: { vendor: 'google', architecture: 'swiftshader' } } },
    });
    const result = await runBenchmark(gpu.renderer, gpu.now);
    expect(result).toEqual({
      tier: 'low',
      complete: false,
      msPerFrame: 0,
      samples: [],
      softwareGpu: 'google swiftshader',
    });
    expect(gpu.compiles()).toBe(0);
    expect(gpu.bareRenders()).toBe(0);
    expect(postRender).not.toHaveBeenCalled();
  });
});

describe('softwareRasterizerOf', () => {
  const UNMASKED_RENDERER = 0x9246;
  const RENDERER = 0x1f01;
  const webgl = (unmasked: string | null, masked = 'WebKit WebGL') => ({
    backend: {
      gl: {
        RENDERER,
        getExtension: (name: string) =>
          name === 'WEBGL_debug_renderer_info' && unmasked !== null
            ? { UNMASKED_RENDERER_WEBGL: UNMASKED_RENDERER }
            : null,
        getParameter: (parameter: number) => (parameter === UNMASKED_RENDERER ? unmasked : masked),
      },
    },
  });
  const webgpu = (info: object) => ({ backend: { device: { adapterInfo: info } } });
  const of = (renderer: object) =>
    softwareRasterizerOf(renderer as Pick<WebGPURenderer, 'backend'>);

  it('names SwiftShader and llvmpipe behind WebGL2', () => {
    const swiftShader =
      'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)';
    expect(of(webgl(swiftShader))).toBe(swiftShader);
    expect(of(webgl('llvmpipe (LLVM 15.0.7, 256 bits)'))).toBe('llvmpipe (LLVM 15.0.7, 256 bits)');
  });

  it('reads the masked renderer string when the debug extension is withheld', () => {
    expect(of(webgl(null, 'Google SwiftShader'))).toBe('Google SwiftShader');
    expect(of(webgl(null))).toBeNull();
  });

  it('passes real GPUs', () => {
    expect(
      of(webgl('ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)')),
    ).toBeNull();
    expect(of(webgl('Adreno (TM) 642L'))).toBeNull();
    expect(of(webgpu({ vendor: 'qualcomm', architecture: 'adreno-6xx' }))).toBeNull();
  });

  it('flags a WebGPU fallback adapter whatever it calls itself', () => {
    expect(of(webgpu({ vendor: 'google', architecture: 'swiftshader' }))).toBe(
      'google swiftshader',
    );
    expect(of(webgpu({ isFallbackAdapter: true, vendor: 'acme' }))).toBe('acme');
    expect(of(webgpu({ isFallbackAdapter: true }))).toBe('fallback adapter');
  });

  it('says nothing about a backend it cannot inspect', () => {
    expect(of({ backend: {} })).toBeNull();
    expect(of({ backend: { device: {} } })).toBeNull();
  });
});
