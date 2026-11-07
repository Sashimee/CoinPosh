import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSettingsSaver,
  defaultSettings,
  resolveUiQuality,
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

describe('createSettingsSaver', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes once, with the latest settings, after a burst goes quiet', () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const setItem = vi.spyOn(storage, 'setItem');
    const saver = createSettingsSaver(storage, 250);
    for (let i = 1; i <= 30; i += 1) {
      saver.schedule({ ...custom, volumes: { ...custom.volumes, music: i / 30 } });
      vi.advanceTimersByTime(16);
    }
    expect(setItem).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(loadSettings(storage, defaults).volumes.music).toBe(1);
  });

  it('flushes a pending save immediately and only once', () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const setItem = vi.spyOn(storage, 'setItem');
    const saver = createSettingsSaver(storage, 250);
    saver.flush();
    expect(setItem).not.toHaveBeenCalled();
    saver.schedule(custom);
    saver.flush();
    expect(loadSettings(storage, defaults)).toEqual(custom);
    vi.advanceTimersByTime(1000);
    saver.flush();
    expect(setItem).toHaveBeenCalledTimes(1);
  });
});

describe('resolveUiQuality', () => {
  it('honours an explicit choice whatever the device', () => {
    expect(resolveUiQuality('low', { cores: 16, memoryGb: 8 })).toBe('low');
    expect(resolveUiQuality('high', { cores: 2, memoryGb: 1 })).toBe('high');
  });

  it('drops to low on auto for low-tier devices', () => {
    expect(resolveUiQuality('auto', { cores: 4, memoryGb: 8 })).toBe('low');
    expect(resolveUiQuality('auto', { cores: 8, memoryGb: 4 })).toBe('low');
    expect(resolveUiQuality('auto', { cores: 8, memoryGb: 8 })).toBe('high');
  });

  it('stays high on auto when the browser reports nothing', () => {
    expect(resolveUiQuality('auto', {})).toBe('high');
    expect(resolveUiQuality('auto', { cores: 6 })).toBe('high');
  });
});
