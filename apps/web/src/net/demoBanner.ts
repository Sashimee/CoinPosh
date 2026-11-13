import { NET_I18N_KEYS, type NetI18nKey } from './i18nKeys.ts';

/** Chip and toggle labels, kept in the `ui` catalogs (`apps/web/src/i18n/locales`). */
export const DEMO_BANNER_KEYS = {
  chip: 'demoBanner.chip',
  expand: 'demoBanner.expand',
  collapse: 'demoBanner.collapse',
} as const;

export type DemoBannerKey = NetI18nKey | (typeof DEMO_BANNER_KEYS)[keyof typeof DEMO_BANNER_KEYS];

export type Translate = (key: DemoBannerKey) => string;

/** CSS colours from the open venue's palette, supplied by the UI shell so net never reaches into a venue. */
export interface DemoBannerColors {
  readonly border: string;
  readonly surface: string;
  readonly text: string;
  readonly accent: string;
}

export type DemoBannerState = 'expanded' | 'collapsed';

export const DEMO_BANNER_ID = 'coinposh-demo-banner';
/** How long the full notice stays up after boot before it folds into the chip. */
export const DEMO_BANNER_COLLAPSE_MS = 4000;

const STYLE_ID = `${DEMO_BANNER_ID}-style`;
const TOGGLE_ID = `${DEMO_BANNER_ID}-toggle`;
const DETAIL_ID = `${DEMO_BANNER_ID}-detail`;
const ID = `#${DEMO_BANNER_ID}`;
const COLLAPSED = `${ID}[data-state='collapsed']`;
const EASE_SPRING = 'cubic-bezier(0.34, 1.36, 0.64, 1)';
const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';

const styleFor = (colors: DemoBannerColors) => `
${ID} {
  --cp-demo-detail-width: min(320px, calc(100vw - 64px));
  position: fixed;
  top: calc(env(safe-area-inset-top, 0px) + 12px);
  left: 50%;
  z-index: 10;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: center;
  max-width: min(560px, calc(100vw - 32px));
  padding: 1px 6px 10px;
  border: 1px solid ${colors.border};
  border-radius: 18px;
  background: color-mix(in srgb, ${colors.surface} 72%, transparent);
  backdrop-filter: blur(14px) saturate(140%);
  -webkit-backdrop-filter: blur(14px) saturate(140%);
  color: ${colors.text};
  font: 500 13px/1.35 system-ui, sans-serif;
  box-shadow: 0 6px 24px rgb(0 0 0 / 0.28);
  pointer-events: none;
  transform: translate(-50%, 0);
  transition:
    padding 440ms ${EASE_SPRING},
    border-radius 440ms ${EASE_OUT},
    box-shadow 300ms ease,
    opacity 180ms ease,
    visibility 0s;
  animation: coinposh-demo-banner-in 420ms ${EASE_SPRING} both;
}
${COLLAPSED} {
  padding: 0;
  border-radius: 999px;
  box-shadow: 0 3px 12px rgb(0 0 0 / 0.22);
}
${ID} > button {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 28px;
  margin: 0;
  padding: 0 11px 0 10px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  pointer-events: auto;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: transform 160ms ${EASE_OUT};
}
${ID} > button::before {
  content: '';
  position: absolute;
  inset: -8px -4px;
}
${ID} > button:active { transform: scale(0.94); }
${ID} > button:focus-visible {
  outline: 2px solid ${colors.accent};
  outline-offset: 2px;
}
${ID} > button > i {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: ${colors.accent};
  box-shadow: 0 0 0 3px color-mix(in srgb, ${colors.accent} 22%, transparent),
    0 0 10px ${colors.accent};
}
${ID} strong {
  color: ${colors.accent};
  font: italic 600 15px/1 Georgia, 'Times New Roman', serif;
  letter-spacing: 0.04em;
  white-space: nowrap;
}
${ID} > button > b {
  flex: none;
  width: 5px;
  height: 5px;
  margin: -2px 0 0 1px;
  border: solid currentColor;
  border-width: 0 1.5px 1.5px 0;
  opacity: 0.7;
  transform: rotate(-135deg) translate(-1px, -1px);
  transition: transform 360ms ${EASE_SPRING};
}
${COLLAPSED} > button > b { transform: rotate(45deg); }
${ID} > div {
  display: grid;
  grid-template-rows: 1fr;
  width: var(--cp-demo-detail-width);
  opacity: 1;
  transition:
    grid-template-rows 440ms ${EASE_SPRING},
    width 440ms ${EASE_SPRING},
    opacity 260ms ease 90ms;
}
${COLLAPSED} > div {
  grid-template-rows: 0fr;
  width: 0;
  opacity: 0;
  transition:
    grid-template-rows 380ms ${EASE_OUT},
    width 380ms ${EASE_OUT},
    opacity 140ms ease;
}
${ID} > div > div {
  display: flex;
  justify-content: center;
  min-height: 0;
  overflow: hidden;
}
${ID} > div span {
  flex: none;
  box-sizing: border-box;
  width: var(--cp-demo-detail-width);
  padding: 3px 10px 0;
  text-align: center;
  opacity: 0.86;
}
body:has([aria-modal='true']:not([hidden], [hidden] *)) ${ID} {
  opacity: 0;
  visibility: hidden;
  transition:
    opacity 160ms ease,
    visibility 0s linear 160ms;
}
@keyframes coinposh-demo-banner-in {
  from { opacity: 0; transform: translate(-50%, -12px) scale(0.96); }
  to { opacity: 1; transform: translate(-50%, 0) scale(1); }
}
@keyframes coinposh-demo-banner-fade { from { opacity: 0; } to { opacity: 1; } }
[data-motion='reduced'] ${ID},
[data-motion='reduced'] ${ID} * {
  transition: none !important;
}
@media (prefers-reduced-motion: reduce) {
  ${ID} { animation: coinposh-demo-banner-fade 200ms ease-out both; }
  ${ID}:not([data-motion='full'] *),
  ${ID}:not([data-motion='full'] *) * {
    transition: none !important;
  }
}
`;

const teardowns = new WeakMap<Document, () => void>();

/**
 * Shows the Demo Mode notice (replacing any earlier one); the returned function removes it.
 * The full notice folds into a "Demo" chip after {@link DEMO_BANNER_COLLAPSE_MS}; tapping the chip
 * toggles it. A replacement keeps the earlier banner's state, so a relabel never re-opens it.
 * The banner hides itself while any modal dialog (`aria-modal="true"`) is shown.
 */
export function mountDemoBanner(
  doc: Document,
  translate: Translate,
  colors: DemoBannerColors,
): () => void {
  const previous = doc.getElementById(DEMO_BANNER_ID);
  const carried = previous?.getAttribute('data-state') === 'collapsed' ? 'collapsed' : null;
  teardowns.get(doc)?.();
  previous?.remove();
  doc.getElementById(STYLE_ID)?.remove();

  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = styleFor(colors);
  const banner = doc.createElement('aside');
  banner.id = DEMO_BANNER_ID;
  banner.setAttribute('role', 'status');

  const toggle = doc.createElement('button');
  toggle.id = TOGGLE_ID;
  toggle.setAttribute('type', 'button');
  toggle.setAttribute('aria-controls', DETAIL_ID);
  const gem = doc.createElement('i');
  gem.setAttribute('aria-hidden', 'true');
  const title = doc.createElement('strong');
  const chevron = doc.createElement('b');
  chevron.setAttribute('aria-hidden', 'true');
  toggle.append(gem, title, chevron);

  const more = doc.createElement('div');
  more.id = DETAIL_ID;
  const clip = doc.createElement('div');
  const detail = doc.createElement('span');
  detail.textContent = translate(NET_I18N_KEYS.demoBannerDetail);
  clip.append(detail);
  more.append(clip);
  banner.append(toggle, more);

  let state: DemoBannerState = 'expanded';
  const show = (next: DemoBannerState): void => {
    state = next;
    const expanded = next === 'expanded';
    banner.setAttribute('data-state', next);
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.setAttribute(
      'aria-label',
      translate(expanded ? DEMO_BANNER_KEYS.collapse : DEMO_BANNER_KEYS.expand),
    );
    title.textContent = translate(expanded ? NET_I18N_KEYS.demoBanner : DEMO_BANNER_KEYS.chip);
    if (expanded) {
      more.removeAttribute('aria-hidden');
      more.removeAttribute('inert');
    } else {
      more.setAttribute('aria-hidden', 'true');
      more.setAttribute('inert', '');
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancelAutoCollapse = (): void => {
    clearTimeout(timer);
    timer = undefined;
  };
  const onClick = (): void => {
    cancelAutoCollapse();
    show(state === 'expanded' ? 'collapsed' : 'expanded');
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || state === 'collapsed') return;
    cancelAutoCollapse();
    show('collapsed');
  };
  toggle.addEventListener('click', onClick);
  toggle.addEventListener('keydown', onKeyDown);

  if (carried === null) {
    show('expanded');
    timer = setTimeout(() => {
      timer = undefined;
      show('collapsed');
    }, DEMO_BANNER_COLLAPSE_MS);
  } else {
    show(carried);
  }

  doc.head.append(style);
  doc.body.append(banner);

  const teardown = (): void => {
    cancelAutoCollapse();
    toggle.removeEventListener('click', onClick);
    toggle.removeEventListener('keydown', onKeyDown);
    if (teardowns.get(doc) === teardown) teardowns.delete(doc);
  };
  teardowns.set(doc, teardown);
  return () => {
    teardown();
    banner.remove();
    style.remove();
  };
}
