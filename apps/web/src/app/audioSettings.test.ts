import { describe, expect, it } from 'vitest';
import type { MixerBus } from '../audio/index.ts';
import {
  applyAudioSettings,
  bindAudioSettings,
  type AudioSettingsTarget,
} from './audioSettings.ts';
import { defaultSettings, loadSettings, saveSettings, type SettingsStorage } from './settings.ts';
import { createStore } from './store.ts';

function fakeEngine() {
  const volumes: Record<MixerBus, number> = { master: 1, music: 1, sfx: 1 };
  const calls: string[] = [];
  const engine: AudioSettingsTarget & { mono: boolean } = {
    mono: false,
    getVolume: (bus) => volumes[bus],
    setVolume: (bus, value) => {
      calls.push(`${bus}=${value}`);
      volumes[bus] = value;
    },
    setMono(on) {
      calls.push(`mono=${on}`);
      engine.mono = on;
    },
  };
  return { engine, volumes, calls };
}

describe('audio settings', () => {
  it('only sets buses whose volume differs', () => {
    const { engine, calls } = fakeEngine();
    const settings = { ...defaultSettings('en'), volumes: { master: 1, music: 0.4, sfx: 1 } };
    applyAudioSettings(engine, settings);
    expect(calls).toEqual(['music=0.4', 'mono=false']);
  });

  it('applies slider changes as they happen and skips unrelated ones', () => {
    const { engine, volumes, calls } = fakeEngine();
    const store = createStore({ settings: defaultSettings('en') });
    const off = bindAudioSettings(engine, store);
    calls.length = 0;

    store.setState((s) => ({ settings: { ...s.settings, language: 'fr' } }));
    expect(calls).toEqual([]);

    store.setState((s) => ({
      settings: { ...s.settings, volumes: { ...s.settings.volumes, sfx: 0.2 }, mono: true },
    }));
    expect(volumes.sfx).toBe(0.2);
    expect(engine.mono).toBe(true);

    off();
    store.setState((s) => ({ settings: { ...s.settings, mono: false } }));
    expect(engine.mono).toBe(true);
  });

  it('restores the mixer after a reload', () => {
    const data = new Map<string, string>();
    const storage: SettingsStorage = {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => {
        data.set(key, value);
      },
    };
    const before = createStore({ settings: defaultSettings('en') });
    before.subscribe((state) => saveSettings(storage, state.settings));
    before.setState((s) => ({
      settings: { ...s.settings, volumes: { master: 0.7, music: 0.3, sfx: 0.9 }, mono: true },
    }));

    const { engine, volumes } = fakeEngine();
    const after = createStore({ settings: loadSettings(storage, defaultSettings('en')) });
    bindAudioSettings(engine, after);
    expect(volumes).toEqual({ master: 0.7, music: 0.3, sfx: 0.9 });
    expect(engine.mono).toBe(true);
  });
});
