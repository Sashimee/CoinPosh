import { describe, expect, it, vi } from 'vitest';
import {
  browserStore,
  loadQuality,
  QUALITY_STORAGE_KEY,
  saveQuality,
  type KeyValueStore,
} from './storage.ts';

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

const logger = () => ({ warn: vi.fn<(message: string, error?: unknown) => void>() });

describe('quality storage', () => {
  it('round-trips a tier for the same backend', () => {
    const store = memoryStore();
    const log = logger();
    expect(saveQuality(store, { tier: 'medium', backend: 'webgpu', benchmarkMs: 9.5 }, log)).toBe(
      true,
    );
    expect(loadQuality(store, 'webgpu', log)).toEqual({
      tier: 'medium',
      backend: 'webgpu',
      benchmarkMs: 9.5,
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('ignores a tier measured on the other backend so it gets re-benchmarked', () => {
    const store = memoryStore();
    saveQuality(store, { tier: 'high', backend: 'webgpu', benchmarkMs: 4 }, logger());
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
    ['unknown tier', JSON.stringify({ tier: 'ultra', backend: 'webgpu', benchmarkMs: 1 })],
    ['unknown backend', JSON.stringify({ tier: 'low', backend: 'metal', benchmarkMs: 1 })],
    [
      'non-finite benchmark',
      JSON.stringify({ tier: 'low', backend: 'webgpu', benchmarkMs: 'fast' }),
    ],
  ])('warns and re-benchmarks on a malformed record (%s)', (_label, raw) => {
    const log = logger();
    expect(loadQuality(memoryStore({ [QUALITY_STORAGE_KEY]: raw }), 'webgpu', log)).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('malformed'));
  });

  it('accepts a downgrade record without a benchmark time', () => {
    const store = memoryStore();
    saveQuality(store, { tier: 'low', backend: 'webgl2', benchmarkMs: null }, logger());
    expect(loadQuality(store, 'webgl2', logger())?.tier).toBe('low');
  });

  it('survives storage that throws on read and write', () => {
    const log = logger();
    expect(loadQuality(throwingStore(), 'webgpu', log)).toBeNull();
    expect(
      saveQuality(throwingStore(), { tier: 'low', backend: 'webgpu', benchmarkMs: 1 }, log),
    ).toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('treats a missing store as "nothing saved"', () => {
    expect(loadQuality(null, 'webgpu')).toBeNull();
    expect(saveQuality(null, { tier: 'low', backend: 'webgpu', benchmarkMs: 1 })).toBe(false);
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
