import type { Concierge, ConciergeHushReason, ConciergeLine } from '../../game/concierge/index.ts';

export type ConciergeBrainPort = Pick<Concierge, 'events' | 'current' | 'muted' | 'dismiss'>;

/** `enter` brings the card up from nothing; `swap` changes the words on a card already up. */
export type ConciergeShowMode = 'enter' | 'swap';

export interface ConciergeStageView {
  show(line: ConciergeLine, mode: ConciergeShowMode): void;
  hide(reason: ConciergeHushReason): void;
}

/**
 * Turns the brain's say and hush into the card's enter, swap and exit. A cut-in arrives as
 * hush('preempted') then say in the same tick, so that hush waits a microtask: a say that
 * follows swaps the words on the open card instead of flashing it shut and open again.
 */
export function wireConciergeStage(
  brain: ConciergeBrainPort,
  view: ConciergeStageView,
): () => void {
  let showing: ConciergeLine | null = null;
  let pendingHide: ConciergeHushReason | null = null;
  let disposed = false;

  const offSay = brain.events.on('concierge:say', (line) => {
    const mode: ConciergeShowMode = showing === null ? 'enter' : 'swap';
    pendingHide = null;
    showing = line;
    view.show(line, mode);
  });
  const offHush = brain.events.on('concierge:hush', ({ lineId, reason }) => {
    if (showing?.lineId !== lineId) return;
    if (reason !== 'preempted') {
      pendingHide = null;
      showing = null;
      view.hide(reason);
      return;
    }
    pendingHide = reason;
    queueMicrotask(() => {
      if (disposed || pendingHide === null) return;
      pendingHide = null;
      showing = null;
      view.hide(reason);
    });
  });
  const offMuted = brain.events.on('concierge:muted', ({ muted }) => {
    if (!muted || showing === null) return;
    pendingHide = null;
    showing = null;
    view.hide('muted');
  });

  if (!brain.muted && brain.current !== null) {
    showing = brain.current;
    view.show(brain.current, 'enter');
  }

  return () => {
    disposed = true;
    offSay();
    offHush();
    offMuted();
  };
}
