import { cascade } from '@coinposh/economy';
import { comboView } from '../../app/model.ts';
import { watch } from '../../app/store.ts';
import { formatDecimal } from '../../i18n/index.ts';
import { tr, type UiContext } from '../context.ts';
import { h } from '../dom.ts';
import { isReducedMotion } from '../motion/reduced.ts';
import { SPRINGS } from '../motion/spring.ts';
import { SpringValue } from '../motion/value.ts';
import { announcementHoldFor, createRankGate } from './announcementHold.ts';

const HOLD_MS = 950;
const STAMP_FROM = 1.9;
const TILT_DEG = -7;
const LEAVE_MS = 420;

/**
 * The cascade tier name stamps onto the screen with a serif flourish when a tier is reached.
 * While announcements are held it stays down, and only the highest rank reached stamps after.
 */
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

  const leave = (): void => {
    if (!layer.classList.contains('is-visible')) return;
    layer.classList.add('is-leaving');
    if (hideTimer !== null) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      layer.classList.remove('is-visible', 'is-leaving');
      hideTimer = null;
    }, LEAVE_MS);
  };

  // A hold means a cinematic is taking the screen this frame, so even the reduced-motion fade
  // would show the card over it: the stamp cuts away instead.
  const dismiss = (): void => {
    if (hideTimer !== null) clearTimeout(hideTimer);
    hideTimer = null;
    impact.jump(0);
    layer.classList.remove('is-visible', 'is-leaving');
  };

  const stamp = (rank: number): void => {
    const tier = cascade.tiers[rank - 1];
    if (!tier) return;
    name.textContent = tr(ctx, `combo.tier.${tier.id}`);
    mult.textContent = tr(ctx, 'combo.multiplier', {
      value: formatDecimal(tier.multiplier, ctx.i18n.language),
    });
    const reduced = isReducedMotion();
    layer.dataset.tier = tier.id;
    layer.classList.remove('is-leaving');
    layer.classList.add('is-visible');
    layer.classList.toggle('is-reduced', reduced);
    impact.jump(0);
    // Reduced motion has no spring to land on, so the card cross-fades in from the frame at 0.
    if (reduced) card.getBoundingClientRect();
    void impact.to(1);
    if (hideTimer !== null) clearTimeout(hideTimer);
    hideTimer = setTimeout(leave, HOLD_MS);
  };

  const hold = announcementHoldFor(ctx.store);
  const gate = createRankGate(
    hold,
    { rise: stamp, replay: stamp },
    comboView(ctx.store.getState().cascadeCount, cascade).rank,
  );
  ctx.own(
    hold.onChange((held) => {
      if (held) dismiss();
    }),
  );
  ctx.own(
    watch(
      ctx.store,
      (s) => comboView(s.cascadeCount, cascade).rank,
      (rank) => {
        gate.update(rank);
      },
    ),
  );
  ctx.own(() => {
    gate.dispose();
    if (hideTimer !== null) clearTimeout(hideTimer);
  });
  return layer;
}
