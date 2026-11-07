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
import { QUALITY_PROFILES, type QualityProfile, type QualityTier } from './tiers.ts';

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
    const benchmark = benchmarkReturning({ tier: 'medium', msPerFrame: 9, samples: [9] });
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
    const benchmark = benchmarkReturning({ tier: 'low', msPerFrame: 20, samples: [20] });
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
    const benchmark = benchmarkReturning({ tier: 'low', msPerFrame: 20, samples: [20] });
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
    const benchmark = benchmarkReturning({ tier: 'low', msPerFrame: 20, samples: [20] });
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
    const benchmark = benchmarkReturning({ tier: 'high', msPerFrame: 4, samples: [4] });
    const resolved = await resolveQuality({
      backend: 'webgpu',
      store: null,
      benchmark,
      logger: quietLogger(),
    });
    expect(resolved.profile.tier).toBe('high');
  });
});

interface FakePipeline extends ScalablePipeline {
  readonly history: string[];
}

/** Mirrors PostPipeline: the scene ratio is capped at the tier's maxPixelRatio over the DPR. */
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
    get dynamicScale() {
      return state.dynamicScale;
    },
    get sceneScale() {
      return Math.min(1, state.profile.maxPixelRatio / devicePixelRatio) * state.dynamicScale;
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

/** Feeds 20 fps frames and records the scene scale right before and after each tier change. */
function overload(post: FakePipeline, governor: QualityGovernor, frames: number) {
  const steps: { before: number; after: number }[] = [];
  let now = 0;
  governor.frame(now);
  for (let i = 0; i < frames; i++) {
    const tier = post.profile.tier;
    const before = post.sceneScale;
    now += 50;
    governor.frame(now);
    if (post.profile.tier !== tier) steps.push({ before, after: post.sceneScale });
  }
  return steps;
}

describe('createQualityGovernor', () => {
  it('shrinks resolution first, then steps the tier down and saves it as a downgrade', () => {
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

    let now = 1000;
    governor.frame(now);
    for (let i = 0; i < 400 && post.profile.tier === 'high'; i++) {
      now += 50;
      governor.frame(now);
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
  });

  it('renews the downgrade when a downgraded boot has to step down again', () => {
    const store = memoryStore();
    saveQuality(store, { ...benchRecord('high', 5), downgrade: { tier: 'medium', bootsLeft: 1 } });
    const post = fakePipeline(QUALITY_PROFILES.medium);
    const governor = createQualityGovernor(post, {
      backend: 'webgpu',
      store,
      logger: quietLogger(),
    });
    overload(post, governor, 2000);
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
    overload(post, governor, 4000);
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
      const steps = overload(post, governor, 4000);
      expect(post.profile.tier).toBe('low');
      expect(steps).toHaveLength(2);
      for (const { before, after } of steps) {
        expect(after).toBeLessThanOrEqual(before + 1e-9);
        expect(after).toBeCloseTo(before, 6);
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
    let now = 0;
    for (let i = 0; i < 2000; i++) {
      now += 80;
      governor.frame(now);
    }
    expect(post.profile.tier).toBe('low');
    expect(governor.scale).toBe(QUALITY_PROFILES.low.minResolutionScale);
  });

  it('leaves a healthy 60 fps game untouched', () => {
    const post = fakePipeline(QUALITY_PROFILES.high);
    const governor = createQualityGovernor(post, { backend: 'webgpu', store: null });
    let now = 0;
    for (let i = 0; i < 3600; i++) {
      now += 1000 / 60;
      governor.frame(now);
    }
    expect(post.history).toEqual([]);
  });
});
