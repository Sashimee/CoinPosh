import './account.css';
import type { Account } from '@coinposh/shared';
import type { AccountClient } from '../../net/index.ts';
import type { UiContext } from '../context.ts';
import { h } from '../dom.ts';
import { isReducedMotion, onReducedMotionChange } from '../motion/reduced.ts';
import { accountT, registerAccountStrings } from './i18n.ts';
import { createPromptCard, type PromptCard } from './prompt.ts';
import { createAccountSection, type AccountSection } from './section.ts';

export interface AccountSurfaceOptions {
  readonly ctx: UiContext;
  readonly bannerSlot: HTMLElement;
  readonly host: HTMLElement;
  readonly slot: HTMLElement;
  readonly client: () => Promise<AccountClient>;
  readonly onAccount: (account: Account) => void;
}

export interface AccountSurface {
  readonly prompt: PromptCard;
  readonly section: AccountSection;
  dispose(): void;
}

/**
 * Everything the player sees of the account: the Settings section, the gentle prompt and the
 * host the progress-choice sheet mounts in. It loads the first time Settings opens or the
 * prompt is due, so a player who never looks pays nothing for it.
 */
export function mountAccountSurface(options: AccountSurfaceOptions): AccountSurface {
  const { ctx } = options;
  registerAccountStrings(ctx.i18n);
  const t = accountT(ctx.i18n);

  const prompt = createPromptCard({
    ctx,
    t,
    onAction: () => {
      ctx.store.setState({ panel: 'settings' });
      requestAnimationFrame(() => {
        section.highlight();
      });
    },
  });
  options.bannerSlot.append(prompt.el);

  const root = h('div', { class: 'cp-ui cp-account-root' });
  options.host.append(root);
  root.classList.toggle('is-reduced', isReducedMotion());
  ctx.own(
    onReducedMotionChange((reduced) => {
      root.classList.toggle('is-reduced', reduced);
    }),
  );

  const section = createAccountSection({
    ctx,
    t,
    client: options.client,
    sheetHost: root,
    onAccount: options.onAccount,
  });
  options.slot.replaceChildren(section.el);

  return {
    prompt,
    section,
    dispose() {
      root.remove();
      prompt.el.remove();
      section.el.remove();
    },
  };
}
