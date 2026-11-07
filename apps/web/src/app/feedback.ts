import type { AudioEngine, ImpactEvent } from '../audio/index.ts';
import type { Bus } from './bus.ts';
import type { Settings } from './settings.ts';
import type { FeedbackKind, UiEvents } from './state.ts';
import type { Store } from './store.ts';

export type HapticPattern = number | readonly number[];

export interface FeedbackCue {
  readonly sound: ImpactEvent;
  readonly haptic: HapticPattern;
}

/** Soft wooden clacks for plain taps, brass for panels, a coin ring for purchases. */
export const FEEDBACK_CUES: Readonly<Record<FeedbackKind, FeedbackCue>> = {
  tap: { sound: { material: 'wood', velocity: 0.55 }, haptic: 8 },
  open: { sound: { material: 'metal', velocity: 0.7 }, haptic: 12 },
  close: { sound: { material: 'wood', velocity: 0.4 }, haptic: 6 },
  confirm: { sound: { material: 'coin', velocity: 1.6 }, haptic: [14, 40, 22] },
  deny: { sound: { material: 'wood', velocity: 0.22 }, haptic: [10, 30, 10] },
  tick: { sound: { material: 'coin', velocity: 0.14 }, haptic: 4 },
  toggle: { sound: { material: 'metal', velocity: 0.45 }, haptic: 10 },
};

export interface FeedbackTargets {
  readonly audio: Pick<AudioEngine, 'playImpact'> | null;
  readonly vibrate: ((pattern: HapticPattern) => void) | null;
}

export function browserVibrate(): FeedbackTargets['vibrate'] {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return null;
  return (pattern) => {
    navigator.vibrate(typeof pattern === 'number' ? pattern : [...pattern]);
  };
}

export function bindFeedback(
  bus: Bus<UiEvents>,
  store: Store<{ readonly settings: Settings }>,
  targets: FeedbackTargets,
): () => void {
  return bus.on('ui:feedback', ({ kind }) => {
    const cue = FEEDBACK_CUES[kind];
    targets.audio?.playImpact(cue.sound);
    if (store.getState().settings.haptics) targets.vibrate?.(cue.haptic);
  });
}
