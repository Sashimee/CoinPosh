import type { AscendResponse, VenueId } from '@coinposh/shared';
import type { UiApp, UiAudio } from '../../app/index.ts';
import type { Bus } from '../../app/bus.ts';
import type { HapticPattern } from '../../app/feedback.ts';
import { formatInteger } from '../../i18n/index.ts';
import { isReducedMotion } from '../../ui/motion/reduced.ts';
import { AscendCinematic, type AscendCinematicEvents } from '../../vfx/cinematics/ascend/index.ts';
import { createAscensionController, type AscensionApi } from './controller.ts';
import type { AscensionEvents } from './events.ts';
import { ascensionKey, registerAscensionStrings, venueKey } from './i18n.ts';
import { showAscension, type AscensionScreen } from './screen.ts';

export { netAscensionApi } from './api.ts';
export { classifyAscensionRejection, createAscensionController } from './controller.ts';
export type { AscensionApi, AscensionController, Outcome } from './controller.ts';
export type { AscensionEvents, AscensionRejection } from './events.ts';
export { ENTRY_MOTES, ENTRY_SHIMMER, entryReadiness, mountAscensionEntry } from './entry.ts';
export type { AscensionEntry, AscensionEntryOptions, EntryReadiness } from './entry.ts';
export { ENTRY_READ_TIMEOUT_MS, mountAscensionHud, RELOAD_RETRY_MS } from './hud.ts';
export type { AscensionHud, MountAscensionHudOptions } from './hud.ts';
export { ASCENSION_NAMESPACE, registerAscensionStrings } from './i18n.ts';
export {
  ascensionProgress,
  canRequestAscension,
  FAMILY_OFFICE_LINES,
  familyOfficeRows,
  HOLD_TO_ASCEND_MS,
  holdFraction,
  holdTick,
  lifetimeBullionOf,
  nextVenueId,
} from './plan.ts';
export type { AscensionProgress, FamilyOfficeRow } from './plan.ts';
export { showAscension } from './screen.ts';
export type { AscensionScreen, AscensionScreenOptions } from './screen.ts';

export interface MountAscensionOptions {
  readonly ui: Pick<UiApp, 'store' | 'bus' | 'i18n' | 'setWallet'>;
  /** The UI root laid over the canvas. */
  readonly host: HTMLElement;
  readonly api: AscensionApi;
  readonly events: Bus<AscensionEvents>;
  readonly cinematicEvents?: Bus<AscendCinematicEvents>;
  /** The venue being played, as the server last reported it. */
  readonly venueId: () => VenueId;
  /** Lifetime Bullion as the server last reported it; null when the client has no figure. */
  readonly bullion: () => number | null;
  readonly audio: () => Pick<UiAudio, 'playImpact'> | null;
  readonly vibrate?: ((pattern: HapticPattern) => void) | null;
  /** The WebGL canvas: it sinks and rises with the cinematic. */
  readonly stage?: () => HTMLElement | null;
  /** The ascension is confirmed and its cinematic has played; re-read state and lay the new venue. */
  readonly onAscended: (response: AscendResponse) => void;
  readonly refresh?: () => void;
  readonly onError?: (error: unknown) => void;
}

export interface AscensionMount {
  /** Opens the ascension screen with the Family Office, unless it or the cinematic is up. */
  open(): void;
  dispose(): void;
}

/**
 * The prestige flow: screen → hold to ascend → server reset → 3 s cinematic → new venue. Every
 * balance shown after the cinematic is the server's response; the client never decides a payout.
 */
export function mountAscension(options: MountAscensionOptions): AscensionMount {
  const { ui, events } = options;
  registerAscensionStrings(ui.i18n);
  const controller = createAscensionController({ api: options.api, events });
  let screen: AscensionScreen | null = null;
  let cinematic: AscendCinematic | null = null;
  let disposed = false;

  const closeScreen = () => {
    screen?.dispose();
    screen = null;
  };

  const playCinematic = (response: AscendResponse) => {
    const landedOn = response.unlockedVenueId ?? response.venueId;
    const venue = ui.i18n.t(venueKey(landedOn));
    const amount = formatInteger(response.goldBarsGranted, ui.i18n.language);
    cinematic = new AscendCinematic({
      host: options.host,
      stage: options.stage?.() ?? null,
      goldBars: response.goldBarsGranted,
      formatAmount: (value) => formatInteger(value, ui.i18n.language),
      labels: {
        goldBars: ui.i18n.t(ascensionKey('goldBars')),
        venue,
        skip: ui.i18n.t(ascensionKey('skip')),
        announce: ui.i18n.t(ascensionKey('announce'), { amount, venue }),
      },
      reducedMotion: isReducedMotion(),
      audio: options.audio,
      haptic: (pattern) => {
        if (ui.store.getState().settings.haptics) options.vibrate?.(pattern);
      },
      ...(options.cinematicEvents ? { events: options.cinematicEvents } : {}),
    });
    void cinematic.done.then(() => {
      cinematic = null;
      if (disposed) return;
      ui.setWallet(response.wallet);
      events.emit('ascension:completed', { venueId: landedOn });
      options.onAscended(response);
    });
  };

  return {
    open() {
      if (disposed || screen !== null || cinematic !== null) return;
      const venueId = options.venueId();
      screen = showAscension({
        ui,
        host: options.host,
        venueId,
        bullion: options.bullion(),
        controller,
        audio: options.audio,
        onConfirmed: (response) => {
          closeScreen();
          playCinematic(response);
        },
        onClose: closeScreen,
        ...(options.refresh ? { refresh: options.refresh } : {}),
        ...(options.onError ? { onError: options.onError } : {}),
      });
      events.emit('ascension:opened', { venueId });
    },
    dispose() {
      disposed = true;
      closeScreen();
      cinematic?.dispose();
      cinematic = null;
    },
  };
}
