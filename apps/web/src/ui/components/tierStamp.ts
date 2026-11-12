import { cascade, type CascadeTierDef } from '@coinposh/economy';
import { comboView } from '../../app/model.ts';
import { watch } from '../../app/store.ts';
import { formatDecimal } from '../../i18n/index.ts';
import { tr, type UiContext } from '../context.ts';
import { h } from '../dom.ts';
import { isReducedMotion } from '../motion/reduced.ts';
import { SPRINGS } from '../motion/spring.ts';
import { SpringValue } from '../motion/value.ts';
import { announcementHoldFor, createRankGate, peakReplay } from './announcementHold.ts';
import { announcementSlotFor, type AnnouncementSlot } from './announcementSlot.ts';

/** How long a stamp stays up before it leaves, unless its cascade ends first. */
export const STAMP_HOLD_MS = 950;
/** The leave animation; the stamp keeps the announcement slot until it ends. */
export const STAMP_LEAVE_MS = 420;
const STAMP_FROM = 1.9;
const TILT_DEG = -7;

export interface StampView {
  show(tier: CascadeTierDef): void;
  leave(): void;
  /** The leave animation has ended. */
  hide(): void;
  /** Takes the card off this frame, with no animation. */
  cut(): void;
}

export interface StampSchedule {
  readonly showing: boolean;
  /** Feeds the rank the cascade stands at. */
  update(rank: number): void;
  dispose(): void;
}

/**
 * When the tier stamp is on screen. A stamp claims the slot's `rank-stamp` from the moment it
 * lands until its leave animation ends, so the upgrade nudge waits under it. While the cinematic
 * hold or the crate hint outranks it, it stays down, and a stamp already up is cut away and gives
 * the slot back at once. Afterwards the highest rank reached stamps only if the cascade still
 * stands at it, and a stamp leaves early once its cascade ends.
 */
export function scheduleTierStamp(
  slot: AnnouncementSlot,
  view: StampView,
  initialRank = 0,
): StampSchedule {
  let visible = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let releaseSlot: (() => void) | null = null;
  const clear = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const letGo = (): void => {
    releaseSlot?.();
    releaseSlot = null;
  };

  const leave = (): void => {
    if (!visible) return;
    view.leave();
    clear();
    timer = setTimeout(() => {
      timer = null;
      visible = false;
      view.hide();
      letGo();
    }, STAMP_LEAVE_MS);
  };

  // Being outranked means a cinematic or the crate hint takes the screen this frame, so even the
  // reduced-motion fade would show the card over it: the stamp cuts away instead.
  const dismiss = (): void => {
    if (!visible) return;
    clear();
    visible = false;
    view.cut();
    letGo();
  };

  const stamp = (rank: number): void => {
    const tier = cascade.tiers[rank - 1];
    if (!tier) return;
    releaseSlot ??= slot.claim('rank-stamp');
    visible = true;
    view.show(tier);
    clear();
    timer = setTimeout(leave, STAMP_HOLD_MS);
  };

  const quiet = slot.quietFor('rank-stamp');
  const gate = createRankGate(
    quiet,
    {
      rise: stamp,
      replay: (peak, live) => {
        if (peakReplay(peak, live) === 'stamp') stamp(peak);
      },
    },
    initialRank,
  );
  const stopQuiet = quiet.onChange((held) => {
    if (held) dismiss();
  });

  return {
    get showing() {
      return visible;
    },
    update(rank) {
      gate.update(rank);
      if (rank === 0) leave();
    },
    dispose() {
      stopQuiet();
      gate.dispose();
      clear();
      letGo();
    },
  };
}

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

  const schedule = scheduleTierStamp(
    announcementSlotFor(announcementHoldFor(ctx.store)),
    {
      show(tier) {
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
      },
      leave() {
        layer.classList.add('is-leaving');
      },
      hide() {
        layer.classList.remove('is-visible', 'is-leaving');
      },
      cut() {
        impact.jump(0);
        layer.classList.remove('is-visible', 'is-leaving');
      },
    },
    comboView(ctx.store.getState().cascadeCount, cascade).rank,
  );
  ctx.own(
    watch(
      ctx.store,
      (s) => comboView(s.cascadeCount, cascade).rank,
      (rank) => {
        schedule.update(rank);
      },
    ),
  );
  ctx.own(() => {
    schedule.dispose();
  });
  return layer;
}
