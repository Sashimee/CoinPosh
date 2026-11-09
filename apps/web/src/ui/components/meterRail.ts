import type { UiContext } from '../context.ts';
import { h } from '../dom.ts';
import { isReducedMotion } from '../motion/reduced.ts';
import { SPRINGS } from '../motion/spring.ts';
import { SpringValue } from '../motion/value.ts';
import { cardReveal, railBox, type RailSide, type RailSlot } from './railLayout.ts';

/** How far the card's contents rise as they are revealed; they never slide across the spine. */
const RISE_PX = 6;

export interface MeterRail {
  readonly root: HTMLElement;
  readonly side: RailSide;
  /** Opens the rail into its card, or closes it after `linger` ms (cancelled by a reopen). */
  setOpen(open: boolean, linger?: number): void;
  /** Moves the rail to its slot in viewport px, relative to `origin`; null hides it. */
  place(slot: RailSlot | null, origin: { left: number; top: number }): void;
}

export interface MeterRailOptions {
  readonly side: RailSide;
  readonly className: string;
  readonly testId: string;
  /** The always-visible gauge inside the rail. */
  readonly spine: Element;
  /** What the card reveals beside the spine when open. */
  readonly card: HTMLElement;
}

/**
 * A side meter that rests as a slim rail against the screen edge and morphs, by width alone,
 * into a card when it has news. The morph is a spring, and the card's contents only fade and rise
 * in once the box has uncovered them; under reduced motion the whole card cross-fades in.
 */
export function createMeterRail(ctx: UiContext, options: MeterRailOptions): MeterRail {
  const card = h('span', { class: 'cp-rail-card' }, options.card);
  const root = h(
    'div',
    {
      class: `cp-rail ${options.className}`,
      attrs: { 'data-side': options.side, 'data-testid': options.testId, 'data-open': 'false' },
    },
    h('span', { class: 'cp-rail-spine' }, options.spine),
    card,
  );
  root.hidden = true;
  let slot: RailSlot | null = null;
  let origin = { left: 0, top: 0 };
  let wanted = false;
  let linger: ReturnType<typeof setTimeout> | undefined;
  /** How far the contents' field-side edge sits inside the open card, in px. */
  let inset = 0;

  const paint = (open: number): void => {
    if (!slot) return;
    const box = railBox(slot, open);
    root.style.left = `${box.left - origin.left}px`;
    root.style.top = `${box.top - origin.top}px`;
    root.style.width = `${box.width}px`;
    root.style.height = `${box.height}px`;
    const reveal = slot.card ? cardReveal(box.width, slot.card.width, inset) : 0;
    card.style.opacity = String(reveal);
    card.style.translate = reveal === 1 ? '' : `0 ${(1 - reveal) * RISE_PX}px`;
  };
  const openness = new SpringValue(0, SPRINGS.snappy, (value) => {
    paint(value);
  });

  const apply = (): void => {
    const open = wanted && slot !== null && slot.card !== null;
    if (root.dataset.open === String(open)) return;
    root.dataset.open = String(open);
    root.classList.toggle('is-open', open);
    if (isReducedMotion()) {
      root.classList.add('is-swapping');
      root.getBoundingClientRect();
      root.classList.remove('is-swapping');
    }
    void openness.to(open ? 1 : 0, open ? SPRINGS.snappy : SPRINGS.sheet);
  };

  const measure = (): void => {
    const frame = card.getBoundingClientRect();
    const content = options.card.getBoundingClientRect();
    if (frame.width === 0) return;
    const border = root.clientLeft;
    inset =
      border + (options.side === 'left' ? frame.right - content.right : content.left - frame.left);
    paint(openness.value);
  };
  const resizes = new ResizeObserver(measure);
  resizes.observe(card);
  resizes.observe(options.card);

  ctx.own(() => {
    clearTimeout(linger);
    openness.stop();
    resizes.disconnect();
  });

  return {
    root,
    side: options.side,
    setOpen(open, delay = 0) {
      clearTimeout(linger);
      if (open || delay <= 0) {
        wanted = open;
        apply();
        return;
      }
      linger = setTimeout(() => {
        wanted = false;
        apply();
      }, delay);
    },
    place(next, at) {
      slot = next;
      origin = at;
      root.hidden = next === null;
      if (!next) return;
      root.style.setProperty('--cp-rail-w', `${next.rail.width}px`);
      root.style.setProperty('--cp-card-w', `${(next.card ?? next.rail).width}px`);
      root.classList.toggle('has-card', next.card !== null);
      root.dataset.compact = String(next.rail.height < 96);
      apply();
      paint(openness.value);
    },
  };
}
