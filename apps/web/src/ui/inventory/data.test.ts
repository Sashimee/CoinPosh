import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { ApiClient } from '../../net/client.ts';
import { seenLevelsStore, stateInventoryData, type StateSource } from './data.ts';

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
    items,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('seenLevelsStore', () => {
  it('has nothing on a first visit, then round-trips what it wrote', () => {
    const storage = memoryStorage();
    const store = seenLevelsStore(storage);
    expect(store.read()).toBeNull();
    store.write({ 'charm:captainsBellCharm': 3 });
    expect(seenLevelsStore(storage).read()).toEqual({ 'charm:captainsBellCharm': 3 });
  });

  it('drops entries that are not positive integer levels', () => {
    const storage = memoryStorage({
      'coinposh.inventory.seenLevels': JSON.stringify({ a: 2, b: 0, c: 'x', d: 1.5 }),
    });
    expect(seenLevelsStore(storage).read()).toEqual({ a: 2 });
  });

  it('warns and starts fresh when the stored value is corrupt', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const storage = memoryStorage({ 'coinposh.inventory.seenLevels': '{not json' });
    expect(seenLevelsStore(storage).read()).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('keeps levels for the session when storage refuses writes', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = seenLevelsStore({
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    });
    store.write({ a: 2 });
    expect(warn).toHaveBeenCalledOnce();
    expect(store.read()).toEqual({ a: 2 });
  });

  it('works without any storage', () => {
    const store = seenLevelsStore(null);
    store.write({ a: 4 });
    expect(store.read()).toEqual({ a: 4 });
  });
});

describe('stateInventoryData', () => {
  it('reads the inventory out of the state response and has no fuse route', async () => {
    const call = vi.fn((name: 'state') => {
      expect(name).toBe('state');
      return Promise.resolve({
        serverTime: 0,
        venue: { loadout: [] },
        inventory: { charms: [], safes: [], scratchCards: [] },
      });
    });
    const data = stateInventoryData({ call });
    expect(data.levelUp).toBeUndefined();
    await expect(data.load()).resolves.toEqual({ entries: [], duplicatesPerLevel: null });
    expect(call).toHaveBeenCalledOnce();
  });

  it('accepts the real API client', () => {
    expectTypeOf<ApiClient>().toExtend<StateSource>();
  });

  it('passes a failed state fetch through to the panel', async () => {
    const data = stateInventoryData({ call: () => Promise.reject(new Error('offline')) });
    await expect(data.load()).rejects.toThrow('offline');
  });
});
