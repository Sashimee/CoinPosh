import { AlbumResponseSchema } from '@coinposh/shared';
import type { SettingsStorage } from '../../app/settings.ts';
import { albumView, type AlbumData } from './model.ts';

export interface AlbumClient {
  call(name: 'album'): Promise<unknown>;
}

/**
 * The album over `GET /v1/album` (Demo Mode's mock answers it too). The response is parsed
 * here as well as in the client, so a malformed album fails loudly at this boundary.
 */
export function apiAlbumData(client: AlbumClient): AlbumData {
  return {
    async load() {
      return albumView(AlbumResponseSchema.parse(await client.call('album')));
    },
  };
}

const SEEN_KEY = 'coinposh.album.seenCompleted';

/** The completed sets the album last showed, so a completion is celebrated exactly once. */
export interface SeenCompletions {
  read(): readonly string[] | null;
  write(ids: readonly string[]): void;
}

function parseSeen(raw: string): string[] | null {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return null;
  return parsed.filter((id): id is string => typeof id === 'string' && id !== '');
}

/** Remembers in `storage` when it works, and for this session only when it does not. */
export function seenCompletionsStore(storage: SettingsStorage | null): SeenCompletions {
  let memory: readonly string[] | null = null;
  return {
    read() {
      if (!storage) return memory;
      try {
        const raw = storage.getItem(SEEN_KEY);
        return raw === null ? memory : (parseSeen(raw) ?? memory);
      } catch (error) {
        console.warn('[CoinPosh] stored album completions are unreadable; starting fresh', error);
        return memory;
      }
    },
    write(ids) {
      memory = [...ids];
      if (!storage) return;
      try {
        storage.setItem(SEEN_KEY, JSON.stringify(ids));
      } catch (error) {
        console.warn('[CoinPosh] could not store album completions; they last this session', error);
      }
    },
  };
}
