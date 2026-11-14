import { album } from '@coinposh/economy';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { ApiClient } from '../../net/client.ts';
import { apiAlbumData, seenCompletionsStore, type AlbumClient } from './data.ts';
import { albumResponse } from './fixture.ts';

const SEEN_KEY = 'coinposh.album.seenCompleted';

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

describe('apiAlbumData', () => {
  it('fits the real API client', () => {
    expectTypeOf<ApiClient>().toExtend<AlbumClient>();
  });

  it('asks the album endpoint and builds the view', async () => {
    const call = vi.fn((name: 'album') => {
      expect(name).toBe('album');
      return Promise.resolve<unknown>(albumResponse((_, set) => (set === album[0].id ? 2 : 0)));
    });
    const view = await apiAlbumData({ call }).load();
    expect(call).toHaveBeenCalledOnce();
    expect(view.completedSets).toBe(1);
    expect(view.sets[0]?.slots.every((slot) => slot.count === 2)).toBe(true);
  });

  it.each([
    ['nothing', undefined],
    ['sets missing', {}],
    [
      'a negative count',
      {
        sets: [
          {
            id: album[0].id,
            entries: [{ id: 'x', kind: 'charm', owned: true, count: -1 }],
            completed: false,
          },
        ],
      },
    ],
    [
      'an unknown kind',
      {
        sets: [
          {
            id: album[0].id,
            entries: [{ id: 'x', kind: 'gem', owned: true, count: 1 }],
            completed: false,
          },
        ],
      },
    ],
  ])('rejects a malformed album (%s)', async (_, body) => {
    await expect(apiAlbumData({ call: () => Promise.resolve(body) }).load()).rejects.toThrow();
  });

  it('passes a failed request on', async () => {
    const failure = new Error('offline');
    await expect(apiAlbumData({ call: () => Promise.reject(failure) }).load()).rejects.toBe(
      failure,
    );
  });
});

describe('seenCompletionsStore', () => {
  it('has nothing on a first visit, then round-trips what it wrote', () => {
    const storage = memoryStorage();
    expect(seenCompletionsStore(storage).read()).toBeNull();
    seenCompletionsStore(storage).write(['deckEssentials']);
    expect(seenCompletionsStore(storage).read()).toEqual(['deckEssentials']);
  });

  it('remembers an empty list as a visit, not a first visit', () => {
    const storage = memoryStorage();
    seenCompletionsStore(storage).write([]);
    expect(seenCompletionsStore(storage).read()).toEqual([]);
  });

  it('drops ids that are not non-empty strings', () => {
    const storage = memoryStorage({ [SEEN_KEY]: JSON.stringify(['a', '', 3, null, 'b']) });
    expect(seenCompletionsStore(storage).read()).toEqual(['a', 'b']);
  });

  it('treats a stored value that is not a list as no record', () => {
    const storage = memoryStorage({ [SEEN_KEY]: JSON.stringify({ a: 1 }) });
    expect(seenCompletionsStore(storage).read()).toBeNull();
  });

  it('warns and starts fresh when the stored value is corrupt', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const storage = memoryStorage({ [SEEN_KEY]: '[not json' });
    expect(seenCompletionsStore(storage).read()).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('keeps completions for the session when storage refuses writes', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = seenCompletionsStore({
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    });
    store.write(['sunsetGala']);
    expect(warn).toHaveBeenCalledOnce();
    expect(store.read()).toEqual(['sunsetGala']);
  });

  it('works without any storage', () => {
    const store = seenCompletionsStore(null);
    expect(store.read()).toBeNull();
    store.write(['captainsTable']);
    expect(store.read()).toEqual(['captainsTable']);
  });
});
