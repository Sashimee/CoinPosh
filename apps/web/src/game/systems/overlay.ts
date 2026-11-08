import './systems.css';
import { h, restartAnimation } from '../../ui/dom.ts';
import { isReducedMotion, onReducedMotionChange } from '../../ui/motion/reduced.ts';
import type { PourView } from './core.ts';

export const STAMP_MS = 1_400;
/** The gauge runs to this many beat lengths, so the marker sits two thirds of the way along. */
const GAUGE_BEATS = 1.5;

export type StampTone = 'perfect' | 'neutral' | 'warn';

export interface SystemsOverlay {
  render(aimPx: number, pressed: boolean, pour: PourView): void;
  stamp(message: string, tone: StampTone): void;
  dispose(): void;
}

export interface OverlayLabels {
  readonly aim: string;
  readonly gauge: string;
}

/**
 * The aim reticle, the pour gauge with its beat marker, and a stamp for grades and notices.
 * `host` is the UI host, whose theme tokens the overlay paints with.
 */
export function createSystemsOverlay(host: HTMLElement, labels: OverlayLabels): SystemsOverlay {
  const reticle = h('div', {
    class: 'cp-sys-reticle',
    attrs: { role: 'img', 'aria-label': labels.aim, 'data-testid': 'aim-reticle' },
  });
  const fill = h('div', { class: 'cp-sys-pour-fill' });
  const marker = h('div', { class: 'cp-sys-pour-marker' });
  marker.style.left = `${(100 / GAUGE_BEATS).toFixed(3)}%`;
  const gauge = h(
    'div',
    {
      class: 'cp-sys-pour',
      attrs: {
        role: 'meter',
        'aria-label': labels.gauge,
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'data-testid': 'pour-gauge',
      },
    },
    fill,
    marker,
  );
  const stampEl = h('p', {
    class: 'cp-sys-stamp',
    attrs: { role: 'status', 'aria-live': 'polite', 'data-testid': 'systems-stamp' },
  });
  stampEl.hidden = true;
  const root = h('div', { class: 'cp-sys' }, reticle, gauge, stampEl);
  // First child, so the HUD panels paint over the reticle and gauge.
  host.prepend(root);

  const applyMotion = (reduced: boolean): void => {
    root.dataset.motion = reduced ? 'reduced' : 'full';
  };
  applyMotion(isReducedMotion());
  const offMotion = onReducedMotionChange(applyMotion);

  let stampTimer: ReturnType<typeof setTimeout> | null = null;
  let lastX = Number.NaN;
  let lastPressed = false;
  let lastPouring = false;
  let lastWindow = false;
  let lastPercent = -1;

  return {
    render(aimPx, pressed, pour) {
      if (aimPx !== lastX || pressed !== lastPressed) {
        lastX = aimPx;
        lastPressed = pressed;
        reticle.classList.toggle('is-pressed', pressed);
        reticle.style.transform = `translateX(${aimPx.toFixed(1)}px)${pressed ? ' scale(0.82)' : ''}`;
      }
      if (pour.pouring !== lastPouring) {
        lastPouring = pour.pouring;
        gauge.classList.toggle('is-pouring', pour.pouring);
      }
      if (pour.inWindow !== lastWindow) {
        lastWindow = pour.inWindow;
        gauge.classList.toggle('is-window', pour.inWindow);
      }
      const share = Math.min(1, pour.progress / GAUGE_BEATS);
      const percent = Math.round(share * 100);
      if (percent !== lastPercent) {
        lastPercent = percent;
        fill.style.transform = `scaleX(${share.toFixed(3)})`;
        gauge.setAttribute('aria-valuenow', String(percent));
      }
    },
    stamp(message, tone) {
      stampEl.textContent = message;
      stampEl.dataset.tone = tone;
      stampEl.hidden = false;
      restartAnimation(stampEl, 'is-shown');
      if (stampTimer !== null) clearTimeout(stampTimer);
      stampTimer = setTimeout(() => {
        stampEl.hidden = true;
        stampEl.classList.remove('is-shown');
        stampTimer = null;
      }, STAMP_MS);
    },
    dispose() {
      if (stampTimer !== null) clearTimeout(stampTimer);
      offMotion();
      root.remove();
    },
  };
}
