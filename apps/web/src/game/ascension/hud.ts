import type { AscendResponse, StateResponse } from '@coinposh/shared';
import type { UiApp, UiAudio } from '../../app/index.ts';
import { createBus, type Bus } from '../../app/bus.ts';
import type { HapticPattern } from '../../app/feedback.ts';
import type { AscendCinematicEvents } from '../../vfx/cinematics/ascend/index.ts';
import type { AscensionApi } from './controller.ts';
import { mountAscensionEntry, type AscensionEntry } from './entry.ts';
import type { AscensionEvents } from './events.ts';
import type { AscensionMount, MountAscensionOptions } from './index.ts';
import { ascensionProgress, lifetimeBullionOf } from './plan.ts';

/** How long the open screen shows the last figure before it gives up on a fresh one. */
export const ENTRY_READ_TIMEOUT_MS = 1_500;

/** Back-off between re-reads of the state after an ascension, until the new venue is in. */
export const RELOAD_RETRY_MS: readonly number[] = [0, 1_000, 3_000];

export interface MountAscensionHudOptions {
  readonly ui: Pick<UiApp, 'store' | 'bus' | 'i18n' | 'setWallet'>;
  /** The UI root laid over the canvas, which the screen and the cinematic cover. */
  readonly host: HTMLElement;
  /** The HUD dock the entry button joins. */
  readonly dock: HTMLElement;
  readonly api: AscensionApi;
  /** The state the game booted on. */
  readonly state: StateResponse;
  /** GET /v1/state without `hydrate=boot`, which would refund the coins in play. */
  readonly readState: () => Promise<StateResponse>;
  /**
   * GET /v1/state with `hydrate=boot`, once the old table has stopped and its queue drained:
   * the ascension forgot every coin and crate on it, so the new venue is laid from a boot.
   */
  readonly bootState: () => Promise<StateResponse>;
  /** Lays a boot state on the table: its coins and crates replace the sim's, its levels the sheet's. */
  readonly layTable: (state: StateResponse) => void | Promise<void>;
  /** Every boot read failed, or the table could not be laid on one; defaults to `onError`. */
  readonly onRelayFailed?: (error: unknown) => void;
  readonly audio: () => Pick<UiAudio, 'playImpact'> | null;
  readonly vibrate?: ((pattern: HapticPattern) => void) | null;
  readonly stage?: () => HTMLElement | null;
  readonly onError?: (error: unknown) => void;
  readonly events?: Bus<AscensionEvents>;
  readonly cinematicEvents?: Bus<AscendCinematicEvents>;
  readonly mount: (options: MountAscensionOptions) => AscensionMount;
  readonly delay?: (ms: number) => Promise<void>;
}

export interface AscensionHud {
  readonly events: Bus<AscensionEvents>;
  readonly entry: AscensionEntry;
  /** The last state the server reported, as the entry and the screen read it. */
  readonly state: StateResponse;
  /** Opens the screen at once on the last figure, and resolves once a fresh one is on it. */
  open(): Promise<void>;
  dispose(): void;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Mounts the prestige loop on the HUD: the entry button, the ascension screen behind it, and
 * the reload into the new venue once the cinematic hands back, which boots the table again
 * so every coin on it is one the server holds. Progress is always the server's lifetime
 * Bullion, re-read on every press so a stale figure never blocks the hold.
 */
export function mountAscensionHud(options: MountAscensionHudOptions): AscensionHud {
  const events = options.events ?? createBus<AscensionEvents>();
  const delay = options.delay ?? wait;
  let latest = options.state;
  let known = true;
  let opening: Promise<void> | null = null;
  let disposed = false;
  const gone = (): boolean => disposed;

  const progress = () =>
    ascensionProgress(latest.venue.id, known ? lifetimeBullionOf(latest.venue) : null);

  let relaying: Promise<boolean> | null = null;

  const take = (fresh: StateResponse): void => {
    latest = fresh;
    known = true;
    entry.update();
  };

  const retry = async (
    read: () => Promise<StateResponse>,
    fail: (error: unknown) => void,
  ): Promise<StateResponse | null> => {
    let failure: unknown = null;
    for (const ms of RELOAD_RETRY_MS) {
      if (ms > 0) await delay(ms);
      if (gone()) return null;
      try {
        const fresh = await read();
        return gone() ? null : fresh;
      } catch (error) {
        failure = error;
      }
    }
    if (!gone()) fail(failure);
    return null;
  };

  /** Boots the table on the venue the server now plays and lays it; one at a time. */
  const relay = (): Promise<boolean> => {
    const failed = (error: unknown): void => {
      (options.onRelayFailed ?? options.onError)?.(error);
    };
    relaying ??= (async () => {
      const fresh = await retry(options.bootState, failed);
      if (fresh === null) return false;
      try {
        await options.layTable(fresh);
      } catch (error) {
        if (!gone()) failed(error);
        return false;
      }
      if (gone()) return false;
      take(fresh);
      return true;
    })().finally(() => {
      relaying = null;
    });
    return relaying;
  };

  /** A plain read; one that finds the player on another venue (another tab ascended) relays. */
  const adopt = (fresh: StateResponse): void => {
    const moved = fresh.venue.id !== latest.venue.id;
    take(fresh);
    if (moved) void relay();
  };

  const reload = async (): Promise<void> => {
    const fresh = await retry(options.readState, (error) => {
      options.onError?.(error);
    });
    if (fresh !== null) adopt(fresh);
  };

  const ascension = options.mount({
    ui: options.ui,
    host: options.host,
    api: options.api,
    events,
    ...(options.cinematicEvents ? { cinematicEvents: options.cinematicEvents } : {}),
    venueId: () => latest.venue.id,
    bullion: () => progress().bullion,
    audio: options.audio,
    vibrate: options.vibrate ?? null,
    ...(options.stage ? { stage: options.stage } : {}),
    onAscended: (_response: AscendResponse) => {
      void relay().then((laid) => {
        if (laid) entry.renew();
      });
    },
    refresh: () => {
      void reload();
    },
    ...(options.onError ? { onError: options.onError } : {}),
  });

  const showFigure = (): void => {
    entry.update();
    ascension.setBullion(progress().bullion);
  };

  /**
   * Settles once the read lands or ENTRY_READ_TIMEOUT_MS passes, whichever is first. A timeout
   * shows no figure so the server decides the hold; a read landing after it still shows its own.
   */
  const refreshFigure = (): Promise<void> =>
    new Promise((settle) => {
      const timer = setTimeout(() => {
        if (gone()) return;
        known = false;
        showFigure();
        settle();
      }, ENTRY_READ_TIMEOUT_MS);
      options.readState().then(
        (fresh) => {
          clearTimeout(timer);
          if (!gone()) {
            adopt(fresh);
            showFigure();
          }
          settle();
        },
        (error: unknown) => {
          clearTimeout(timer);
          if (!gone()) {
            known = false;
            options.onError?.(error);
            showFigure();
          }
          settle();
        },
      );
    });

  const open = (): Promise<void> => {
    if (gone()) return Promise.resolve();
    ascension.open();
    opening ??= refreshFigure().then(() => {
      opening = null;
    });
    return opening;
  };

  const entry = mountAscensionEntry({
    ui: options.ui,
    host: options.dock,
    progress,
    audio: options.audio,
    onPress: () => {
      void open();
    },
  });
  entry.update();

  return {
    events,
    entry,
    get state() {
      return latest;
    },
    open,
    dispose() {
      disposed = true;
      ascension.dispose();
      entry.dispose();
    },
  };
}
