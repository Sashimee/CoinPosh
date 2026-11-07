import type { ImpactEvent } from '../../audio/index.ts';
import type { UiAudio } from '../../app/index.ts';
import type { Bus } from '../../app/bus.ts';
import type { I18n } from '../../i18n/index.ts';
import type { UpgradeEvents } from './events.ts';
import { rejectionKey } from './i18n.ts';

export interface ChimeNote {
  readonly delayMs: number;
  readonly sound: ImpactEvent;
}

/**
 * Plays after the server confirms, on top of the panel's press cue: a rising coin
 * arpeggio that lands on brass, so a confirmed level sounds different from a tap.
 */
export const PURCHASE_CHIME: readonly ChimeNote[] = [
  { delayMs: 0, sound: { material: 'coin', velocity: 0.9, pan: -0.2 } },
  { delayMs: 70, sound: { material: 'coin', velocity: 1.3, pan: 0.1 } },
  { delayMs: 150, sound: { material: 'metal', velocity: 0.85, pan: 0.25 } },
];

export interface UpgradeFeedbackTargets {
  readonly events: Bus<UpgradeEvents>;
  readonly i18n: I18n;
  /** Read on every event, so audio attached after the first gesture is picked up. */
  readonly audio: () => Pick<UiAudio, 'playImpact'> | null;
  readonly notify: (message: string) => void;
  /** Schedules `run` after `ms` and returns a function that cancels it if it has not run yet. */
  readonly delay?: (run: () => void, ms: number) => () => void;
}

export function bindUpgradeFeedback(targets: UpgradeFeedbackTargets): () => void {
  const delay =
    targets.delay ??
    ((run: () => void, ms: number) => {
      const handle = setTimeout(run, ms);
      return () => {
        clearTimeout(handle);
      };
    });
  /** Notes not yet played; the cancel is null only while `delay` is scheduling it. */
  const pending = new Map<number, (() => void) | null>();
  let nextNote = 0;
  const offPurchased = targets.events.on('upgrade:purchased', () => {
    for (const note of PURCHASE_CHIME) {
      const id = nextNote++;
      pending.set(id, null);
      const cancel = delay(() => {
        pending.delete(id);
        targets.audio()?.playImpact(note.sound);
      }, note.delayMs);
      if (pending.has(id)) pending.set(id, cancel);
    }
  });
  const offRejected = targets.events.on('upgrade:rejected', ({ reason }) => {
    targets.notify(targets.i18n.t(rejectionKey(reason)));
  });
  return () => {
    offPurchased();
    offRejected();
    for (const cancel of pending.values()) cancel?.();
    pending.clear();
  };
}
