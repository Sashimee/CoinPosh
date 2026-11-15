import { readSurfaces } from '../../vfx/text/surfaces.ts';

export const PLAYABLE_MARK = 'coinposh:boot:playable';
/** The first taps after playable compile shaders and spawn coins: their slow frames are not load. */
export const BOOT_HOLD_MS = 10_000;
/** A boot that never marks playable (a test page, a failed boot) stops holding after this. */
export const PLAYABLE_WAIT_MS = 60_000;
/** A sheet or crate closing animates over the table; its frames are not load either. */
export const OVERLAY_GRACE_MS = 2_000;
/** A dialog left open longer than this is the scene now, and is measured. */
export const OVERLAY_MAX_MS = 30_000;
export const OVERLAY_POLL_MS = 100;

export interface ScaleHoldSources {
  /** When the game became playable, in the rAF timebase, or `null` before that. */
  playableAt(): number | null;
  /** Whether a modal sheet, crate reveal or dialog covers the table, closing ones included. */
  overlayOpen(): boolean;
}

export interface ScaleHold {
  /** The time until which the scene scale must not change, as seen at `nowMs`. */
  until(nowMs: number): number;
}

/**
 * Decides when dynamic resolution may move: never during boot, the first `BOOT_HOLD_MS`
 * after playable, or while a modal dialog is up and for `OVERLAY_GRACE_MS` after it closes.
 * Those frames are slow for reasons a lower scale cannot fix, and a scale change in them is
 * what the player sees as the coins and table changing.
 */
export function createScaleHold(sources: ScaleHoldSources): ScaleHold {
  let firstSeen: number | null = null;
  let nextPoll = -Infinity;
  let openedAt: number | null = null;
  let overlayUntil = -Infinity;
  return {
    until(nowMs) {
      firstSeen ??= nowMs;
      if (nowMs >= nextPoll) {
        nextPoll = nowMs + OVERLAY_POLL_MS;
        if (sources.overlayOpen()) {
          openedAt ??= nowMs;
          overlayUntil = Math.min(nowMs + OVERLAY_GRACE_MS, openedAt + OVERLAY_MAX_MS);
        } else {
          openedAt = null;
        }
      }
      const playable = sources.playableAt();
      const boot =
        playable === null
          ? nowMs < firstSeen + PLAYABLE_WAIT_MS
            ? nowMs + OVERLAY_POLL_MS
            : -Infinity
          : playable + BOOT_HOLD_MS;
      return Math.max(boot, overlayUntil);
    },
  };
}

/** Reads the playable mark and the open dialogs from the page; `null` without a document. */
export function documentScaleHoldSources(): ScaleHoldSources | null {
  if (typeof document === 'undefined' || typeof performance === 'undefined') return null;
  let playable: number | null = null;
  return {
    playableAt() {
      playable ??= performance.getEntriesByName(PLAYABLE_MARK, 'mark')[0]?.startTime ?? null;
      return playable;
    },
    overlayOpen: () => readSurfaces(document).covered,
  };
}
