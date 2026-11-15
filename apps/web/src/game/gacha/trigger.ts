import type { UiApp } from '../../app/index.ts';
import { formatInteger } from '../../i18n/index.ts';
import { makePressable } from '../../ui/components/pressable.ts';
import type { UiContext } from '../../ui/context.ts';
import { fromMarkup, h } from '../../ui/dom.ts';
import { Localizer } from '../../ui/localize.ts';
import { gachaKey } from './i18n.ts';

const CAPSULE_ICON =
  '<svg class="cp-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="9.5" r="6" fill="currentColor" fill-opacity=".16"/><path d="M6 9.5h12M9.5 6.2a3.6 3.6 0 0 1 2.5-.9"/><path d="M8 15.2 7 20.5h10l-1-5.3M10.5 18h3"/></svg>';

export interface GachaTriggerOptions {
  readonly ui: Pick<UiApp, 'store' | 'bus' | 'i18n'>;
  readonly dock: HTMLElement;
  readonly onPress: () => void;
}

export interface GachaTrigger {
  readonly el: HTMLButtonElement;
  /** The badge counts the Tickets the server last reported. */
  update(tickets: number | null): void;
  dispose(): void;
}

/** The dock's door to the capsule machine, with a badge counting the player's Tickets. */
export function mountGachaTrigger(options: GachaTriggerOptions): GachaTrigger {
  const disposers: (() => void)[] = [];
  const loc = new Localizer(options.ui.i18n);
  const ctx: UiContext = { ...options.ui, loc, own: (dispose) => disposers.push(dispose) };
  const badge = h('span', {
    class: 'cp-badge',
    attrs: { 'data-testid': 'dock-gacha-badge', 'aria-hidden': 'true', hidden: '' },
  });
  const el = h(
    'button',
    {
      class: 'cp-dock-button cp-panel',
      attrs: { type: 'button', 'data-testid': 'dock-gacha', 'aria-haspopup': 'dialog' },
    },
    fromMarkup(CAPSULE_ICON),
    badge,
  );
  let tickets: number | null = null;

  const paint = () => {
    const label = ctx.i18n.t(gachaKey('open'));
    el.title = label;
    el.setAttribute('aria-label', label);
    badge.hidden = tickets === null || tickets === 0;
    badge.textContent = tickets === null ? '' : formatInteger(tickets, ctx.i18n.language);
  };
  disposers.push(loc.bind(paint));
  makePressable(el, ctx, { feedback: 'open', onPress: options.onPress });
  const safes = options.dock.querySelector(':scope > [data-testid="dock-safes"]');
  if (safes) safes.after(el);
  else options.dock.append(el);

  return {
    el,
    update(next) {
      tickets = next;
      paint();
    },
    dispose() {
      for (const off of disposers.splice(0).reverse()) off();
      loc.dispose();
      el.remove();
    },
  };
}
