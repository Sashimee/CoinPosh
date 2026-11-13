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

/** How long a press waits for a fresh Bullion figure before the screen opens without one. */
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
  /** A state on a different venue than the game plays: lay it (levels, table, systems). */
  readonly onVenueChanged: (state: StateResponse) => void;
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
  /** Re-reads the Bullion figure, then opens the screen. */
  open(): Promise<void>;
  dispose(): void;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Mounts the prestige loop on the HUD: the entry button, the ascension screen behind it, and
 * the reload into the new venue once the cinematic hands back. Progress is always the
 * server's lifetime Bullion, re-read on every press so a stale figure never blocks the hold.
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

  const adopt = (fresh: StateResponse): void => {
    const moved = fresh.venue.id !== latest.venue.id;
    latest = fresh;
    known = true;
    if (moved) options.onVenueChanged(fresh);
    entry.update();
  };

  const reload = async (): Promise<boolean> => {
    let failure: unknown = null;
    for (const ms of RELOAD_RETRY_MS) {
      if (ms > 0) await delay(ms);
      if (gone()) return false;
      try {
        const fresh = await options.readState();
        if (gone()) return false;
        adopt(fresh);
        return true;
      } catch (error) {
        failure = error;
      }
    }
    options.onError?.(failure);
    return false;
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
      void reload().then((reloaded) => {
        if (reloaded) entry.renew();
      });
    },
    refresh: () => {
      void reload();
    },
    ...(options.onError ? { onError: options.onError } : {}),
  });

  const refreshFigure = async (): Promise<void> => {
    const clock: { timer?: ReturnType<typeof setTimeout> } = {};
    const timeout = new Promise<'timeout'>((resolve) => {
      clock.timer = setTimeout(() => {
        resolve('timeout');
      }, ENTRY_READ_TIMEOUT_MS);
    });
    try {
      const fresh = await Promise.race([options.readState(), timeout]);
      if (fresh === 'timeout') known = false;
      else adopt(fresh);
    } catch (error) {
      known = false;
      options.onError?.(error);
    } finally {
      clearTimeout(clock.timer);
    }
  };

  const open = (): Promise<void> => {
    opening ??= refreshFigure().then(() => {
      opening = null;
      if (gone()) return;
      entry.update();
      ascension.open();
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
