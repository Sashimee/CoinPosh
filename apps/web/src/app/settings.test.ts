import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultSettings,
  loadSettings,
  parseSettings,
  sameSettings,
  saveSettings,
  SETTINGS_STORAGE_KEY,
  type Settings,
  type SettingsStorage,
} from './settings.ts';

function memoryStorage(): SettingsStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

const defaults = defaultSettings('en');
const custom: Settings = {
  volumes: { master: 0.5, music: 0.3, sfx: 1 },
  mono: true,
  haptics: false,
  motion: 'reduced',
  quality: 'low',
  language: 'de',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('settings persistence', () => {
  it('round-trips through storage', () => {
    const storage = memoryStorage();
    expect(saveSettings(storage, custom)).toBe(true);
    expect(storage.data.has(SETTINGS_STORAGE_KEY)).toBe(true);
    expect(loadSettings(storage, defaults)).toEqual(custom);
  });

  it('uses defaults when nothing is saved or there is no storage', () => {
    expect(loadSettings(memoryStorage(), defaults)).toBe(defaults);
    expect(loadSettings(null, defaults)).toBe(defaults);
    expect(saveSettings(null, custom)).toBe(false);
  });

  it('keeps valid fields and reports the invalid ones', () => {
    const { settings, rejected } = parseSettings(
      {
        volumes: { master: 2, music: 0.25, sfx: 'loud' },
        mono: 'yes',
        haptics: false,
        motion: 'wild',
        quality: 'high',
        language: 'es',
      },
      defaults,
    );
    expect(settings).toEqual({
      ...defaults,
      volumes: { ...defaults.volumes, music: 0.25 },
      haptics: false,
      quality: 'high',
    });
    expect(rejected).toEqual(['volumes.master', 'volumes.sfx', 'mono', 'motion', 'language']);
  });

  it('rejects a non-object root and non-object volumes', () => {
    expect(parseSettings([], defaults)).toEqual({ settings: defaults, rejected: ['root'] });
    expect(parseSettings(undefined, defaults).rejected).toEqual([]);
    expect(parseSettings({ volumes: 1 }, defaults).rejected).toEqual(['volumes']);
  });

  it('warns and falls back on corrupt JSON or a throwing storage', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const corrupt = memoryStorage();
    corrupt.data.set(SETTINGS_STORAGE_KEY, '{nope');
    expect(loadSettings(corrupt, defaults)).toBe(defaults);

    const blocked: SettingsStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(loadSettings(blocked, defaults)).toBe(defaults);
    expect(saveSettings(blocked, custom)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('compares settings by value', () => {
    expect(sameSettings(custom, { ...custom, volumes: { ...custom.volumes } })).toBe(true);
    expect(sameSettings(custom, { ...custom, volumes: { ...custom.volumes, sfx: 0.9 } })).toBe(
      false,
    );
    expect(sameSettings(custom, { ...custom, language: 'fr' })).toBe(false);
  });
});
