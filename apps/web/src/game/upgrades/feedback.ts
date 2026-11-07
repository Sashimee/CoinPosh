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
  readonly delay?: (run: () => void, ms: number) => void;
}

export function bindUpgradeFeedback(targets: UpgradeFeedbackTargets): () => void {
  const delay =
    targets.delay ??
    ((run: () => void, ms: number) => {
      setTimeout(run, ms);
    });
  const offPurchased = targets.events.on('upgrade:purchased', () => {
    for (const note of PURCHASE_CHIME) {
      delay(() => targets.audio()?.playImpact(note.sound), note.delayMs);
    }
  });
  const offRejected = targets.events.on('upgrade:rejected', ({ reason }) => {
    targets.notify(targets.i18n.t(rejectionKey(reason)));
  });
  return () => {
    offPurchased();
    offRejected();
  };
}
