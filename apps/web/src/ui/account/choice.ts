import type { IdentityProvider, SaveSummary } from '@coinposh/shared';
import { venueKey } from '../../game/ascension/i18n.ts';
import { formatInteger } from '../../i18n/index.ts';
import type { SessionSwap, SignInOutcome } from '../../net/index.ts';
import { makePressable } from '../components/pressable.ts';
import { Odometer } from '../components/odometer.ts';
import { feedback, type UiContext } from '../context.ts';
import { h, listen, restartAnimation } from '../dom.ts';
import { icon } from '../icons.ts';
import { createSheet } from '../panels/sheet.ts';
import type { AccountT } from './i18n.ts';
import { accountProblem, problemKey, relativeWhen, type AccountProblem } from './model.ts';

export type ChoiceOutcome = Extract<SignInOutcome, { kind: 'choice' }>;

export type ChoiceResult =
  { readonly kind: 'account'; readonly swap: SessionSwap } | { readonly kind: 'guest' };

type Side = 'guest' | 'account';

export interface ChoiceSheet {
  readonly el: HTMLElement;
  /** Settles once the player confirmed a save; closing the sheet keeps this device's save. */
  choose(
    outcome: ChoiceOutcome,
    provider: IdentityProvider,
    trigger: HTMLElement,
  ): Promise<ChoiceResult>;
}

interface Card {
  readonly side: Side;
  readonly el: HTMLButtonElement;
  readonly title: HTMLElement;
  readonly venue: HTMLElement;
  readonly goldBars: Odometer;
  readonly coins: Odometer;
  readonly played: HTMLElement;
}

/**
 * The two saves side by side: venue, Gold Bars and coins, as the server summarised them. Saves
 * are never merged, nothing is preselected, and the choice takes an explicit confirm.
 */
export function createChoiceSheet(ctx: UiContext, t: AccountT): ChoiceSheet {
  const language = () => ctx.i18n.language;
  const cards = (['guest', 'account'] as const).map((side) => card(side));
  const group = h(
    'div',
    { class: 'cp-account-choice-cards', attrs: { role: 'radiogroup' } },
    ...cards.map((c) => c.el),
  );
  const warning = h('p', {
    class: 'cp-account-choice-warning',
    attrs: { 'aria-live': 'polite', 'data-testid': 'account-choice-warning' },
  });
  const confirm = h('button', {
    class: 'cp-account-button is-primary',
    attrs: { type: 'button', 'aria-disabled': 'true', 'data-testid': 'account-choice-confirm' },
  });
  const body = h('div', { class: 'cp-account-choice' }, group, warning, confirm);

  let outcome: ChoiceOutcome | null = null;
  let provider: IdentityProvider = 'google';
  let picked: Side | null = null;
  let busy = false;
  let problem: AccountProblem | null = null;
  let settle: ((result: ChoiceResult) => void) | null = null;

  const sheet = createSheet(ctx, {
    id: 'account-choice',
    title: () => t('choice.title'),
    subtitle: () => t('choice.subtitle'),
    body,
    onRequestClose: () => {
      if (busy || !outcome) return;
      outcome.keepGuest();
      finish({ kind: 'guest' });
    },
  });

  ctx.loc.attr(group, 'aria-label', () => t('choice.options'));
  ctx.loc.bind(paint);

  for (const c of cards) {
    makePressable(c.el, ctx, {
      feedback: 'toggle',
      onPress: () => {
        pick(c.side);
      },
      enabled: () => !busy,
    });
  }
  ctx.own(
    listen(group, 'keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      if (busy) return;
      const next: Side = picked === 'guest' ? 'account' : 'guest';
      feedback(ctx, 'toggle');
      pick(next);
      cards.find((c) => c.side === next)?.el.focus();
    }),
  );
  makePressable(confirm, ctx, {
    feedback: 'confirm',
    onPress: () => {
      void commit();
    },
  });

  function card(side: Side): Card {
    const title = h('span', { class: 'cp-account-choice-title' });
    const check = h('span', { class: 'cp-account-choice-check', attrs: { 'aria-hidden': 'true' } });
    const venue = h('span', { class: 'cp-account-choice-venue' });
    const goldBars = new Odometer();
    const coins = new Odometer();
    const played = h('span', { class: 'cp-account-choice-played' });
    const stat = (iconName: 'goldBar' | 'coin', odometer: Odometer, label: () => string) => {
      const name = h('span', { class: 'cp-account-choice-label' });
      ctx.loc.text(name, label);
      return h('span', { class: 'cp-account-choice-stat' }, icon(iconName), odometer.el, name);
    };
    const venueLabel = h('span', { class: 'cp-account-choice-label' });
    ctx.loc.text(venueLabel, () => t('choice.venue'));
    const el = h(
      'button',
      {
        class: 'cp-account-choice-card',
        attrs: {
          type: 'button',
          role: 'radio',
          'aria-checked': 'false',
          'data-testid': `account-choice-${side}`,
        },
      },
      h('span', { class: 'cp-account-choice-head' }, title, check),
      venueLabel,
      venue,
      stat('goldBar', goldBars, () => t('choice.goldBars')),
      stat('coin', coins, () => t('choice.coins')),
      played,
    );
    return { side, el, title, venue, goldBars, coins, played };
  }

  function saveOf(side: Side): SaveSummary | null {
    return outcome ? outcome.choice[side] : null;
  }

  function saveName(side: Side): string {
    return side === 'guest'
      ? t('choice.device')
      : t('choice.account', { provider: t(`provider.${provider}`) });
  }

  function paint(): void {
    const now = Date.now();
    for (const c of cards) {
      const save = saveOf(c.side);
      const on = picked === c.side;
      c.el.setAttribute('aria-checked', String(on));
      c.el.tabIndex = on || (picked === null && c.side === 'guest') ? 0 : -1;
      c.el.classList.toggle('is-picked', on);
      c.title.textContent = saveName(c.side);
      if (!save) continue;
      const venue = ctx.i18n.t(venueKey(save.venue));
      const when = relativeWhen(save.lastPlayedAt, now, language());
      c.venue.textContent = venue;
      c.played.textContent = t('choice.lastPlayed', { when });
      c.el.setAttribute(
        'aria-label',
        t('choice.summary', {
          save: saveName(c.side),
          venue,
          goldBars: formatInteger(save.goldBars, language()),
          coins: formatInteger(save.coins, language()),
          when,
        }),
      );
    }
    warning.classList.toggle('is-warn', picked === 'account' || problem !== null);
    warning.textContent = problem
      ? t(problemKey(problem))
      : picked === null
        ? t('choice.pick')
        : t(picked === 'guest' ? 'choice.warnDevice' : 'choice.warnAccount');
    confirm.setAttribute('aria-disabled', String(picked === null || busy));
    confirm.classList.toggle('is-busy', busy);
    confirm.textContent = busy
      ? t('choice.busy')
      : t(picked === 'account' ? 'choice.keepAccount' : 'choice.keepDevice');
  }

  function rollIn(): void {
    for (const c of cards) {
      const save = saveOf(c.side);
      if (!save) continue;
      c.goldBars.jump(formatInteger(0, language()));
      c.coins.jump(formatInteger(0, language()));
      c.goldBars.set(formatInteger(save.goldBars, language()), 1);
      c.coins.set(formatInteger(save.coins, language()), 1);
    }
  }

  function pick(side: Side): void {
    if (picked === side) return;
    picked = side;
    problem = null;
    paint();
    const c = cards.find((each) => each.side === side);
    if (c) restartAnimation(c.el, 'is-landing');
  }

  async function commit(): Promise<void> {
    if (!outcome || picked === null || busy) return;
    if (picked === 'guest') {
      outcome.keepGuest();
      finish({ kind: 'guest' });
      return;
    }
    const current = outcome;
    const attempt = problem?.kind === 'swapFailed' ? problem.retry : () => current.keepAccount();
    busy = true;
    problem = null;
    paint();
    try {
      const swap = await attempt();
      busy = false;
      finish({ kind: 'account', swap });
    } catch (error) {
      busy = false;
      problem = accountProblem(error);
      if (problem.kind === 'failed')
        console.error('CoinPosh account: switching saves failed.', error);
      feedback(ctx, 'deny');
      paint();
      restartAnimation(warning, 'is-landing');
    }
  }

  function finish(result: ChoiceResult): void {
    const done = settle;
    settle = null;
    outcome = null;
    sheet.close();
    done?.(result);
  }

  return {
    el: sheet.el,
    choose(next, nextProvider, trigger) {
      if (settle) {
        return Promise.reject(
          new Error('CoinPosh account: a save choice is already open; settle it before the next.'),
        );
      }
      outcome = next;
      provider = nextProvider;
      picked = null;
      problem = null;
      busy = false;
      paint();
      sheet.open(trigger);
      rollIn();
      return new Promise<ChoiceResult>((resolve) => {
        settle = resolve;
      });
    },
  };
}
