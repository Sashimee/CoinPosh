import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Camera, Scene, WebGPURenderer } from 'three/webgpu';
import { DEFAULT_RENDER_LOOK, type RenderLook } from '../post/look.ts';
import type { BenchmarkResult } from './benchmark.ts';
import { BENCHMARK_AFTER_FRAMES, type IdleScheduler } from './deferredBenchmark.ts';
import { saveQuality, type KeyValueStore } from './storage.ts';
import { QUALITY_PROFILES, type QualityProfile } from './tiers.ts';

const calls: string[] = [];
const runBenchmark = vi.fn<(interrupted: () => boolean) => Promise<BenchmarkResult | null>>();

vi.mock('./benchmark.ts', () => ({
  runBenchmark: () => {
    calls.push('benchmark');
    return runBenchmark(() => false);
  },
  runInterruptibleBenchmark: (_renderer: unknown, interrupted: () => boolean) => {
    calls.push('benchmark');
    return runBenchmark(interrupted);
  },
}));

vi.mock('./gpuTimer.ts', () => ({ createGpuFrameTimer: () => null }));

const precompileScene = vi.fn<() => Promise<void>>();
vi.mock('./precompile.ts', () => ({ precompileScene: () => precompileScene() }));

vi.mock('../post/postPipeline.ts', () => ({
  createPostPipeline: (
    _renderer: unknown,
    _scene: unknown,
    _camera: unknown,
    initial: QualityProfile,
    options: { look?: RenderLook },
  ) => {
    let profile = initial;
    let dynamicScale = initial.maxResolutionScale;
    const look = options.look ?? DEFAULT_RENDER_LOOK;
    calls.push(`post:${initial.tier}`);
    return {
      get profile() {
        return profile;
      },
      get look() {
        return look;
      },
      get pixelRatio() {
        return 1;
      },
      get dynamicScale() {
        return dynamicScale;
      },
      get scenePixelRatio() {
        return dynamicScale;
      },
      setProfile(next: QualityProfile) {
        profile = next;
        calls.push(`tier:${next.tier}`);
      },
      setDynamicScale(scale: number) {
        dynamicScale = scale;
      },
      setLook(next: RenderLook) {
        calls.push(`look:${next === look ? 'own' : 'other'}`);
      },
      render() {
        calls.push('render');
      },
      dispose() {
        calls.push('dispose');
      },
    };
  },
}));

const { createAdaptiveRendering } = await import('./index.ts');

function memoryStore(): KeyValueStore {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

function manualIdle() {
  const queued: (() => void)[] = [];
  const whenIdle: IdleScheduler = (callback) => {
    queued.push(callback);
    return () => undefined;
  };
  return {
    whenIdle,
    queued,
    fire() {
      for (const callback of queued.splice(0)) callback();
    },
  };
}

function clock(startMs: number) {
  let ms = startMs;
  return {
    now: () => ms,
    advance(by: number) {
      ms += by;
      return ms;
    },
  };
}

const HIGH: BenchmarkResult = { tier: 'high', complete: true, msPerFrame: 4, samples: [4] };

function boot(options: { store?: KeyValueStore | null; startMs?: number } = {}) {
  const time = clock(options.startMs ?? 5000);
  const idle = manualIdle();
  const onTierChange = vi.fn<(profile: QualityProfile) => void>();
  const adaptive = createAdaptiveRendering({
    renderer: {} as WebGPURenderer,
    scene: {} as Scene,
    camera: {} as Camera,
    backend: 'webgpu',
    store: options.store === undefined ? memoryStore() : options.store,
    benchmark: 'deferred',
    onTierChange,
    now: time.now,
    visibility: null,
    whenIdle: idle.whenIdle,
    input: null,
  });
  return { adaptive, time, idle, onTierChange };
}

beforeEach(() => {
  calls.length = 0;
  runBenchmark.mockReset();
  precompileScene.mockReset();
});

describe('AdaptiveRendering.precompile', () => {
  it('holds frames until the compile is done, then draws again', async () => {
    let finish!: () => void;
    precompileScene.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { adaptive, time } = boot();
    const rendering = await adaptive;
    let settled = false;
    const compiling = rendering.precompile({} as Scene, {} as Camera).then(() => {
      settled = true;
    });
    calls.length = 0;
    rendering.render(time.advance(16));
    expect(calls).toEqual([]);
    expect(settled).toBe(false);

    finish();
    await compiling;
    rendering.render(time.advance(16));
    expect(calls).toEqual(['render']);
  });

  it('passes a failed compile on and still draws afterwards', async () => {
    precompileScene.mockRejectedValue(new Error('pipeline creation failed'));
    const { adaptive, time } = boot();
    const rendering = await adaptive;
    await expect(rendering.precompile({} as Scene, {} as Camera)).rejects.toThrow(
      'pipeline creation failed',
    );
    calls.length = 0;
    rendering.render(time.advance(16));
    expect(calls).toEqual(['render']);
  });

  it('resolves on dispose when the lost renderer never finishes compiling', async () => {
    precompileScene.mockReturnValue(new Promise(() => undefined));
    const { adaptive } = boot();
    const rendering = await adaptive;
    const compiling = rendering.precompile({} as Scene, {} as Camera);
    rendering.dispose();
    await expect(compiling).resolves.toBeUndefined();
    await expect(rendering.precompile({} as Scene, {} as Camera)).resolves.toBeUndefined();
    expect(precompileScene).toHaveBeenCalledOnce();
  });
});

describe('createAdaptiveRendering with a deferred benchmark', () => {
  it('draws the first frames at the provisional tier, then switches in place once measured', async () => {
    let finish!: (result: BenchmarkResult) => void;
    runBenchmark.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { adaptive, time, idle, onTierChange } = boot();
    const rendering = await adaptive;
    expect(calls).toEqual(['post:low']);
    expect(rendering.resolved.source).toBe('pending');

    for (let i = 0; i < BENCHMARK_AFTER_FRAMES; i++) rendering.render(time.advance(16));
    expect(calls.filter((call) => call === 'render')).toHaveLength(BENCHMARK_AFTER_FRAMES);
    expect(calls).not.toContain('benchmark');

    idle.fire();
    expect(calls.at(-1)).toBe('benchmark');
    calls.length = 0;
    rendering.render(time.advance(16));
    rendering.render(time.advance(16));
    expect(calls).toEqual([]);

    finish(HIGH);
    await vi.waitFor(() => {
      expect(onTierChange).toHaveBeenCalledWith(QUALITY_PROFILES.high);
    });
    expect(calls).toEqual(['look:own', 'tier:high']);
    expect(rendering.profile).toBe(QUALITY_PROFILES.high);
    expect(rendering.resolved.source).toBe('benchmark');

    calls.length = 0;
    rendering.render(time.advance(1800));
    expect(calls).toEqual(['render']);
    expect(rendering.governor.smoothedFrameMs).toBeNull();
  });

  it('restores the look and draws again after a run cut short by input, then retries', async () => {
    runBenchmark.mockResolvedValueOnce(null).mockResolvedValueOnce(HIGH);
    const { adaptive, time, idle, onTierChange } = boot();
    const rendering = await adaptive;
    for (let i = 0; i < BENCHMARK_AFTER_FRAMES; i++) rendering.render(time.advance(16));
    idle.fire();
    await vi.waitFor(() => {
      expect(idle.queued).toHaveLength(1);
    });
    expect(calls.slice(-2)).toEqual(['benchmark', 'look:own']);
    expect(onTierChange).not.toHaveBeenCalled();
    calls.length = 0;
    rendering.render(time.advance(16));
    expect(calls).toEqual(['render']);

    idle.fire();
    await vi.waitFor(() => {
      expect(onTierChange).toHaveBeenCalledWith(QUALITY_PROFILES.high);
    });
    expect(runBenchmark).toHaveBeenCalledTimes(2);
  });

  it('renders a first frame held past a second after the build without throwing', async () => {
    const { adaptive, time } = boot();
    const rendering = await adaptive;
    const frameStart = time.advance(16);
    time.advance(2500);
    expect(() => {
      rendering.render(frameStart);
    }).not.toThrow();
  });

  it('still rejects a timestamp on another clock', async () => {
    const { adaptive, time } = boot();
    const rendering = await adaptive;
    time.advance(16);
    expect(() => {
      rendering.render(5.016);
    }).toThrow(/requestAnimationFrame timestamp/);
  });

  it('reuses the saved tier on later boots and never measures again', async () => {
    const store = memoryStore();
    saveQuality(store, { backend: 'webgpu', benchTier: 'medium', benchmarkMs: 8, downgrade: null });
    const { adaptive, time, idle } = boot({ store });
    const rendering = await adaptive;
    expect(calls).toEqual(['post:medium']);
    for (let i = 0; i < BENCHMARK_AFTER_FRAMES * 4; i++) rendering.render(time.advance(16));
    expect(idle.queued).toHaveLength(0);
    expect(calls).not.toContain('benchmark');
  });

  it('drops a benchmark that finishes after the renderer was disposed', async () => {
    let finish!: (result: BenchmarkResult) => void;
    runBenchmark.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { adaptive, time, idle, onTierChange } = boot();
    const rendering = await adaptive;
    for (let i = 0; i < BENCHMARK_AFTER_FRAMES; i++) rendering.render(time.advance(16));
    idle.fire();
    rendering.dispose();
    finish(HIGH);
    await Promise.resolve();
    await Promise.resolve();
    expect(onTierChange).not.toHaveBeenCalled();
    expect(calls).not.toContain('tier:high');
  });

  it('keeps the provisional tier and the renderer look when the benchmark fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    runBenchmark.mockRejectedValue(new Error('readback failed'));
    const { adaptive, time, idle, onTierChange } = boot();
    const rendering = await adaptive;
    for (let i = 0; i < BENCHMARK_AFTER_FRAMES; i++) rendering.render(time.advance(16));
    idle.fire();
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('staying at the provisional low tier'),
        expect.any(Error),
      );
    });
    expect(calls).toContain('look:own');
    expect(onTierChange).not.toHaveBeenCalled();
    expect(rendering.profile).toBe(QUALITY_PROFILES.low);
    calls.length = 0;
    rendering.render(time.advance(16));
    expect(calls).toEqual(['render']);
    warn.mockRestore();
  });
});

describe('createAdaptiveRendering before the first frame', () => {
  it('measures before resolving, so the first frame is already at the measured tier', async () => {
    runBenchmark.mockResolvedValue(HIGH);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const rendering = await createAdaptiveRendering({
      renderer: {} as WebGPURenderer,
      scene: {} as Scene,
      camera: {} as Camera,
      backend: 'webgl2',
      store: null,
      visibility: null,
    });
    expect(calls).toEqual(['benchmark', 'post:high']);
    expect(rendering.resolved.source).toBe('benchmark');
    info.mockRestore();
  });
});
