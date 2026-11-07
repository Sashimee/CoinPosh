import { describe, expect, it, vi } from 'vitest';
import {
  browserStore,
  loadQuality,
  QUALITY_STORAGE_KEY,
  saveQuality,
  type KeyValueStore,
  type StoredQuality,
} from './storage.ts';
import type { RenderBackend } from '../../backend.ts';
import type { QualityTier } from './tiers.ts';

function memoryStore(
  initial: Record<string, string> = {},
): KeyValueStore & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

function throwingStore(): KeyValueStore {
  return {
    getItem: () => {
      throw new DOMException('blocked', 'SecurityError');
    },
    setItem: () => {
      throw new DOMException('full', 'QuotaExceededError');
    },
  };
}

function bench(backend: RenderBackend, benchTier: QualityTier, benchmarkMs: number): StoredQuality {
  return { backend, benchTier, benchmarkMs, downgrade: null };
}

const logger = () => ({ warn: vi.fn<(message: string, error?: unknown) => void>() });

describe('quality storage', () => {
  it('round-trips a tier for the same backend', () => {
    const store = memoryStore();
    const log = logger();
    const record = {
      backend: 'webgpu',
      benchTier: 'medium',
      benchmarkMs: 9.5,
      downgrade: null,
    } as const;
    expect(saveQuality(store, record, log)).toBe(true);
    expect(loadQuality(store, 'webgpu', log)).toEqual(record);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('ignores a tier measured on the other backend so it gets re-benchmarked', () => {
    const store = memoryStore();
    saveQuality(store, bench('webgpu', 'high', 4), logger());
    expect(loadQuality(store, 'webgl2', logger())).toBeNull();
  });

  it('returns null without warning on first boot', () => {
    const log = logger();
    expect(loadQuality(memoryStore(), 'webgl2', log)).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['not json', '{tier:'],
    ['wrong shape', '[]'],
    ['unknown tier', JSON.stringify({ ...bench('webgpu', 'low', 1), benchTier: 'ultra' })],
    ['unknown backend', JSON.stringify({ ...bench('webgpu', 'low', 1), backend: 'metal' })],
    ['non-finite benchmark', JSON.stringify({ ...bench('webgpu', 'low', 1), benchmarkMs: 'fast' })],
    ['missing benchmark', JSON.stringify({ ...bench('webgpu', 'low', 1), benchmarkMs: null })],
    [
      'unknown downgrade tier',
      JSON.stringify({ ...bench('webgpu', 'high', 1), downgrade: { tier: 'ultra', bootsLeft: 2 } }),
    ],
    [
      'exhausted downgrade',
      JSON.stringify({ ...bench('webgpu', 'high', 1), downgrade: { tier: 'low', bootsLeft: 0 } }),
    ],
    [
      'fractional downgrade boots',
      JSON.stringify({ ...bench('webgpu', 'high', 1), downgrade: { tier: 'low', bootsLeft: 1.5 } }),
    ],
  ])('warns and re-benchmarks on a malformed record (%s)', (_label, raw) => {
    const log = logger();
    expect(loadQuality(memoryStore({ [QUALITY_STORAGE_KEY]: raw }), 'webgpu', log)).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('malformed'));
  });

  it('keeps a runtime downgrade next to the benchmark tier', () => {
    const store = memoryStore();
    const record = {
      ...bench('webgl2', 'high', 5),
      downgrade: { tier: 'low', bootsLeft: 2 },
    } as const;
    saveQuality(store, record, logger());
    expect(loadQuality(store, 'webgl2', logger())).toEqual(record);
  });

  it('ignores a v1 record without warning so the device is re-benchmarked', () => {
    const log = logger();
    const legacy = JSON.stringify({ tier: 'low', backend: 'webgpu', benchmarkMs: null });
    expect(loadQuality(memoryStore({ 'coinposh.quality.v1': legacy }), 'webgpu', log)).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('survives storage that throws on read and write', () => {
    const log = logger();
    expect(loadQuality(throwingStore(), 'webgpu', log)).toBeNull();
    expect(saveQuality(throwingStore(), bench('webgpu', 'low', 1), log)).toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('treats a missing store as "nothing saved"', () => {
    expect(loadQuality(null, 'webgpu')).toBeNull();
    expect(saveQuality(null, bench('webgpu', 'low', 1))).toBe(false);
  });

  it('returns null with a warning when localStorage access itself throws', () => {
    const log = logger();
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    try {
      expect(browserStore(log)).toBeNull();
      expect(log.warn).toHaveBeenCalledOnce();
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });
});
