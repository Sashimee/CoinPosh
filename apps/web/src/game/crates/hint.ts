import './crates.css';
import type { CrateId } from '@coinposh/shared';
import type { UiApp } from '../../app/index.ts';
import type { Bus } from '../../app/bus.ts';
import { h } from '../../ui/dom.ts';
import { Localizer } from '../../ui/localize.ts';
import { coinFloorRect, type Box } from '../../ui/components/railLayout.ts';
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
    events.on('crate:spawned', ({ crateId, resumed }) => {
      if (resumed || first !== null) return;
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

/** A rectangle in CSS px from the viewport's top-left corner, as the hint is `position: fixed`. */
export interface HintRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * `apron` between the coin floor's payout lip and the HUD below the table, right where the crate
 * has to go; `crown` under the HUD above the table when the apron is too tight.
 */
export type ArrivalHintZone = 'apron' | 'crown';

export interface ArrivalHintPlacement {
  readonly zone: ArrivalHintZone;
  /** Distance from the viewport top to the hint's top edge. */
  readonly top: number;
  /** Distance kept clear on each side, so the centred hint never reaches a side rail. */
  readonly inset: number;
}

export interface ArrivalHintLayout {
  readonly viewportWidth: number;
  /** Bottom edge of the HUD above the table: banner, Vault plaque and its notices. */
  readonly ceiling: number;
  /** The Vault plaque, which the credit pop swells about its centre. */
  readonly plaque: HintRect | null;
  /** The coin floor as the camera frames it; its bottom edge is the payout lip. */
  readonly floor: HintRect;
  /** Top edge of the HUD below the table: the dock, or the aim rail when it sits higher. */
  readonly base: number;
  /** Collapsed side rails. */
  readonly rails: readonly HintRect[];
}

/** Two lines of hint plus padding and its border. */
export const HINT_HEIGHT = 56;
const LIP_GAP = 12;
const CHROME_GAP = 8;
const RAIL_GAP = 8;
const MIN_INSET = 16;
/** Narrower than this and even the shrunk instruction would wrap past two lines. */
const MIN_WIDTH = 220;
/** Headroom for the Vault plaque's credit pop (`SPRINGS.pop`), which swells it about its centre. */
export const PLAQUE_SWELL = 1.3;
/** The instruction shrinks this far to stay on one line before it may wrap. */
export const HINT_MIN_FONT_SCALE = 0.8;

function insetFor(layout: ArrivalHintLayout, top: number): number {
  const bottom = top + HINT_HEIGHT;
  const centre = layout.viewportWidth / 2;
  let inset = MIN_INSET;
  for (const rail of layout.rails) {
    if (rail.right <= rail.left || rail.bottom <= rail.top) continue;
    if (rail.bottom <= top || rail.top >= bottom) continue;
    const reach =
      (rail.left + rail.right) / 2 < centre ? rail.right : layout.viewportWidth - rail.left;
    inset = Math.max(inset, Math.ceil(reach + RAIL_GAP));
  }
  return inset;
}

/**
 * Where the hint lands, clear of the Vault balance it is crediting (at the height of its credit
 * pop), the payout lip and the side rails, narrowed symmetrically for any rail in its band.
 */
export function placeArrivalHint(layout: ArrivalHintLayout): ArrivalHintPlacement {
  const apronTop = layout.floor.bottom + LIP_GAP;
  const apronRoom = layout.base - CHROME_GAP - apronTop;
  if (apronRoom >= HINT_HEIGHT) {
    const top = Math.round(apronTop + (apronRoom - HINT_HEIGHT) / 2);
    const inset = insetFor(layout, top);
    if (layout.viewportWidth - 2 * inset >= MIN_WIDTH) return { zone: 'apron', top, inset };
  }
  let ceiling = layout.ceiling;
  if (layout.plaque) {
    const { top, bottom } = layout.plaque;
    ceiling = Math.max(ceiling, (top + bottom) / 2 + ((bottom - top) * PLAQUE_SWELL) / 2);
  }
  const top = Math.ceil(ceiling + CHROME_GAP);
  return { zone: 'crown', top, inset: insetFor(layout, top) };
}

/** Font scale that fits a `natural`-wide line into `room`, never below `HINT_MIN_FONT_SCALE`. */
export function hintFontScale(natural: number, room: number): number {
  if (natural <= room || room <= 0) return 1;
  return Math.max(HINT_MIN_FONT_SCALE, Math.floor((room / natural) * 100) / 100);
}

const HUD_CEILING = '.cp-hud-top';
const HUD_BASE = '[data-testid="hud-dock"]';
const AIM_RETICLE = '[data-testid="aim-reticle"]';
const BALANCE = '[data-testid="hud-balance"]';
/** The collapsed rail at the screen edge; an open card is transient news and may overlap. */
const SIDE_RAIL = '.cp-rail-spine';

function toRect(box: DOMRect | Box): HintRect {
  return {
    left: box.left,
    top: box.top,
    right: box.left + box.width,
    bottom: box.top + box.height,
  };
}

/**
 * The hint itself: a lacquer plate with the crate's name above what to do with it, set just
 * past the payout lip it points at, never over the balance it is crediting. The text goes in
 * only on `show`, so the live region announces it. Without a HUD in `host` (the UI preview) it
 * keeps the stylesheet's fallback spot.
 */
export function mountArrivalHint(options: {
  readonly ui: Pick<UiApp, 'i18n'>;
  readonly host: HTMLElement;
  readonly reducedMotion: () => boolean;
}): ArrivalHintDom {
  registerCratesStrings(options.ui.i18n);
  const loc = new Localizer(options.ui.i18n);
  const title = h('span', { class: 'cp-crate-hint-title' });
  const line = h('span', { class: 'cp-crate-hint-line' });
  const el = h(
    'p',
    {
      class: 'cp-crate-hint',
      attrs: { role: 'status', 'aria-live': 'polite', 'data-testid': 'crate-hint' },
    },
    title,
    line,
  );
  el.hidden = true;
  options.host.append(el);
  let offText: (() => void) | null = null;
  let observer: ResizeObserver | null = null;
  const fit = () => {
    line.classList.remove('is-wrapping');
    line.style.removeProperty('--cp-crate-hint-scale');
    const natural = line.scrollWidth;
    const room = line.clientWidth;
    const scale = hintFontScale(natural, room);
    if (scale < 1) line.style.setProperty('--cp-crate-hint-scale', String(scale));
    line.classList.toggle('is-wrapping', natural * scale > room);
  };
  const place = () => {
    const ceiling = options.host.querySelector(HUD_CEILING);
    const dock = options.host.querySelector(HUD_BASE);
    if (!ceiling || !dock) return;
    const width = document.documentElement.clientWidth;
    const height = document.documentElement.clientHeight;
    const reticle = document.querySelector(AIM_RETICLE)?.getBoundingClientRect();
    const dockTop = dock.getBoundingClientRect().top;
    const at = placeArrivalHint({
      viewportWidth: width,
      ceiling: ceiling.getBoundingClientRect().bottom,
      plaque: options.host.querySelector(BALANCE)?.getBoundingClientRect() ?? null,
      floor: toRect(coinFloorRect(width, height)),
      base: reticle && reticle.height > 0 ? Math.min(dockTop, reticle.top) : dockTop,
      rails: [...options.host.querySelectorAll(SIDE_RAIL)].map((rail) =>
        rail.getBoundingClientRect(),
      ),
    });
    el.dataset.zone = at.zone;
    el.style.setProperty('--cp-crate-hint-top', `${at.top}px`);
    el.style.setProperty('--cp-crate-hint-inset', `${at.inset}px`);
    if (!el.hidden) fit();
  };
  const follow = () => {
    if (observer) return;
    place();
    observer = new ResizeObserver(place);
    observer.observe(document.documentElement);
    const ceiling = options.host.querySelector(HUD_CEILING);
    if (ceiling) observer.observe(ceiling);
  };
  const clear = () => {
    observer?.disconnect();
    observer = null;
    offText?.();
    offText = null;
    title.textContent = '';
    line.textContent = '';
  };
  return {
    show() {
      el.dataset.motion = options.reducedMotion() ? 'reduced' : 'full';
      follow();
      el.hidden = false;
      offText ??= loc.bind(() => {
        title.textContent = options.ui.i18n.t(cratesKey('title'));
        line.textContent = options.ui.i18n.t(cratesKey('arrived'));
        fit();
      });
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
