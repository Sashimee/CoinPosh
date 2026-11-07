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
  saveQuality,
  type KeyValueStore,
  type StoredQuality,
} from './storage.ts';
import { pixelRatioFor, QUALITY_PROFILES, type QualityProfile, type QualityTier } from './tiers.ts';

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

function benchRecord(benchTier: QualityTier, benchmarkMs: number): StoredQuality {
  return { backend: 'webgpu', benchTier, benchmarkMs, downgrade: null };
}

function benchmarkReturning(result: BenchmarkResult) {
  return vi.fn<() => Promise<BenchmarkResult>>(() => Promise.resolve(result));
}

describe('resolveQuality', () => {
  it('benchmarks on first boot and saves the pick for the next boot', async () => {
    const store = memoryStore();
    const benchmark = benchmarkReturning({
      tier: 'medium',
      msPerFrame: 9,
      samples: [9],
      complete: true,
    });
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
    expect(loadQuality(store, 'webgpu')).toEqual(benchRecord('medium', 9));

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

  it('re-benchmarks when the renderer came up on a different backend', async () => {
    const store = memoryStore();
    saveQuality(store, benchRecord('high', 3));
    const benchmark = benchmarkReturning({
      tier: 'low',
      msPerFrame: 20,
      samples: [20],
      complete: true,
    });
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
    const benchmark = benchmarkReturning({
      tier: 'low',
      msPerFrame: 20,
      samples: [20],
      complete: true,
    });
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

  it('starts at a saved downgrade, then returns to the benchmark tier once it expires', async () => {
    const store = memoryStore();
    saveQuality(store, {
      ...benchRecord('high', 4),
      downgrade: { tier: 'low', bootsLeft: DOWNGRADE_BOOTS },
    });
    const benchmark = benchmarkReturning({
      tier: 'low',
      msPerFrame: 20,
      samples: [20],
      complete: true,
    });
    const boot = () =>
      resolveQuality({ backend: 'webgpu', store, benchmark, logger: quietLogger() });

    for (let i = 0; i < DOWNGRADE_BOOTS; i++) {
      expect(await boot()).toEqual({
        profile: QUALITY_PROFILES.low,
        source: 'downgrade',
        benchmarkMs: 4,
      });
    }
    expect(await boot()).toEqual({
      profile: QUALITY_PROFILES.high,
      source: 'stored',
      benchmarkMs: 4,
    });
    expect(loadQuality(store, 'webgpu')).toEqual(benchRecord('high', 4));
    expect(benchmark).not.toHaveBeenCalled();
  });

  it('still resolves a tier when storage is unavailable', async () => {
    const benchmark = benchmarkReturning({
      tier: 'high',
      msPerFrame: 4,
      samples: [4],
      complete: true,
    });
    const resolved = await resolveQuality({
      backend: 'webgpu',
      store: null,
      benchmark,
      logger: quietLogger(),
    });
    expect(resolved.profile.tier).toBe('high');
  });

  it('uses an incomplete benchmark for this boot only and measures again next boot', async () => {
    const store = memoryStore();
    const benchmark = benchmarkReturning({
      tier: 'medium',
      msPerFrame: 11,
      samples: [11],
      complete: false,
    });
    const boot = () =>
      resolveQuality({ backend: 'webgpu', store, benchmark, logger: quietLogger() });
    expect(await boot()).toEqual({
      profile: QUALITY_PROFILES.medium,
      source: 'provisional',
      benchmarkMs: 11,
    });
    expect(loadQuality(store, 'webgpu')).toBeNull();
    expect((await boot()).source).toBe('provisional');
    expect(benchmark).toHaveBeenCalledTimes(2);
  });
});

interface FakePipeline extends ScalablePipeline {
  readonly history: string[];
}

/** Mirrors PostPipeline: the renderer ratio is the DPR capped by the tier, scaled dynamically. */
function fakePipeline(profile: QualityProfile, devicePixelRatio = 2): FakePipeline {
  const state = { profile, dynamicScale: profile.maxResolutionScale };
  const history: string[] = [];
  const clamp = (scale: number) =>
    Math.min(state.profile.maxResolutionScale, Math.max(state.profile.minResolutionScale, scale));
  return {
    history,
    get profile() {
      return state.profile;
    },
    get pixelRatio() {
      return pixelRatioFor(state.profile, devicePixelRatio);
    },
    get dynamicScale() {
      return state.dynamicScale;
    },
    get scenePixelRatio() {
      return pixelRatioFor(state.profile, devicePixelRatio) * state.dynamicScale;
    },
    setProfile(next) {
      state.profile = next;
      state.dynamicScale = clamp(state.dynamicScale);
      history.push(`tier:${next.tier}`);
    },
    setDynamicScale(scale) {
      state.dynamicScale = clamp(scale);
      history.push(`scale:${scale}`);
    },
  };
}

interface Load {
  /** Main-thread cost per frame; resolution does not change it. */
  readonly cpuMs: number;
  /** GPU cost at a scene pixel ratio of 1; it scales with the pixel count. */
  readonly gpuMsAtRatio1: number;
  readonly refreshHz?: number;
}

interface Sensors {
  readonly cpu?: boolean;
  readonly gpu?: boolean;
}

/**
 * Plays `durationMs` of frames whose presented interval is the slower of CPU and GPU work,
 * rounded up to the display refresh, and records the scene ratio around each tier change.
 */
function play(
  post: FakePipeline,
  governor: QualityGovernor,
  load: Load,
  durationMs: number,
  sensors: Sensors = { cpu: true },
) {
  const steps: { before: number; after: number }[] = [];
  const refreshMs = 1000 / (load.refreshHz ?? 60);
  let now = 1000;
  const end = now + durationMs;
  governor.frame(now);
  while (now < end) {
    const tier = post.profile.tier;
    const before = post.scenePixelRatio;
    const gpuMs = load.gpuMsAtRatio1 * before * before;
    now += Math.max(1, Math.ceil(Math.max(load.cpuMs, gpuMs) / refreshMs - 1e-9)) * refreshMs;
    governor.frame(now, {
      cpuMs: sensors.cpu === true ? load.cpuMs : null,
      gpuMs: sensors.gpu === true ? gpuMs : null,
    });
    if (post.profile.tier !== tier) steps.push({ before, after: post.scenePixelRatio });
  }
  return steps;
}

/** Too slow for 55 fps even at the low tier's floor ratio of 0.5. */
const GPU_OVERLOAD: Load = { cpuMs: 3, gpuMsAtRatio1: 120 };

describe('createQualityGovernor', () => {
  it.each([
    ['frame intervals', { cpu: true }],
    ['GPU timestamps', { cpu: true, gpu: true }],
  ] as const)(
    'shrinks resolution first, then steps the tier down and saves it as a downgrade (%s)',
    (_name, sensors) => {
      const store = memoryStore();
      saveQuality(store, benchRecord('high', 5));
      const post = fakePipeline(QUALITY_PROFILES.high);
      const onTierChange = vi.fn<(profile: QualityProfile) => void>();
      const governor = createQualityGovernor(post, {
        backend: 'webgpu',
        store,
        onTierChange,
        logger: quietLogger(),
      });

      for (let second = 0; second < 120 && post.profile.tier === 'high'; second++) {
        play(post, governor, GPU_OVERLOAD, 1000, sensors);
      }

      const firstTierChange = post.history.findIndex((entry) => entry.startsWith('tier:'));
      expect(firstTierChange).toBeGreaterThan(0);
      expect(
        post.history.slice(0, firstTierChange).every((entry) => entry.startsWith('scale:')),
      ).toBe(true);
      expect(post.profile.tier).toBe('medium');
      expect(onTierChange).toHaveBeenCalledWith(QUALITY_PROFILES.medium);
      expect(loadQuality(store, 'webgpu')).toEqual({
        ...benchRecord('high', 5),
        downgrade: { tier: 'medium', bootsLeft: DOWNGRADE_BOOTS },
      });
    },
  );

  it('renews the downgrade when a downgraded boot has to step down again', () => {
    const store = memoryStore();
    saveQuality(store, { ...benchRecord('high', 5), downgrade: { tier: 'medium', bootsLeft: 1 } });
    const post = fakePipeline(QUALITY_PROFILES.medium);
    const governor = createQualityGovernor(post, {
      backend: 'webgpu',
      store,
      logger: quietLogger(),
    });
    play(post, governor, GPU_OVERLOAD, 120_000);
    expect(post.profile.tier).toBe('low');
    expect(loadQuality(store, 'webgpu')).toEqual({
      ...benchRecord('high', 5),
      downgrade: { tier: 'low', bootsLeft: DOWNGRADE_BOOTS },
    });
  });

  it('does not write a record when no benchmark was saved', () => {
    const store = memoryStore();
    const post = fakePipeline(QUALITY_PROFILES.high);
    const governor = createQualityGovernor(post, {
      backend: 'webgpu',
      store,
      logger: quietLogger(),
    });
    play(post, governor, GPU_OVERLOAD, 180_000);
    expect(post.profile.tier).toBe('low');
    expect(loadQuality(store, 'webgpu')).toBeNull();
  });

  it.each([1, 1.5, 2, 3])(
    'keeps the effective scene ratio across each tier step instead of raising it (DPR %s)',
    (devicePixelRatio) => {
      const post = fakePipeline(QUALITY_PROFILES.high, devicePixelRatio);
      const governor = createQualityGovernor(post, {
        backend: 'webgpu',
        store: null,
        logger: quietLogger(),
      });
      const steps = play(post, governor, GPU_OVERLOAD, 180_000);
      expect(post.profile.tier).toBe('low');
      expect(steps).toHaveLength(2);
      for (const { before, after } of steps) {
        expect(after).toBeLessThanOrEqual(before + 1e-9);
      }
    },
  );

  it('stops at the low tier', () => {
    const post = fakePipeline(QUALITY_PROFILES.low);
    const governor = createQualityGovernor(post, {
      backend: 'webgl2',
      store: null,
      logger: quietLogger(),
    });
    play(post, governor, GPU_OVERLOAD, 120_000, { cpu: true, gpu: true });
    expect(post.profile.tier).toBe('low');
    expect(governor.scale).toBe(QUALITY_PROFILES.low.minResolutionScale);
  });

  it('leaves a healthy 60 fps game untouched', () => {
    const post = fakePipeline(QUALITY_PROFILES.high);
    const governor = createQualityGovernor(post, { backend: 'webgpu', store: null });
    play(post, governor, { cpuMs: 4, gpuMsAtRatio1: 2 }, 60_000);
    expect(post.history).toEqual([]);
  });

  describe('on devices the GPU is not holding back', () => {
    const governed = (store: KeyValueStore) => {
      saveQuality(store, benchRecord('high', 5));
      const post = fakePipeline(QUALITY_PROFILES.high);
      const onTierChange = vi.fn<(profile: QualityProfile) => void>();
      const governor = createQualityGovernor(post, {
        backend: 'webgpu',
        store,
        onTierChange,
        logger: quietLogger(),
      });
      return { post, governor, onTierChange };
    };

    it.each([
      ['CPU-bound at 25 fps', { cpuMs: 40, gpuMsAtRatio1: 2 }, { cpu: true }],
      ['CPU-bound, GPU timer clear', { cpuMs: 40, gpuMsAtRatio1: 2 }, { cpu: true, gpu: true }],
      ['capped at 30 Hz', { cpuMs: 3, gpuMsAtRatio1: 2, refreshHz: 30 }, { cpu: true }],
      ['capped at 30 Hz, no timings', { cpuMs: 3, gpuMsAtRatio1: 2, refreshHz: 30 }, {}],
      [
        'capped at 30 Hz, GPU timer clear',
        { cpuMs: 3, gpuMsAtRatio1: 2, refreshHz: 30 },
        { cpu: true, gpu: true },
      ],
    ] as const)('keeps the tier and writes nothing (%s)', (_name, load, sensors) => {
      const store = memoryStore();
      const { post, governor, onTierChange } = governed(store);
      play(post, governor, load, 5 * 60_000, sensors);
      expect(post.profile.tier).toBe('high');
      expect(post.history.some((entry) => entry.startsWith('tier:'))).toBe(false);
      expect(onTierChange).not.toHaveBeenCalled();
      expect(loadQuality(store, 'webgpu')).toEqual(benchRecord('high', 5));
      expect(post.dynamicScale).toBe(1);
    });
  });
});
