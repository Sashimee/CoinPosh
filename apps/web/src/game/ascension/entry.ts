import './ascension.css';
import type { UiApp, UiAudio } from '../../app/index.ts';
import type { ImpactEvent } from '../../audio/index.ts';
import { formatPercent } from '../../i18n/index.ts';
import { makePressable } from '../../ui/components/pressable.ts';
import type { UiContext } from '../../ui/context.ts';
import { h, restartAnimation } from '../../ui/dom.ts';
import { icon } from '../../ui/icons.ts';
import { Localizer } from '../../ui/localize.ts';
import { ascensionKey, registerAscensionStrings, venueKey } from './i18n.ts';
import type { AscensionProgress } from './plan.ts';

/** Laurel motes thrown off the button on a press. */
export const ENTRY_MOTES = 8;

/** A bright coin shimmer over the panel's open cue, so the laurel sounds like gold, not a door. */
export const ENTRY_SHIMMER: readonly ImpactEvent[] = [
  { material: 'coin', velocity: 0.75, pan: -0.1 },
  { material: 'coin', velocity: 1.05, pan: 0.1 },
];

export type EntryReadiness = 'ready' | 'building' | 'unknown';

export function entryReadiness(progress: AscensionProgress): EntryReadiness {
  if (progress.ready === null) return 'unknown';
  return progress.ready ? 'ready' : 'building';
}

export interface AscensionEntryOptions {
  readonly ui: Pick<UiApp, 'store' | 'bus' | 'i18n'>;
  /** The HUD dock the button joins. */
  readonly host: HTMLElement;
  readonly progress: () => AscensionProgress;
  readonly audio: () => Pick<UiAudio, 'playImpact'> | null;
  readonly onPress: () => void;
}

export interface AscensionEntry {
  readonly el: HTMLButtonElement;
  /** Re-reads `progress` and repaints the ring, the label and the ready glow. */
  update(): void;
  /** The ring's flourish after an ascension lands: the laurel starts its next climb. */
  renew(): void;
  dispose(): void;
}

/**
 * The HUD door to the prestige loop: a laurel medallion whose ring fills with the server's
 * lifetime Bullion and glows once the venue can be ascended. A press springs, chimes, buzzes,
 * sweeps a glint and throws laurel motes before the screen opens.
 */
export function mountAscensionEntry(options: AscensionEntryOptions): AscensionEntry {
  const { ui } = options;
  registerAscensionStrings(ui.i18n);
  const disposers: (() => void)[] = [];
  const loc = new Localizer(ui.i18n);
  const ctx: UiContext = {
    i18n: ui.i18n,
    loc,
    store: ui.store,
    bus: ui.bus,
    own: (dispose) => disposers.push(dispose),
  };
  const motes = h(
    'span',
    { class: 'cp-ascension-entry-motes', attrs: { 'aria-hidden': 'true' } },
    ...Array.from({ length: ENTRY_MOTES }, (_, index) =>
      h('span', {
        class: 'cp-ascension-entry-mote',
        attrs: { style: `--cp-mote-turn: ${index / ENTRY_MOTES}turn` },
      }),
    ),
  );
  const el = h(
    'button',
    {
      class: 'cp-dock-button cp-panel cp-ascension-entry',
      attrs: { type: 'button', 'data-testid': 'hud-ascension', 'aria-haspopup': 'dialog' },
    },
    h('span', { class: 'cp-ascension-entry-ring', attrs: { 'aria-hidden': 'true' } }),
    h('span', { class: 'cp-ascension-entry-glint', attrs: { 'aria-hidden': 'true' } }),
    icon('laurel'),
    motes,
  );

  let readiness: EntryReadiness | null = null;
  const label = (progress: AscensionProgress): string => {
    const percent = formatPercent(progress.fraction, ui.i18n.language);
    if (progress.ready === null) return ui.i18n.t(ascensionKey('entryUnknown'));
    if (progress.nextVenueId === null) {
      return ui.i18n.t(ascensionKey(progress.ready ? 'title' : 'entryFinal'), { percent });
    }
    const venue = ui.i18n.t(venueKey(progress.nextVenueId));
    return ui.i18n.t(ascensionKey(progress.ready ? 'entryReady' : 'entryProgress'), {
      percent,
      venue,
    });
  };
  const update = (): void => {
    const progress = options.progress();
    const next = entryReadiness(progress);
    el.style.setProperty('--cp-ascension-entry-progress', progress.fraction.toFixed(4));
    el.dataset.ready = next;
    if (readiness !== null && readiness !== 'ready' && next === 'ready') {
      restartAnimation(el, 'is-beckoning');
    }
    readiness = next;
    el.setAttribute('aria-label', label(progress));
  };
  disposers.push(loc.bind(update));

  makePressable(el, ctx, {
    feedback: 'open',
    onPress() {
      for (const sound of ENTRY_SHIMMER) options.audio()?.playImpact(sound);
      restartAnimation(el, 'is-summoned');
      options.onPress();
    },
  });

  options.host.append(el);
  return {
    el,
    update,
    renew() {
      update();
      restartAnimation(el, 'is-renewed');
    },
    dispose() {
      for (const off of disposers.splice(0).reverse()) off();
      loc.dispose();
      el.remove();
    },
  };
}
