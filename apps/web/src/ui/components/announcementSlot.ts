import type { AnnouncementHold, AnnouncementQuiet } from './announcementHold.ts';

/**
 * What can claim the HUD's one announcement slot, highest priority first. `crate-on-table` is
 * not drawn: it is a crate the player is still pushing after its hint has faded, which keeps the
 * moment from the upgrade nudge but not from a rank stamp.
 */
export const CALLOUT_PRIORITY = [
  'crate-hint',
  'rank-stamp',
  'crate-on-table',
  'upgrade-nudge',
] as const;

export type Callout = (typeof CALLOUT_PRIORITY)[number];

/**
 * The single place HUD callouts take turns in. A crate cinematic's announcement hold outranks
 * every callout; below it a callout keeps quiet while any callout ranked above it is claimed.
 * Claims nest per callout, like holds.
 */
export interface AnnouncementSlot {
  /** Claims the slot for `callout`; the returned release ends it, and only its first call counts. */
  claim(callout: Callout): () => void;
  /** True while the cinematic hold or a higher-ranked callout has the slot. */
  outranked(callout: Callout): boolean;
  /** `outranked(callout)` as a hold to gate on, hearing only its own changes. */
  quietFor(callout: Callout): AnnouncementQuiet;
}

export function createAnnouncementSlot(hold: AnnouncementQuiet): AnnouncementSlot {
  const claims = new Map<Callout, number>(CALLOUT_PRIORITY.map((callout) => [callout, 0]));
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };
  hold.onChange(notify);

  const outranked = (callout: Callout): boolean => {
    if (hold.held) return true;
    for (const above of CALLOUT_PRIORITY) {
      if (above === callout) return false;
      if ((claims.get(above) ?? 0) > 0) return true;
    }
    return false;
  };

  return {
    claim(callout) {
      claims.set(callout, (claims.get(callout) ?? 0) + 1);
      notify();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        claims.set(callout, (claims.get(callout) ?? 1) - 1);
        notify();
      };
    },
    outranked,
    quietFor(callout) {
      return {
        get held() {
          return outranked(callout);
        },
        onChange(listener) {
          let last = outranked(callout);
          const check = (): void => {
            const now = outranked(callout);
            if (now === last) return;
            last = now;
            listener(now);
          };
          listeners.add(check);
          return () => {
            listeners.delete(check);
          };
        },
      };
    },
  };
}

const slotsByHold = new WeakMap<AnnouncementHold, AnnouncementSlot>();

/** The one slot shared by every callout under `hold`, the HUD's announcement hold. */
export function announcementSlotFor(hold: AnnouncementHold): AnnouncementSlot {
  let found = slotsByHold.get(hold);
  if (!found) {
    found = createAnnouncementSlot(hold);
    slotsByHold.set(hold, found);
  }
  return found;
}
