import { describe, expect, it, vi } from 'vitest';
import {
  createQualityGovernor,
  resolveQuality,
  type QualityGovernor,
  type ScalablePipeline,
} from './adaptiveQuality.ts';
import type { BenchmarkResult } from './benchmark.ts';
import {
  DOWNGRADE_BOOTS,
  loadQuality,
  QUALITY_STORAGE_KEY,
  saveQuality,
  type KeyValueStore,
} from './storage.ts';
import { canvasPixelRatio, QUALITY_PROFILES, type QualityProfile } from './tiers.ts';

function memoryStore(): KeyValueStore {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

const quietLogger = () => ({
  info: vi.fn<(message: string) => void>(),
  warn: vi.fn<(message: string, error?: unknown) => void>(),
});

function benchmarkReturning(result: Omit<BenchmarkResult, 'samples' | 'compileMs'>) {
  return vi.fn<() => Promise<BenchmarkResult>>(() =>
    Promise.resolve({ ...result, samples: [result.msPerFrame], compileMs: 850 }),
  );
}

describe('resolveQuality', () => {
  it('benchmarks on first boot and saves the pick for the next boot', async () => {
    const store = memoryStore();
    const benchmark = benchmarkReturning({ tier: 'medium', msPerFrame: 9 });
    const first = await resolveQuality({
      backend: 'webgpu',
      store,
      benchmark,
      logger: quietLogger(),
    });
    expect(first).toEqual({
      profile: QUALITY_PROFILES.medium,
      source: 'benchmark',
      benchmarkMs: 9,
    });

    const second = await resolveQuality({
      backend: 'webgpu',
      store,
      benchmark,
      logger: quietLogger(),
    });
    expect(second.source).toBe('stored');
    expect(second.profile.tier).toBe('medium');
    expect(benchmark).toHaveBeenCalledOnce();
  });

  it('logs the shader compile time alongside the score', async () => {
    const logger = quietLogger();
    await resolveQuality({
      backend: 'webgl2',
      store: null,
      benchmark: benchmarkReturning({ tier: 'medium', msPerFrame: 9 }),
      logger,
    });
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('shader compile 850 ms'));
  });

  it('starts at a governor downgrade for a few boots, then returns to the benchmark tier', async () => {
    const store = memoryStore();
    saveQuality(store, {
      tier: 'high',
      backend: 'webgpu',
      benchmarkMs: 5,
      downgrade: { tier: 'low', bootsLeft: DOWNGRADE_BOOTS },
    });
    const benchmark = benchmarkReturning({ tier: 'high', msPerFrame: 5 });
    const tiers: string[] = [];
    for (let boot = 0; boot < DOWNGRADE_BOOTS + 2; boot++) {
      const resolved = await resolveQuality({
        backend: 'webgpu',
        store,
        benchmark,
        logger: quietLogger(),
      });
      tiers.push(resolved.profile.tier);
    }
    expect(tiers).toEqual([...Array<string>(DOWNGRADE_BOOTS).fill('low'), 'high', 'high']);
    expect(benchmark).not.toHaveBeenCalled();
    expect(loadQuality(store, 'webgpu')?.downgrade).toBeNull();
  });

  it('ignores an expired downgrade record', async () => {
    const store = memoryStore();
    saveQuality(store, {
      tier: 'medium',
      backend: 'webgpu',
      benchmarkMs: 8,
      downgrade: { tier: 'low', bootsLeft: 0 },
    });
    const resolved = await resolveQuality({
      backend: 'webgpu',
      store,
      benchmark: benchmarkReturning({ tier: 'high', msPerFrame: 3 }),
      logger: quietLogger(),
    });
    expect(resolved.profile.tier).toBe('medium');
  });

  it('re-benchmarks when the renderer came up on a different backend', async () => {
    const store = memoryStore();
    saveQuality(store, { tier: 'high', backend: 'webgpu', benchmarkMs: 3, downgrade: null });
    const benchmark = benchmarkReturning({ tier: 'low', msPerFrame: 20 });
    const resolved = await resolveQuality({
      backend: 'webgl2',
      store,
      benchmark,
      logger: quietLogger(),
    });
    expect(resolved.profile.tier).toBe('low');
    expect(benchmark).toHaveBeenCalledOnce();
  });

  it('skips benchmark and storage for an explicit override', async () => {
    const store = memoryStore();
    const benchmark = benchmarkReturning({ tier: 'low', msPerFrame: 20 });
    const resolved = await resolveQuality({
      backend: 'webgpu',
      store,
      benchmark,
      override: 'high',
    });
    expect(resolved.source).toBe('override');
    expect(benchmark).not.toHaveBeenCalled();
    expect(loadQuality(store, 'webgpu')).toBeNull();
  });

  it('still resolves a tier when storage is unavailable', async () => {
    const benchmark = benchmarkReturning({ tier: 'high', msPerFrame: 4 });
    const resolved = await resolveQuality({
      backend: 'webgpu',
      store: null,
      benchmark,
      logger: quietLogger(),
    });
    expect(resolved.profile.tier).toBe('high');
  });
});

const VSYNC_MS = 1000 / 60;

interface FakePipeline extends ScalablePipeline {
  readonly history: string[];
}

/**
 * Emulates the wired renderer: the canvas pixel ratio follows the tier, as
 * createAdaptiveRendering applies it, and the scene renders at that ratio times the scale.
 */
function fakePipeline(profile: QualityProfile, devicePixelRatio = 2): FakePipeline {
  const state = { profile, dynamicScale: profile.maxResolutionScale };
  const history: string[] = [];
  return {
    history,
    get profile() {
      return state.profile;
    },
    get dynamicScale() {
      return state.dynamicScale;
    },
    get rendererPixelRatio() {
      return canvasPixelRatio(state.profile, devicePixelRatio);
    },
    setProfile(next) {
      state.profile = next;
      history.push(`tier:${next.tier}`);
    },
    setDynamicScale(scale) {
      state.dynamicScale = scale;
      history.push(`scale:${scale}`);
    },
  };
}

function renderedPixelRatio(post: ScalablePipeline): number {
  return canvasPixelRatio(post.profile, post.rendererPixelRatio) * post.dynamicScale;
}

interface Load {
  readonly fixedMs: number;
  /** GPU milliseconds at a rendered pixel ratio of 1; cost follows pixel count. */
  readonly gpuMsAtRatio1: number;
}

/** Drives the governor with frame times a real device would present on a vsynced display. */
function drive(
  governor: QualityGovernor,
  post: ScalablePipeline,
  load: Load,
  durationMs: number,
  intervalMs = VSYNC_MS,
  stop: () => boolean = () => false,
): void {
  let now = 0;
  governor.frame(now);
  while (now < durationMs && !stop()) {
    const ratio = renderedPixelRatio(post);
    const work = load.fixedMs + load.gpuMsAtRatio1 * ratio * ratio;
    now += Math.max(1, Math.ceil(work / intervalMs - 1e-9)) * intervalMs;
    governor.frame(now);
  }
}

const GPU_BOUND: Load = { fixedMs: 4, gpuMsAtRatio1: 120 };

function storedBenchmark(store: KeyValueStore, tier: QualityProfile['tier']): void {
  saveQuality(store, { tier, backend: 'webgpu', benchmarkMs: 5, downgrade: null });
}

describe('createQualityGovernor', () => {
  it('shrinks resolution first, then steps the tier down and saves an expiring downgrade', () => {
    const store = memoryStore();
    storedBenchmark(store, 'high');
    const post = fakePipeline(QUALITY_PROFILES.high);
    const onTierChange = vi.fn<(profile: QualityProfile) => void>();
    const governor = createQualityGovernor(post, {
      backend: 'webgpu',
      store,
      onTierChange,
      logger: quietLogger(),
    });

    drive(governor, post, GPU_BOUND, 60_000, VSYNC_MS, () => post.profile.tier !== 'high');

    const firstTierChange = post.history.findIndex((entry) => entry.startsWith('tier:'));
    expect(firstTierChange).toBeGreaterThan(0);
    expect(
      post.history.slice(0, firstTierChange).every((entry) => entry.startsWith('scale:')),
    ).toBe(true);
    expect(post.profile.tier).toBe('medium');
    expect(onTierChange).toHaveBeenCalledWith(QUALITY_PROFILES.medium);
    expect(loadQuality(store, 'webgpu')).toEqual({
      tier: 'high',
      backend: 'webgpu',
      benchmarkMs: 5,
      downgrade: { tier: 'medium', bootsLeft: DOWNGRADE_BOOTS },
    });
  });

  it.each([
    [1, 0.6],
    [1.5, 0.6],
    [2, 0.8],
  ])(
    'keeps the rendered pixel ratio across a tier change at DPR %s',
    (devicePixelRatio, expectedScale) => {
      const post = fakePipeline(QUALITY_PROFILES.high, devicePixelRatio);
      const governor = createQualityGovernor(post, {
        backend: 'webgpu',
        store: null,
        logger: quietLogger(),
      });
      let before = Number.NaN;
      let now = 0;
      governor.frame(now);
      while (post.profile.tier === 'high' && now < 60_000) {
        before = renderedPixelRatio(post);
        const work = GPU_BOUND.fixedMs + GPU_BOUND.gpuMsAtRatio1 * before * before;
        now += Math.ceil(work / VSYNC_MS) * VSYNC_MS;
        governor.frame(now);
      }
      expect(post.profile.tier).toBe('medium');
      expect(before).toBeCloseTo(
        QUALITY_PROFILES.high.minResolutionScale * Math.min(devicePixelRatio, 2),
        5,
      );
      expect(governor.scale).toBeCloseTo(expectedScale, 5);
      expect(renderedPixelRatio(post)).toBeLessThanOrEqual(before + 1e-9);
    },
  );

  it('stops at the low tier', () => {
    const post = fakePipeline(QUALITY_PROFILES.low);
    const governor = createQualityGovernor(post, {
      backend: 'webgl2',
      store: null,
      logger: quietLogger(),
    });
    drive(governor, post, GPU_BOUND, 120_000);
    expect(post.profile.tier).toBe('low');
    expect(governor.scale).toBe(QUALITY_PROFILES.low.minResolutionScale);
  });

  it('leaves a healthy 60 fps game untouched', () => {
    const post = fakePipeline(QUALITY_PROFILES.high);
    const governor = createQualityGovernor(post, { backend: 'webgpu', store: null });
    drive(governor, post, { fixedMs: 3, gpuMsAtRatio1: 2 }, 60_000);
    expect(post.history).toEqual([]);
  });

  it.each([
    ['a 30 Hz rAF cap', { fixedMs: 3, gpuMsAtRatio1: 2 }, 1000 / 30],
    ['a CPU-bound frame', { fixedMs: 26, gpuMsAtRatio1: 1 }, VSYNC_MS],
  ])('keeps the tier, resolution and saved record under %s', (_label, load, intervalMs) => {
    const store = memoryStore();
    storedBenchmark(store, 'high');
    const saved = store.getItem(QUALITY_STORAGE_KEY);
    const post = fakePipeline(QUALITY_PROFILES.high);
    const governor = createQualityGovernor(post, {
      backend: 'webgpu',
      store,
      logger: quietLogger(),
    });
    drive(governor, post, load, 120_000, intervalMs);
    expect(post.profile.tier).toBe('high');
    expect(governor.scale).toBe(1);
    expect(post.history).not.toContainEqual(expect.stringMatching(/^tier:/));
    expect(store.getItem(QUALITY_STORAGE_KEY)).toBe(saved);
  });
});
