import './session.css';
import type { FeedbackKind } from '../../app/state.ts';
import { h, listen } from '../../ui/dom.ts';
import type { SessionKey } from './i18n.ts';

export type ElsewherePhase = 'hidden' | 'open' | 'busy' | 'failed';

export interface ElsewhereView {
  render(phase: Exclude<ElsewherePhase, 'hidden'>): void;
  /** Plays the exit and takes the overlay off the table. */
  leave(): void;
  dispose(): void;
}

export interface ElsewhereOptions {
  readonly view: ElsewhereView;
  /** Boots the table again here, which takes the lease back from the other tab. */
  readonly retake: () => Promise<void>;
  /** Turned into sound and haptics by the UI feedback layer. */
  readonly feedback: (kind: FeedbackKind) => void;
  /** A retake that failed; the overlay stays up with the button to try again. */
  readonly onRetakeFailed: (error: unknown) => void;
}

export interface ElsewhereOverlay {
  readonly phase: ElsewherePhase;
  /** The table was opened elsewhere: cover it and offer to play here. */
  show(): void;
  /** "Play here". Ignored while a retake is running. */
  press(): void;
  dispose(): void;
}

/** "This table is open elsewhere": what the overlay does, apart from how it is drawn. */
export function createElsewhereOverlay(options: ElsewhereOptions): ElsewhereOverlay {
  const { view, feedback } = options;
  let phase: ElsewherePhase = 'hidden';
  let disposed = false;
  const enter = (next: Exclude<ElsewherePhase, 'hidden'>): void => {
    phase = next;
    view.render(next);
  };
  return {
    get phase() {
      return phase;
    },
    show() {
      if (disposed || phase !== 'hidden') return;
      enter('open');
      feedback('open');
    },
    press() {
      if (disposed || (phase !== 'open' && phase !== 'failed')) return;
      enter('busy');
      feedback('tap');
      options.retake().then(
        () => {
          if (disposed) return;
          phase = 'hidden';
          view.leave();
          feedback('confirm');
        },
        (error: unknown) => {
          if (disposed) return;
          options.onRetakeFailed(error);
          enter('failed');
          feedback('deny');
        },
      );
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      view.dispose();
    },
  };
}

export interface ElsewhereViewOptions {
  readonly host: HTMLElement;
  readonly translate: (key: SessionKey) => string;
  readonly onLanguageChanged: (relabel: () => void) => () => void;
  readonly reducedMotion: () => boolean;
  readonly onReducedMotionChange: (apply: (reduced: boolean) => void) => () => void;
  readonly onPress: () => void;
}

/** The exit runs on CSS; this only bounds how long the overlay waits for its end. */
const LEAVE_CAP_MS = 700;

/**
 * The overlay drawn over the frozen table: a lacquer card with a gold seal, the title, a line
 * that says the coins are safe, and the "Play here" button, which takes the focus. A modal
 * dialog while it is up, so the table under it hears nothing.
 */
export function mountElsewhereView(options: ElsewhereViewOptions): ElsewhereView {
  const { host, translate: t } = options;
  const title = h('h2', { class: 'cp-elsewhere-title', attrs: { id: 'cp-elsewhere-title' } });
  const body = h('p', { class: 'cp-elsewhere-body', attrs: { id: 'cp-elsewhere-body' } });
  const status = h('p', {
    class: 'cp-elsewhere-status',
    attrs: { role: 'status', 'aria-live': 'polite' },
  });
  const label = h('span', { class: 'cp-elsewhere-label' });
  const action = h(
    'button',
    {
      class: 'cp-elsewhere-action',
      attrs: { type: 'button', 'data-testid': 'table-elsewhere-play-here' },
    },
    h('span', { class: 'cp-elsewhere-shine', attrs: { 'aria-hidden': 'true' } }),
    label,
  );
  const seal = h(
    'span',
    { class: 'cp-elsewhere-seal', attrs: { 'aria-hidden': 'true' } },
    h('span', { class: 'cp-elsewhere-seal-coin' }),
  );
  const card = h('div', { class: 'cp-elsewhere-card' }, seal, title, body, status, action);
  const root = h(
    'div',
    {
      class: 'cp-elsewhere',
      attrs: {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': title.id,
        'aria-describedby': body.id,
        'data-testid': 'table-elsewhere',
      },
    },
    card,
  );
  root.hidden = true;
  let phase: Exclude<ElsewherePhase, 'hidden'> = 'open';
  let leaveTimer: ReturnType<typeof setTimeout> | null = null;

  const relabel = (): void => {
    title.textContent = t('elsewhere.title');
    body.textContent = t('elsewhere.body');
    label.textContent = t('elsewhere.action');
    status.textContent =
      phase === 'busy' ? t('elsewhere.busy') : phase === 'failed' ? t('elsewhere.failed') : '';
  };
  const setMotion = (reduced: boolean): void => {
    root.dataset.motion = reduced ? 'reduced' : 'full';
  };
  const finishLeave = (): void => {
    if (leaveTimer !== null) clearTimeout(leaveTimer);
    leaveTimer = null;
    if (root.dataset.phase !== 'leaving') return;
    root.hidden = true;
    delete root.dataset.phase;
  };

  setMotion(options.reducedMotion());
  host.append(root);
  const offs = [
    options.onLanguageChanged(relabel),
    options.onReducedMotionChange(setMotion),
    listen(action, 'click', () => {
      options.onPress();
    }),
    listen(root, 'keydown', (event) => {
      // The button is the dialog's only control, so Tab keeps the focus on it.
      if (event.key === 'Tab') {
        event.preventDefault();
        action.focus();
      }
    }),
    listen(root, 'animationend', (event) => {
      if (event.target === root) finishLeave();
    }),
  ];

  return {
    render(next) {
      phase = next;
      if (leaveTimer !== null) clearTimeout(leaveTimer);
      leaveTimer = null;
      root.hidden = false;
      root.dataset.phase = next;
      action.disabled = next === 'busy';
      action.setAttribute('aria-busy', String(next === 'busy'));
      relabel();
      if (next !== 'busy') action.focus({ preventScroll: true });
    },
    leave() {
      root.dataset.phase = 'leaving';
      action.disabled = true;
      leaveTimer = setTimeout(finishLeave, LEAVE_CAP_MS);
    },
    dispose() {
      for (const off of offs) off();
      if (leaveTimer !== null) clearTimeout(leaveTimer);
      root.remove();
    },
  };
}
