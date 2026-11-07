import { describe, expect, it, vi } from 'vitest';
import { createBus } from './bus.ts';
import { bindFeedback, FEEDBACK_CUES } from './feedback.ts';
import { defaultSettings } from './settings.ts';
import type { UiEvents } from './state.ts';
import { createStore } from './store.ts';

function setup(haptics: boolean) {
  const bus = createBus<UiEvents>();
  const store = createStore({ settings: { ...defaultSettings('en'), haptics } });
  const playImpact = vi.fn();
  const vibrate = vi.fn();
  bindFeedback(bus, store, { audio: { playImpact }, vibrate });
  return { bus, store, playImpact, vibrate };
}

describe('press feedback', () => {
  it('plays the sound and haptic for each kind', () => {
    const { bus, playImpact, vibrate } = setup(true);
    bus.emit('ui:feedback', { kind: 'confirm' });
    expect(playImpact).toHaveBeenCalledWith(FEEDBACK_CUES.confirm.sound);
    expect(vibrate).toHaveBeenCalledWith(FEEDBACK_CUES.confirm.haptic);
  });

  it('keeps the sound but skips vibration when haptics are off', () => {
    const { bus, store, playImpact, vibrate } = setup(false);
    bus.emit('ui:feedback', { kind: 'tap' });
    expect(playImpact).toHaveBeenCalledOnce();
    expect(vibrate).not.toHaveBeenCalled();

    store.setState((s) => ({ settings: { ...s.settings, haptics: true } }));
    bus.emit('ui:feedback', { kind: 'tap' });
    expect(vibrate).toHaveBeenCalledOnce();
  });

  it('works before audio is unlocked', () => {
    const bus = createBus<UiEvents>();
    const vibrate = vi.fn();
    bindFeedback(bus, createStore({ settings: defaultSettings('en') }), { audio: null, vibrate });
    bus.emit('ui:feedback', { kind: 'deny' });
    expect(vibrate).toHaveBeenCalledWith(FEEDBACK_CUES.deny.haptic);
  });
});
