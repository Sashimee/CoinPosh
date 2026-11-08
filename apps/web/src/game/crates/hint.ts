import './crates.css';
import type { CrateId } from '@coinposh/shared';
import type { UiApp } from '../../app/index.ts';
import type { Bus } from '../../app/bus.ts';
import { h } from '../../ui/dom.ts';
import { Localizer } from '../../ui/localize.ts';
import type { CrateEvents } from './events.ts';
import { cratesKey, registerCratesStrings } from './i18n.ts';

/** Long enough to read twice, short enough to be gone before the crate reaches the lip. */
export const ARRIVAL_HINT_MS = 4200;

export interface ArrivalHintView {
  show(): void;
  hide(): void;
}

export interface HintClock {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const browserClock: HintClock = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
};

/**
 * Tells the player what a crate is for the first time one lands this session (the FTUE crate
 * at drop 12): shown on the first `crate:spawned`, gone when that crate falls or the read time
 * is up. Later crates go without it.
 */
export function bindArrivalHint(
  events: Pick<Bus<CrateEvents>, 'on'>,
  view: ArrivalHintView,
  clock: HintClock = browserClock,
): () => void {
  let first: CrateId | null = null;
  let timer: unknown = null;
  let visible = false;
  const hide = () => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
    if (!visible) return;
    visible = false;
    view.hide();
  };
  const settled = ({ crateId }: { readonly crateId: CrateId }) => {
    if (crateId === first) hide();
  };
  const offs = [
    events.on('crate:spawned', ({ crateId }) => {
      if (first !== null) return;
      first = crateId;
      visible = true;
      view.show();
      timer = clock.setTimeout(hide, ARRIVAL_HINT_MS);
    }),
    events.on('crate:fell', settled),
    events.on('crate:rejected', settled),
    events.on('crate:failed', settled),
  ];
  return () => {
    for (const off of offs) off();
    hide();
  };
}

export interface ArrivalHintDom extends ArrivalHintView {
  dispose(): void;
}

/**
 * The hint itself: a lacquer pill over the table. The text goes in only on `show`, so the live
 * region announces it.
 */
export function mountArrivalHint(options: {
  readonly ui: Pick<UiApp, 'i18n'>;
  readonly host: HTMLElement;
  readonly reducedMotion: () => boolean;
}): ArrivalHintDom {
  registerCratesStrings(options.ui.i18n);
  const loc = new Localizer(options.ui.i18n);
  const el = h('p', {
    class: 'cp-crate-hint',
    attrs: { role: 'status', 'aria-live': 'polite', 'data-testid': 'crate-hint' },
  });
  el.hidden = true;
  options.host.append(el);
  let offText: (() => void) | null = null;
  const clear = () => {
    offText?.();
    offText = null;
    el.textContent = '';
  };
  return {
    show() {
      el.dataset.motion = options.reducedMotion() ? 'reduced' : 'full';
      el.hidden = false;
      offText ??= loc.text(el, () => options.ui.i18n.t(cratesKey('arrived')));
    },
    hide() {
      el.hidden = true;
      clear();
    },
    dispose() {
      clear();
      loc.dispose();
      el.remove();
    },
  };
}
