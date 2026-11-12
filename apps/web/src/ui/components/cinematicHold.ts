import type { AnnouncementHold } from './announcementHold.ts';
import { announcementSlotFor, type AnnouncementSlot } from './announcementSlot.ts';

type CrateEventName =
  | 'crate:spawned'
  | 'crate:fell'
  | 'crate:opened'
  | 'crate:collected'
  | 'crate:rejected'
  | 'crate:failed';

/** The slice of the crates bus the hold follows; every one of these names a crate. */
export interface CinematicEvents {
  on(type: CrateEventName, handler: (payload: { readonly crateId: string }) => void): () => void;
}

export interface CinematicHoldOptions {
  readonly events: CinematicEvents;
  readonly hold: AnnouncementHold;
  /**
   * The crate whose unbox is on screen, if any; the director plays opened crates in order. It is
   * read on the frame after an open, so it need not have taken the crate before this hears it.
   */
  readonly director: { readonly active: string | null };
  /** Runs `check` once per rendered frame; returns its unsubscribe. */
  readonly onFrame: (check: () => void) => () => void;
  /**
   * Calls `done` once the collected crate's reveal has left the screen, or at once when there
   * is none; returns a cancel.
   */
  readonly afterRevealExit: (done: () => void) => () => void;
  /** How long a fallen crate may wait for its open before the HUD speaks again. */
  readonly claimCapMs?: number;
  readonly warn?: (message: string) => void;
}

/** Demo answers in a frame and live in well under a second; a claim queued offline can sit forever. */
export const CLAIM_HOLD_CAP_MS = 6000;

/**
 * How long the first crate's arrival hint (game/crates/hint.ts, ARRIVAL_HINT_MS) stays up. The
 * crates module is loaded lazily, so it is mirrored here rather than imported; a unit test keeps
 * the two equal.
 */
export const CRATE_HINT_SLOT_MS = 4200;

/** A crate wedged on the table must not keep the upgrade nudge away for good. */
export const CRATE_ON_TABLE_CAP_MS = 30_000;

/**
 * Gives the announcement slot to crates on the table: the first crate this session claims it as
 * `crate-hint` for as long as its arrival hint is up, and every crate claims `crate-on-table`
 * until it falls, is refused or fails (or `tableCapMs` passes). The fall itself hands over to the
 * cinematic hold, which outranks both.
 */
export function claimSlotForCrates(options: {
  readonly events: CinematicEvents;
  readonly slot: AnnouncementSlot;
  readonly hintMs?: number;
  readonly tableCapMs?: number;
}): () => void {
  const { events, slot } = options;
  const hintMs = options.hintMs ?? CRATE_HINT_SLOT_MS;
  const tableCapMs = options.tableCapMs ?? CRATE_ON_TABLE_CAP_MS;
  const onTable = new Map<string, () => void>();
  let hinted = false;

  const timed = (callout: 'crate-hint' | 'crate-on-table', ms: number): (() => void) => {
    const release = slot.claim(callout);
    const timer = setTimeout(release, ms);
    return () => {
      clearTimeout(timer);
      release();
    };
  };
  const settle = ({ crateId }: { readonly crateId: string }): void => {
    onTable.get(crateId)?.();
    onTable.delete(crateId);
  };

  const offs = [
    events.on('crate:spawned', ({ crateId }) => {
      if (onTable.has(crateId)) return;
      const releases = [timed('crate-on-table', tableCapMs)];
      if (!hinted) {
        hinted = true;
        releases.push(timed('crate-hint', hintMs));
      }
      onTable.set(crateId, () => {
        for (const release of releases) release();
      });
    }),
    events.on('crate:fell', settle),
    events.on('crate:rejected', settle),
    events.on('crate:failed', settle),
  ];
  return () => {
    for (const off of offs) off();
    for (const release of onTable.values()) release();
    onTable.clear();
  };
}

type Phase = 'claiming' | 'queued' | 'playing' | 'leaving';

interface Tracked {
  phase: Phase;
  release: (() => void) | null;
  cancel: (() => void) | null;
}

/**
 * Holds the HUD's announcements from a crate's fall until its unbox has left the screen, so the
 * cinematic owns it. Every phase has a way out: a claim that never answers lapses after
 * `claimCapMs` and is forgotten (an open that turns up later holds afresh), a refused or failed claim lets go
 * at once, and an opened crate the director never plays (its card or cinematic threw) or drops
 * mid-play lets go on the next frame.
 */
export function holdForCrateCinematics(options: CinematicHoldOptions): () => void {
  const { events, hold, director, onFrame, afterRevealExit } = options;
  const claimCapMs = options.claimCapMs ?? CLAIM_HOLD_CAP_MS;
  const warn =
    options.warn ??
    ((message: string) => {
      console.warn(message);
    });
  const crates = new Map<string, Tracked>();
  /** Opened crates in the order the director was handed them. */
  const order: string[] = [];

  const settle = (crate: Tracked): void => {
    crate.cancel?.();
    crate.cancel = null;
    crate.release?.();
    crate.release = null;
  };
  const forget = (crateId: string): void => {
    const crate = crates.get(crateId);
    if (!crate) return;
    settle(crate);
    crates.delete(crateId);
    const at = order.indexOf(crateId);
    if (at >= 0) order.splice(at, 1);
  };

  const check = (): void => {
    if (order.length === 0) return;
    const active = director.active;
    const activeAt = active === null ? -1 : order.indexOf(active);
    for (const [i, crateId] of [...order].entries()) {
      const crate = crates.get(crateId);
      if (!crate) continue;
      if (crate.phase === 'queued') {
        if (crateId === active) crate.phase = 'playing';
        else if (active === null || (activeAt >= 0 && i < activeAt)) {
          warn(
            `CoinPosh crates: crate ${crateId} opened but its unbox never played; HUD announcements resume.`,
          );
          forget(crateId);
        }
      } else if (crate.phase === 'playing' && crateId !== active) {
        warn(
          `CoinPosh crates: the unbox of crate ${crateId} ended without a collect; HUD announcements resume.`,
        );
        forget(crateId);
      }
    }
  };

  const offs = [
    events.on('crate:fell', ({ crateId }) => {
      if (crates.has(crateId)) return;
      const crate: Tracked = { phase: 'claiming', release: hold.hold(), cancel: null };
      const timer = setTimeout(() => {
        crate.cancel = null;
        if (crate.phase !== 'claiming') return;
        warn(
          `CoinPosh crates: crate ${crateId} waited ${claimCapMs} ms for its open; HUD announcements resume until it opens.`,
        );
        forget(crateId);
      }, claimCapMs);
      crate.cancel = () => {
        clearTimeout(timer);
      };
      crates.set(crateId, crate);
    }),
    events.on('crate:opened', ({ crateId }) => {
      let crate = crates.get(crateId);
      if (!crate) {
        crate = { phase: 'queued', release: null, cancel: null };
        crates.set(crateId, crate);
      }
      crate.cancel?.();
      crate.cancel = null;
      crate.release ??= hold.hold();
      crate.phase = 'queued';
      if (!order.includes(crateId)) order.push(crateId);
    }),
    events.on('crate:collected', ({ crateId }) => {
      const crate = crates.get(crateId);
      if (!crate || crate.phase === 'leaving') return;
      crate.phase = 'leaving';
      const at = order.indexOf(crateId);
      if (at >= 0) order.splice(at, 1);
      crate.cancel = afterRevealExit(() => {
        forget(crateId);
      });
    }),
    events.on('crate:rejected', ({ crateId }) => {
      forget(crateId);
    }),
    events.on('crate:failed', ({ crateId }) => {
      forget(crateId);
    }),
    onFrame(check),
    // After the fall handler above, so a falling crate is held before it leaves the slot.
    claimSlotForCrates({ events, slot: announcementSlotFor(hold) }),
  ];

  return () => {
    for (const off of offs) off();
    for (const crateId of [...crates.keys()]) forget(crateId);
  };
}
