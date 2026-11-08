import type { FeedbackKind } from '../../app/state.ts';
import { NET_I18N_KEYS, type NetI18nKey } from '../../net/i18nKeys.ts';
import type { TurnstileHost } from '../../net/turnstile.ts';
import { rivieraTokens } from '../../scene/venues/riviera/palette.ts';
import { isReducedMotion, onReducedMotionChange } from '../motion/reduced.ts';
import { hexToRgbChannels } from '../theme.ts';

export const TURNSTILE_OVERLAY_ID = 'coinposh-turnstile';
const STYLE_ID = `${TURNSTILE_OVERLAY_ID}-style`;
const FAILED_NOTICE_MS = 2600;

export interface TurnstileOverlayOptions {
  readonly document: Document;
  readonly translate: (key: NetI18nKey) => string;
  readonly onLanguageChanged: (relabel: () => void) => () => void;
  /** Turned into sound and haptics by the UI feedback layer. */
  readonly feedback: (kind: FeedbackKind) => void;
}

const rgb = (hex: string, alpha: number): string => `rgb(${hexToRgbChannels(hex)} / ${alpha})`;
const navy = rivieraTokens['navy-lacquer'];
const gold = rivieraTokens['gold-brushed'];

const STYLE = `
#${TURNSTILE_OVERLAY_ID} {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  box-sizing: border-box;
  padding:
    calc(env(safe-area-inset-top, 0px) + 16px)
    calc(env(safe-area-inset-right, 0px) + 16px)
    calc(env(safe-area-inset-bottom, 0px) + 16px)
    calc(env(safe-area-inset-left, 0px) + 16px);
  background: radial-gradient(120% 80% at 50% 40%, ${rgb(navy, 0.28)}, ${rgb('#000000', 0.62)});
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: opacity 260ms ease-out, visibility 0s linear 260ms;
}
#${TURNSTILE_OVERLAY_ID}[data-state='challenge'] {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
  transition: opacity 260ms ease-out, visibility 0s;
}
#${TURNSTILE_OVERLAY_ID}[data-state='failed'] {
  opacity: 1;
  visibility: visible;
  background: transparent;
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  transition: opacity 260ms ease-out, visibility 0s;
}
#${TURNSTILE_OVERLAY_ID} .cp-turnstile-panel {
  position: relative;
  box-sizing: border-box;
  width: min(360px, 100%);
  padding: 22px 20px 18px;
  border: 1px solid ${rgb(gold, 0.55)};
  border-radius: 24px;
  background:
    linear-gradient(160deg, ${rgb(rivieraTokens.champagne, 0.1)}, transparent 42%),
    ${rgb(navy, 0.8)};
  -webkit-backdrop-filter: blur(18px) saturate(150%);
  backdrop-filter: blur(18px) saturate(150%);
  box-shadow:
    inset 0 0 0 4px ${rgb(navy, 0.4)},
    inset 0 0 0 5px ${rgb(gold, 0.22)},
    0 24px 60px ${rgb('#000000', 0.45)};
  color: ${rivieraTokens.ivory};
  font: 500 14px/1.45 var(--cp-font-ui, 'Manrope', system-ui, sans-serif);
  text-align: center;
  outline: none;
  transform: translateY(18px) scale(0.94);
  transition: transform 560ms cubic-bezier(0.34, 1.56, 0.64, 1);
}
#${TURNSTILE_OVERLAY_ID}:is([data-state='challenge'], [data-state='failed']) .cp-turnstile-panel {
  transform: none;
}
#${TURNSTILE_OVERLAY_ID} .cp-turnstile-crest {
  display: block;
  width: 10px;
  height: 10px;
  margin: 0 auto 12px;
  border: 1px solid ${gold};
  transform: rotate(45deg);
  box-shadow: 0 0 12px ${rgb(gold, 0.5)};
}
#${TURNSTILE_OVERLAY_ID} h2 {
  margin: 0 0 6px;
  color: ${rivieraTokens.champagne};
  font: italic 600 26px/1.1 var(--cp-font-display, 'Cormorant Garamond', Georgia, serif);
  letter-spacing: 0.02em;
}
#${TURNSTILE_OVERLAY_ID} p { margin: 0; opacity: 0.84; }
#${TURNSTILE_OVERLAY_ID} .cp-turnstile-widget {
  display: flex;
  justify-content: center;
  min-height: 65px;
  margin-top: 16px;
}
#${TURNSTILE_OVERLAY_ID} .cp-turnstile-failed {
  display: none;
  color: ${rivieraTokens['coral-sunset']};
  opacity: 1;
}
#${TURNSTILE_OVERLAY_ID}[data-state='failed'] .cp-turnstile-failed { display: block; }
#${TURNSTILE_OVERLAY_ID}[data-state='failed'] :is(.cp-turnstile-detail, .cp-turnstile-widget) {
  display: none;
}
#${TURNSTILE_OVERLAY_ID}[data-reduced] .cp-turnstile-panel {
  transform: none;
  transition: none;
}
#${TURNSTILE_OVERLAY_ID}[data-reduced] { transition-duration: 160ms, 0s; }
@media (prefers-reduced-motion: reduce) {
  #${TURNSTILE_OVERLAY_ID} .cp-turnstile-panel { transform: none; transition: none; }
}
`;

/**
 * The frosted panel that holds Cloudflare's widget. It stays mounted but invisible so the widget
 * can pass the player silently, and only rises when Cloudflare asks for an interactive check.
 */
export function mountTurnstileOverlay(options: TurnstileOverlayOptions): TurnstileHost {
  const doc = options.document;
  doc.getElementById(TURNSTILE_OVERLAY_ID)?.remove();
  doc.getElementById(STYLE_ID)?.remove();
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;

  const root = doc.createElement('div');
  root.id = TURNSTILE_OVERLAY_ID;
  root.dataset.state = 'hidden';
  root.dataset.testid = 'turnstile-overlay';
  root.setAttribute('aria-hidden', 'true');
  root.inert = true;

  const panel = doc.createElement('section');
  panel.className = 'cp-turnstile-panel';
  panel.tabIndex = -1;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', `${TURNSTILE_OVERLAY_ID}-title`);
  panel.setAttribute('aria-describedby', `${TURNSTILE_OVERLAY_ID}-detail`);

  const crest = doc.createElement('span');
  crest.className = 'cp-turnstile-crest';
  crest.setAttribute('aria-hidden', 'true');
  const title = doc.createElement('h2');
  title.id = `${TURNSTILE_OVERLAY_ID}-title`;
  const detail = doc.createElement('p');
  detail.id = `${TURNSTILE_OVERLAY_ID}-detail`;
  detail.className = 'cp-turnstile-detail';
  const failedLine = doc.createElement('p');
  failedLine.className = 'cp-turnstile-failed';
  failedLine.setAttribute('role', 'status');
  const container = doc.createElement('div');
  container.className = 'cp-turnstile-widget';

  panel.append(crest, title, detail, failedLine, container);
  root.append(panel);

  const label = (): void => {
    title.textContent = options.translate(NET_I18N_KEYS.turnstileTitle);
    detail.textContent = options.translate(NET_I18N_KEYS.turnstileDetail);
    failedLine.textContent = options.translate(NET_I18N_KEYS.turnstileFailed);
  };
  label();
  const stopRelabel = options.onLanguageChanged(label);

  const applyMotion = (reduced: boolean): void => {
    if (reduced) root.dataset.reduced = '';
    else delete root.dataset.reduced;
  };
  applyMotion(isReducedMotion());
  const stopMotion = onReducedMotionChange(applyMotion);

  let failedTimer: ReturnType<typeof setTimeout> | undefined;
  const show = (state: 'hidden' | 'challenge' | 'failed'): void => {
    clearTimeout(failedTimer);
    root.dataset.state = state;
    const open = state === 'challenge';
    root.inert = state === 'hidden';
    if (open) root.removeAttribute('aria-hidden');
    else root.setAttribute('aria-hidden', state === 'hidden' ? 'true' : 'false');
  };

  doc.head.append(style);
  doc.body.append(root);

  return {
    container,
    challengeShown() {
      if (root.dataset.state === 'challenge') return;
      show('challenge');
      options.feedback('open');
      panel.focus({ preventScroll: true });
    },
    challengeHidden() {
      if (root.dataset.state === 'challenge') show('hidden');
    },
    failed() {
      show('failed');
      options.feedback('deny');
      failedTimer = setTimeout(() => {
        show('hidden');
      }, FAILED_NOTICE_MS);
    },
    dispose() {
      clearTimeout(failedTimer);
      stopRelabel();
      stopMotion();
      root.remove();
      style.remove();
    },
  };
}
