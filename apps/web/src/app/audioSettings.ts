import type { AudioEngine } from '../audio/index.ts';
import { MIXER_BUSES, type Settings } from './settings.ts';
import { watch, type Store } from './store.ts';

export type AudioSettingsTarget = Pick<AudioEngine, 'setVolume' | 'getVolume' | 'setMono'>;

export function applyAudioSettings(engine: AudioSettingsTarget, settings: Settings): void {
  for (const bus of MIXER_BUSES) {
    const value = settings.volumes[bus];
    if (engine.getVolume(bus) !== value) engine.setVolume(bus, value);
  }
  engine.setMono(settings.mono);
}

/** Pushes the saved mixer settings into the engine now and on every later change. */
export function bindAudioSettings(
  engine: AudioSettingsTarget,
  store: Store<{ readonly settings: Settings }>,
): () => void {
  return watch(
    store,
    (state) => state.settings,
    (settings, previous) => {
      if (
        previous?.mono === settings.mono &&
        MIXER_BUSES.every((bus) => previous.volumes[bus] === settings.volumes[bus])
      ) {
        return;
      }
      applyAudioSettings(engine, settings);
    },
  );
}
