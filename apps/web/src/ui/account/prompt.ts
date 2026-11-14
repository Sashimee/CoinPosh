import { makePressable } from '../components/pressable.ts';
import { feedback, type UiContext } from '../context.ts';
import { h } from '../dom.ts';
import { SPRINGS } from '../motion/spring.ts';
import { SpringValue } from '../motion/value.ts';
import { sealMark } from './brand.ts';
import type { AccountT } from './i18n.ts';
import type { PromptReason } from './model.ts';

/** Long enough to read twice; the card then steps aside on its own, as if "Not now" was tapped. */
export const PROMPT_VISIBLE_MS = 20_000;

export interface PromptCard {
  readonly el: HTMLElement;
  readonly visible: boolean;
  show(reason: PromptReason): void;
  hide(): void;
}

export interface PromptCardOptions {
  readonly ctx: UiContext;
  readonly t: AccountT;
  readonly onAction: () => void;
}

/**
 * The gentle nudge: a small card under the plaque, never a wall. The table stays live around
 * it, nothing waits on it, and it shows once per device.
 */
export function createPromptCard(options: PromptCardOptions): PromptCard {
  const { ctx, t } = options;
  const title = h('p', { class: 'cp-account-prompt-title' });
  const text = h('p', { class: 'cp-account-prompt-text' });
  const action = h('button', {
    class: 'cp-account-button is-primary',
    attrs: { type: 'button', 'data-testid': 'account-prompt-action' },
  });
  const later = h('button', {
    class: 'cp-account-button is-quiet',
    attrs: { type: 'button', 'data-testid': 'account-prompt-later' },
  });
  const el = h(
    'section',
    {
      class: 'cp-panel cp-account-prompt',
      attrs: {
        hidden: '',
        'aria-labelledby': 'cp-account-prompt-title',
        'data-testid': 'account-prompt',
      },
    },
    h('span', { class: 'cp-account-prompt-seal' }, sealMark()),
    h(
      'div',
      { class: 'cp-account-prompt-copy' },
      title,
      text,
      h('div', { class: 'cp-account-prompt-actions' }, action, later),
    ),
  );
  title.id = 'cp-account-prompt-title';

  let reason: PromptReason = 'ascension';
  let visible = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const lift = new SpringValue(1, SPRINGS.bouncy, (value) => {
    el.style.translate = value === 0 ? '' : `0 ${-18 * value}px`;
    el.style.opacity = String(Math.min(1, Math.max(0, 1 - value)));
  });

  ctx.own(
    ctx.loc.bind(() => {
      title.textContent = t('prompt.title');
      text.textContent = t(reason === 'ascension' ? 'prompt.ascension' : 'prompt.playtime');
      action.textContent = t('prompt.action');
      later.textContent = t('prompt.later');
    }),
  );
  makePressable(action, ctx, {
    feedback: 'open',
    onPress: () => {
      hide();
      options.onAction();
    },
  });
  makePressable(later, ctx, { feedback: 'close', onPress: hide });
  ctx.own(() => {
    if (timer !== null) clearTimeout(timer);
  });

  function hide(): void {
    if (!visible) return;
    visible = false;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    void lift.to(1, SPRINGS.snappy).then(() => {
      if (!visible) el.hidden = true;
    });
  }

  return {
    el,
    get visible() {
      return visible;
    },
    show(next) {
      reason = next;
      ctx.loc.refresh();
      visible = true;
      el.hidden = false;
      lift.jump(1);
      // Reduced motion: the spring lands at once, and a CSS opacity transition fades it instead.
      el.getBoundingClientRect();
      void lift.to(0, SPRINGS.bouncy);
      feedback(ctx, 'tick');
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(hide, PROMPT_VISIBLE_MS);
    },
    hide,
  };
}
