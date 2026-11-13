import type { AnnouncementHold } from '../../ui/components/announcementHold.ts';
import type { SystemsCore } from './core.ts';
import type { SystemsOverlay } from './overlay.ts';

export interface CinematicPauseTargets {
  readonly core: Pick<SystemsCore, 'setSuspended'>;
  /** Spends the touch in progress on the current input surface, cancelling its pour. */
  readonly interrupt: () => void;
  readonly overlay: Pick<SystemsOverlay, 'setSuspended'>;
}

/**
 * Pauses play while the HUD's announcement hold is up. A crate cinematic holds it from the
 * crate's fall until its reveal has left the screen, so a held pour stops the moment the unbox
 * starts instead of spending coins behind it, the reticle and gauge step aside for the card, and
 * a finger still down when it ends must lift and press again to play. Returns its unsubscribe.
 */
export function pauseDuringCinematics(
  hold: Pick<AnnouncementHold, 'held' | 'onChange'>,
  targets: CinematicPauseTargets,
): () => void {
  const apply = (held: boolean): void => {
    targets.interrupt();
    targets.core.setSuspended(held);
    targets.overlay.setSuspended(held);
  };
  if (hold.held) apply(true);
  return hold.onChange(apply);
}
