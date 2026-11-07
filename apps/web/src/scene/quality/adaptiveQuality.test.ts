import { describe, expect, it, vi } from 'vitest';
import { createQualityGovernor, resolveQuality, type ScalablePipeline } from './adaptiveQuality.ts';
import type { BenchmarkResult } from './benchmark.ts';
import { loadQuality, saveQuality, type KeyValueStore } from './storage.ts';
import { QUALITY_PROFILES, type QualityProfile } from './tiers.ts';

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
    saveQuality(store, { tier: 'high', backend: 'webgpu', benchmarkMs: 3 });
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

function fakePipeline(profile: QualityProfile): ScalablePipeline & { history: string[] } {
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

describe('createQualityGovernor', () => {
  it('shrinks resolution first, then steps the tier down and saves it', () => {
    const store = memoryStore();
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
      tier: 'medium',
      backend: 'webgpu',
      benchmarkMs: null,
    });
  });

  it('carries the pixel ratio across a tier change instead of snapping to full resolution', () => {
    const post = fakePipeline(QUALITY_PROFILES.high);
    const governor = createQualityGovernor(post, {
      backend: 'webgpu',
      store: null,
      logger: quietLogger(),
    });
    let now = 0;
    governor.frame(now);
    while (post.profile.tier === 'high') {
      now += 50;
      governor.frame(now);
    }
    const high = QUALITY_PROFILES.high;
    const medium = QUALITY_PROFILES.medium;
    expect(governor.scale * medium.maxPixelRatio).toBeCloseTo(
      high.minResolutionScale * high.maxPixelRatio,
      5,
    );
  });

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
