import { cascade } from '../../app/economy.ts';
import { comboView } from '../../app/model.ts';
import { watch } from '../../app/store.ts';
import { formatDecimal } from '../../i18n/index.ts';
import { tr, type UiContext } from '../context.ts';
import { h } from '../dom.ts';
import { isReducedMotion } from '../motion/reduced.ts';
import { SPRINGS } from '../motion/spring.ts';
import { SpringValue } from '../motion/value.ts';

const HOLD_MS = 950;
const STAMP_FROM = 1.9;
const TILT_DEG = -7;

/** The cascade tier name stamps onto the screen with a serif flourish when a tier is reached. */
export function createTierStamp(ctx: UiContext): HTMLElement {
  const name = h('span', { class: 'cp-stamp-name' });
  const mult = h('span', { class: 'cp-stamp-mult' });
  const card = h(
    'div',
    { class: 'cp-stamp-card' },
    h('span', { class: 'cp-stamp-flourish', attrs: { 'aria-hidden': 'true' } }),
    name,
    mult,
    h('span', { class: 'cp-stamp-flourish is-under', attrs: { 'aria-hidden': 'true' } }),
  );
  const layer = h(
    'div',
    { class: 'cp-stamp', attrs: { 'aria-hidden': 'true', 'data-testid': 'hud-tier-stamp' } },
    card,
  );

  const impact = new SpringValue(0, SPRINGS.bouncy, (value) => {
    const scale = STAMP_FROM + (1 - STAMP_FROM) * value;
    card.style.scale = String(scale);
    card.style.rotate = `${TILT_DEG * (1 - value)}deg`;
    card.style.opacity = String(Math.min(1, Math.max(0, value * 1.6)));
  });
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  const stamp = (rank: number): void => {
    const tier = cascade.tiers[rank - 1];
    if (!tier) return;
    name.textContent = tr(ctx, `combo.tier.${tier.id}`);
    mult.textContent = tr(ctx, 'combo.multiplier', {
      value: formatDecimal(tier.multiplier, ctx.i18n.language),
    });
    layer.dataset.tier = tier.id;
    layer.classList.remove('is-leaving');
    layer.classList.add('is-visible');
    layer.classList.toggle('is-reduced', isReducedMotion());
    impact.jump(0);
    void impact.to(1);
    if (hideTimer !== null) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      layer.classList.add('is-leaving');
      hideTimer = setTimeout(() => {
        layer.classList.remove('is-visible', 'is-leaving');
        hideTimer = null;
      }, 420);
    }, HOLD_MS);
  };

  ctx.own(
    watch(
      ctx.store,
      (s) => comboView(s.cascadeCount, cascade).rank,
      (rank, previous) => {
        if (previous !== undefined && rank > previous) stamp(rank);
      },
    ),
  );
  ctx.own(() => {
    if (hideTimer !== null) clearTimeout(hideTimer);
  });
  return layer;
}
