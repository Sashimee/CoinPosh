import { cascade } from '@coinposh/economy';
import { comboView } from '../../app/model.ts';
import { watch } from '../../app/store.ts';
import { formatDecimal } from '../../i18n/index.ts';
import { tr, type UiContext } from '../context.ts';
import { h } from '../dom.ts';
import { isReducedMotion } from '../motion/reduced.ts';
import { SPRINGS } from '../motion/spring.ts';
import { SpringValue } from '../motion/value.ts';
import { announcementHoldFor, createRankGate, peakReplay } from './announcementHold.ts';
import { planRankStamp, type StampLayout } from './stampLayout.ts';

const HOLD_MS = 950;
const STAMP_FROM = 1.45;
const TILT_DEG = -3;
const LEAVE_MS = 420;
const FLOURISH_MS = 560;
const SHEEN_MS = 760;
const SHEEN_DELAY_MS = 120;
const SETTLE = 'cubic-bezier(0.2, 0.9, 0.3, 1)';

export interface TierStamp {
  readonly root: HTMLElement;
  /** Re-rests the ribbon whenever the table, the HUD or the meter rails move. */
  place(layout: StampLayout): void;
}

/**
 * The cascade tier name lands as a slim translucent ribbon with gold hairlines when a tier is
 * reached, resting between the Vault and the front half of the coin floor so the coins it
 * celebrates stay in view. While announcements are held it stays down; afterwards the highest
 * rank reached stamps only if the cascade still stands at it, and a stamp leaves early once its
 * cascade ends.
 */
export function createTierStamp(ctx: UiContext): TierStamp {
  const name = h('span', { class: 'cp-stamp-name' });
  const mult = h('span', { class: 'cp-stamp-mult' });
  const flourishes = [
    h('span', { class: 'cp-stamp-flourish', attrs: { 'aria-hidden': 'true' } }),
    h('span', { class: 'cp-stamp-flourish is-under', attrs: { 'aria-hidden': 'true' } }),
  ];
  const sheen = h('span', { class: 'cp-stamp-sheen' });
  const card = h(
    'div',
    { class: 'cp-stamp-card' },
    flourishes[0],
    h('span', { class: 'cp-stamp-line' }, name, mult),
    flourishes[1],
    h('span', { class: 'cp-stamp-gloss', attrs: { 'aria-hidden': 'true' } }, sheen),
  );
  const anchor = h('div', { class: 'cp-stamp-anchor' }, card);
  const layer = h(
    'div',
    { class: 'cp-stamp', attrs: { 'aria-hidden': 'true', 'data-testid': 'hud-tier-stamp' } },
    anchor,
  );

  let layout: StampLayout | null = null;
  const rest = (): void => {
    if (!layout) return;
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    if (width === 0 || height === 0) return;
    const { box, scale } = planRankStamp({ ...layout, card: { width, height } });
    anchor.style.left = `${box.left + box.width / 2}px`;
    anchor.style.top = `${box.top + box.height / 2}px`;
    anchor.style.scale = scale === 1 ? '' : String(scale);
  };
  const flourishRuns: Animation[] = [];
  const cancelFlourish = (): void => {
    for (const running of flourishRuns.splice(0)) running.cancel();
  };
  /** The hairlines draw out from the centre and a gold sheen crosses the ribbon as it lands. */
  const flourish = (): void => {
    cancelFlourish();
    for (const line of flourishes) {
      flourishRuns.push(
        line.animate(
          [
            { scale: '0.12 1', opacity: 0 },
            { scale: '1 1', opacity: 1 },
          ],
          {
            duration: FLOURISH_MS,
            easing: SETTLE,
          },
        ),
      );
    }
    flourishRuns.push(
      sheen.animate([{ translate: '-120% 0' }, { translate: '320% 0' }], {
        duration: SHEEN_MS,
        delay: SHEEN_DELAY_MS,
        easing: 'cubic-bezier(0.45, 0, 0.3, 1)',
        fill: 'backwards',
      }),
    );
  };

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
    cancelFlourish();
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
    rest();
    impact.jump(0);
    if (reduced) cancelFlourish();
    else flourish();
    // Reduced motion has no spring to land on, so the card cross-fades in from the frame at 0.
    if (reduced) card.getBoundingClientRect();
    void impact.to(1);
    if (hideTimer !== null) clearTimeout(hideTimer);
    hideTimer = setTimeout(leave, HOLD_MS);
  };

  const hold = announcementHoldFor(ctx.store);
  const gate = createRankGate(
    hold,
    {
      rise: stamp,
      replay: (peak, live) => {
        if (peakReplay(peak, live) === 'stamp') stamp(peak);
      },
    },
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
        if (rank === 0) leave();
      },
    ),
  );
  ctx.own(() => {
    gate.dispose();
    cancelFlourish();
    if (hideTimer !== null) clearTimeout(hideTimer);
  });
  return {
    root: layer,
    place(next) {
      layout = next;
      rest();
    },
  };
}
