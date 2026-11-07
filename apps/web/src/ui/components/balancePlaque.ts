import { watch } from '../../app/store.ts';
import { formatBalance, formatInteger } from '../../i18n/index.ts';
import { tr, type UiContext } from '../context.ts';
import { h, restartAnimation } from '../dom.ts';
import { icon } from '../icons.ts';
import { SPRINGS } from '../motion/spring.ts';
import { SpringValue } from '../motion/value.ts';
import { Odometer } from './odometer.ts';

const POP_VELOCITY = 0.9;

export function createBalancePlaque(ctx: UiContext): HTMLElement {
  const odometer = new Odometer();
  const spoken = h('span', { class: 'cp-sr-only' });
  const label = h('span', { class: 'cp-plaque-label' });
  const provisional = h('span', { class: 'cp-plaque-provisional' });
  const barsValue = h('span', { class: 'cp-chip-value' });
  const bars = h(
    'span',
    { class: 'cp-chip cp-chip-bars', attrs: { hidden: '' } },
    icon('goldBar'),
    barsValue,
  );
  const glint = h('span', { class: 'cp-glint', attrs: { 'aria-hidden': 'true' } });
  const amount = h('span', { class: 'cp-plaque-amount' }, icon('coin'), odometer.el);
  const plaque = h(
    'div',
    { class: 'cp-plaque cp-panel', attrs: { 'data-testid': 'hud-balance' } },
    glint,
    label,
    amount,
    provisional,
    spoken,
  );
  const wrap = h('div', { class: 'cp-plaque-wrap' }, plaque, bars);

  const pop = new SpringValue(1, SPRINGS.pop, (value) => {
    plaque.style.scale = value === 1 ? '' : String(value);
  });

  ctx.loc.text(label, () => tr(ctx, 'hud.vault'));
  ctx.loc.text(provisional, () => tr(ctx, 'hud.provisional'));

  let shown: number | null = null;
  const show = (coins: number, animate: boolean): void => {
    const language = ctx.i18n.language;
    const text = formatBalance(coins, language);
    if (!animate || shown === null) odometer.jump(text);
    else if (coins !== shown) odometer.set(text, coins > shown ? 1 : -1);
    if (animate && shown !== null && coins > shown) {
      pop.kick(POP_VELOCITY);
      restartAnimation(plaque, 'is-gaining');
    }
    shown = coins;
    spoken.textContent = tr(ctx, 'hud.balanceAria', {
      value: tr(ctx, 'currency.coins', { count: coins, value: formatInteger(coins, language) }),
    });
  };

  ctx.own(
    watch(
      ctx.store,
      (s) => s.coins,
      (coins, previous) => {
        show(coins, previous !== undefined);
      },
    ),
  );
  ctx.own(
    ctx.loc.bind(() => {
      show(ctx.store.getState().coins, false);
    }),
  );
  ctx.own(
    watch(
      ctx.store,
      (s) => s.provisional,
      (value) => {
        plaque.classList.toggle('is-provisional', value);
      },
    ),
  );
  const showBars = (): void => {
    const count = ctx.store.getState().goldBars;
    bars.hidden = count <= 0;
    barsValue.textContent = formatBalance(count, ctx.i18n.language);
    bars.setAttribute(
      'aria-label',
      tr(ctx, 'hud.goldBarsAria', { value: formatInteger(count, ctx.i18n.language) }),
    );
  };
  ctx.own(watch(ctx.store, (s) => s.goldBars, showBars));
  ctx.own(ctx.loc.bind(showBars));
  return wrap;
}
