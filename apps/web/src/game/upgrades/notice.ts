import './upgrades.css';
import { h, restartAnimation } from '../../ui/dom.ts';

export const NOTICE_MS = 2_600;

export interface UpgradeNotice {
  show(message: string): void;
  dispose(): void;
}

/** A polite status line under the HUD banner slot; screen readers hear it too. */
export function createUpgradeNotice(host: HTMLElement): UpgradeNotice {
  const el = h('p', {
    class: 'cp-upgrade-notice',
    attrs: { role: 'status', 'aria-live': 'polite', 'data-testid': 'upgrade-notice' },
  });
  el.hidden = true;
  host.append(el);
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    show(message) {
      el.textContent = message;
      el.hidden = false;
      restartAnimation(el, 'is-shown');
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        el.hidden = true;
        el.classList.remove('is-shown');
        timer = null;
      }, NOTICE_MS);
    },
    dispose() {
      if (timer !== null) clearTimeout(timer);
      el.remove();
    },
  };
}
