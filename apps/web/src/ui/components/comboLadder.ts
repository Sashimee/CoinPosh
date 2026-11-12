import { cascade } from '@coinposh/economy';
import { comboView, type ComboView } from '../../app/model.ts';
import { watch } from '../../app/store.ts';
import { formatDecimal, formatInteger } from '../../i18n/index.ts';
import { tr, type UiContext } from '../context.ts';
import { fromMarkup, h } from '../dom.ts';
import { isReducedMotion } from '../motion/reduced.ts';
import { SPRINGS } from '../motion/spring.ts';
import { SpringValue } from '../motion/value.ts';
import { announcementHoldFor, createRankGate, peakReplay } from './announcementHold.ts';
import { createMeterRail, type MeterRail } from './meterRail.ts';
import { fitCaption, swellOverhang } from './railLayout.ts';

const BOWL_TOP = 8;
const BOWL_BOTTOM = 112;
const BOWL_SPAN = BOWL_BOTTOM - BOWL_TOP;
const BOWL_PATH = 'M9 8 C9 52 13 92 21.5 108 Q24 113 26.5 108 C35 92 39 52 39 8 Z';
const BUBBLES = [
  { x: 20, r: 1.3, delay: 0 },
  { x: 27, r: 1, delay: 0.7 },
  { x: 23.5, r: 1.6, delay: 1.3 },
  { x: 30, r: 0.9, delay: 1.9 },
  { x: 18, r: 0.8, delay: 2.4 },
];

function fluteMarkup(id: string, tiers: number): string {
  const rungs = Array.from({ length: tiers }, (_, i) => {
    const y = BOWL_BOTTOM - ((i + 1) / tiers) * BOWL_SPAN;
    return `<path class="cp-flute-rung" data-rung="${i + 1}" d="M10.5 ${y} h5"/>`;
  }).join('');
  const bubbles = BUBBLES.map(
    (b) =>
      `<circle class="cp-flute-bubble" cx="${b.x}" cy="${BOWL_BOTTOM - 4}" r="${b.r}" style="animation-delay:${b.delay}s"/>`,
  ).join('');
  return `<svg class="cp-flute" viewBox="6 4 36 158" aria-hidden="true" focusable="false">
  <defs>
    <clipPath id="${id}-bowl"><path d="${BOWL_PATH}"/></clipPath>
    <linearGradient id="${id}-wine" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0" stop-color="var(--cp-gold-brushed)"/>
      <stop offset="0.7" stop-color="var(--cp-champagne)"/>
      <stop offset="1" stop-color="var(--cp-ivory)"/>
    </linearGradient>
    <linearGradient id="${id}-glass" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="var(--cp-ivory)" stop-opacity=".28"/>
      <stop offset=".35" stop-color="var(--cp-ivory)" stop-opacity=".04"/>
      <stop offset="1" stop-color="var(--cp-ivory)" stop-opacity=".14"/>
    </linearGradient>
  </defs>
  <path d="${BOWL_PATH}" fill="url(#${id}-glass)"/>
  <g clip-path="url(#${id}-bowl)">
    <rect class="cp-flute-wine" x="0" y="${BOWL_BOTTOM}" width="48" height="${BOWL_SPAN + 8}" fill="url(#${id}-wine)"/>
    <rect class="cp-flute-foam" x="0" y="${BOWL_BOTTOM}" width="48" height="2.2"/>
    <g class="cp-flute-bubbles">${bubbles}</g>
  </g>
  ${rungs}
  <path class="cp-flute-glass" d="${BOWL_PATH}"/>
  <path class="cp-flute-glass" d="M24 112 V150 M13 156 Q24 150 35 156 Q24 160 13 156 Z"/>
  <path class="cp-flute-shine" d="M13 14 C13 44 15.5 74 20 96"/>
</svg>`;
}

let fluteIds = 0;
/** A spent cascade keeps its card up this long, so the drain reads before it folds away. */
const RANK_LINGER_MS = 1500;
const PULSE_MS = 1100;
const PULSE_REDUCED_MS = 700;
const PULSE_RUNG_STAGGER_MS = 70;
const PULSE_GLOW = [
  '0 0 0 1.5px rgb(var(--cp-champagne-rgb) / 0.55)',
  '0 0 20px 3px rgb(var(--cp-gold-brushed-rgb) / 0.7)',
  'inset 0 0 16px rgb(var(--cp-champagne-rgb) / 0.4)',
];
const PULSE_GLOW_OFF = ['0 0 0 0 transparent', '0 0 0 0 transparent', 'inset 0 0 0 transparent'];

/**
 * The glow layered over whatever the rail already casts. Both frames keep the same list of
 * shadows, outset and inset in the same places, so the browser interpolates them instead of
 * flipping between them halfway.
 */
function withGlow(rest: string, glow: readonly string[]): string {
  return rest === 'none' ? glow.join(', ') : [...glow, rest].join(', ');
}

export function createComboLadder(ctx: UiContext): MeterRail {
  const id = `cp-flute-${++fluteIds}`;
  const flute = fromMarkup(fluteMarkup(id, cascade.tiers.length));
  const wine = flute.querySelector<SVGRectElement>('.cp-flute-wine');
  const foam = flute.querySelector<SVGRectElement>('.cp-flute-foam');
  const rungs = [...flute.querySelectorAll<SVGPathElement>('.cp-flute-rung')];
  if (!wine || !foam) throw new Error('Combo flute markup is missing its fill layers');

  const heading = h('span', { class: 'cp-side-label' });
  const tierName = h('span', { class: 'cp-combo-tier' });
  const multiplier = h('span', { class: 'cp-combo-mult' });
  const captionRow = h('span', { class: 'cp-combo-caption' }, tierName, multiplier);
  const hint = h('span', { class: 'cp-combo-hint' });
  const spoken = h('span', { class: 'cp-sr-only', attrs: { 'aria-live': 'polite' } });
  const rail = createMeterRail(ctx, {
    side: 'right',
    className: 'cp-combo',
    testId: 'hud-combo',
    spine: flute,
    card: h('span', { class: 'cp-rail-text' }, heading, captionRow, hint),
  });
  const root = rail.root;
  root.dataset.rank = '0';
  root.append(spoken);

  const fill = new SpringValue(0, SPRINGS.bouncy, (value) => {
    const level = Math.min(1.04, Math.max(0, value));
    const y = BOWL_BOTTOM - level * BOWL_SPAN;
    wine.setAttribute('y', String(y));
    foam.setAttribute('y', String(y - 1));
    root.style.setProperty('--cp-fill', String(level));
  });
  /** Distance from the rank name's field-side edge to the origin it swells about. */
  let swellReach = 0;
  const swell = new SpringValue(1, SPRINGS.pop, (value) => {
    tierName.style.scale = value === 1 ? '' : String(value);
    rail.setOverhang(swellOverhang(value, swellReach));
  });

  ctx.loc.text(heading, () => tr(ctx, 'combo.label'));

  const frame = captionRow.closest('.cp-rail-card');
  if (!(frame instanceof HTMLElement)) throw new Error('Combo caption is not inside a rail card');
  let fitted = '';
  /** Keeps the longest rank name, in every language, inside the card: wrap first, then shrink. */
  const fit = (): void => {
    const style = getComputedStyle(frame);
    const room = frame.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    if (room <= 0) return;
    captionRow.classList.remove('is-stacked');
    tierName.style.fontSize = '';
    const { stacked, scale } = fitCaption({
      room,
      name: tierName.offsetWidth,
      multiplier: multiplier.offsetWidth,
      gap: parseFloat(getComputedStyle(captionRow).columnGap) || 0,
    });
    captionRow.classList.toggle('is-stacked', stacked);
    if (scale < 1) {
      tierName.style.fontSize = `${parseFloat(getComputedStyle(tierName).fontSize) * scale}px`;
    }
    const originX = parseFloat(getComputedStyle(tierName).transformOrigin);
    swellReach = rail.side === 'right' ? originX : tierName.offsetWidth - originX;
    fitted = captionKey();
  };
  const captionKey = (): string =>
    `${ctx.i18n.language}\n${tierName.textContent}\n${multiplier.textContent}`;
  /** A cascade recounts on every coin; only a new rank, multiplier or language needs a re-fit. */
  const refit = (): void => {
    if (captionKey() !== fitted) fit();
  };
  const frameResizes = new ResizeObserver(fit);
  frameResizes.observe(frame);
  document.fonts.addEventListener('loadingdone', fit);
  ctx.own(() => {
    frameResizes.disconnect();
    document.fonts.removeEventListener('loadingdone', fit);
  });

  let lastLive: ComboView | null = null;
  const caption = (view: ComboView): void => {
    const language = ctx.i18n.language;
    tierName.textContent = view.tier ? tr(ctx, `combo.tier.${view.tier.id}`) : '—';
    multiplier.textContent = view.tier
      ? tr(ctx, 'combo.multiplier', { value: formatDecimal(view.multiplier, language) })
      : '';
    if (view.next && view.count > 0) {
      hint.textContent = tr(ctx, 'combo.next', {
        count: view.toNext,
        tier: tr(ctx, `combo.tier.${view.next.id}`),
      });
    } else if (!view.next) {
      hint.textContent = tr(ctx, 'combo.peak');
    } else {
      hint.textContent = tr(ctx, 'combo.idle');
    }
  };
  const describe = (view: ComboView): void => {
    const language = ctx.i18n.language;
    if (view.tier) lastLive = view;
    // A spent cascade's card folds away still naming the rank it reached, not an idle dash.
    caption(view.tier ? view : (lastLive ?? view));
    refit();
    root.classList.toggle('is-spent', !view.tier && lastLive !== null);
    const tier = view.tier ? tr(ctx, `combo.tier.${view.tier.id}`) : '';
    const mult = tr(ctx, 'combo.multiplier', { value: formatDecimal(view.multiplier, language) });
    spoken.textContent = view.tier
      ? tr(ctx, 'combo.aria', {
          tier,
          coins: tr(ctx, 'currency.coins', {
            count: view.count,
            value: formatInteger(view.count, language),
          }),
          multiplier: mult,
        })
      : '';
    root.setAttribute('aria-label', view.tier ? spoken.textContent : tr(ctx, 'combo.ariaIdle'));
  };

  const pulses: Animation[] = [];
  /**
   * A compact echo of a rank reached under a hold whose cascade has since fallen: the rail
   * flares gold and the flute's rungs light up to the peak, all in the rail's own box.
   */
  const pulse = (peak: number): void => {
    for (const running of pulses.splice(0)) running.cancel();
    const reduced = isReducedMotion();
    const style = getComputedStyle(root);
    const rest = {
      boxShadow: withGlow(style.boxShadow, PULSE_GLOW_OFF),
      borderColor: style.borderColor,
    };
    const flare = {
      boxShadow: withGlow(style.boxShadow, PULSE_GLOW),
      borderColor: 'var(--cp-gold-brushed)',
    };
    const duration = reduced ? PULSE_REDUCED_MS : PULSE_MS;
    const rise = 'cubic-bezier(0.2, 0.9, 0.3, 1)';
    const fade = 'cubic-bezier(0.45, 0, 0.55, 1)';
    pulses.push(
      root.animate(
        reduced
          ? [{ ...rest, easing: fade }, { ...flare, offset: 0.3, easing: fade }, { ...rest }]
          : [
              { ...rest, scale: '1', easing: rise },
              { ...flare, scale: '1.06', offset: 0.16, easing: 'linear' },
              { ...flare, scale: '1.02', offset: 0.34, easing: fade },
              { ...rest, scale: '1' },
            ],
        { duration },
      ),
    );
    rungs.slice(0, peak).forEach((rung, i) => {
      pulses.push(
        rung.animate(
          [
            { easing: rise },
            { stroke: 'var(--cp-champagne)', strokeWidth: '2.2', offset: 0.22, easing: fade },
            {},
          ],
          { duration, delay: reduced ? 0 : i * PULSE_RUNG_STAGGER_MS },
        ),
      );
    });
  };
  ctx.own(() => {
    for (const running of pulses.splice(0)) running.cancel();
  });

  // Under a hold the flute keeps filling but the card stays folded; once free it opens again
  // with one swell for the highest rank the hold kept quiet, or, when the cascade has fallen
  // from that rank, the rail pulses for it instead of the centre stamp.
  const hold = announcementHoldFor(ctx.store);
  const openFor = (rank: number): void => {
    rail.setOpen(rank > 0 && !hold.held, RANK_LINGER_MS);
  };
  ctx.own(
    hold.onChange((held) => {
      if (held) rail.collapse();
      else openFor(comboView(ctx.store.getState().cascadeCount, cascade).rank);
    }),
  );
  const gate = createRankGate(
    hold,
    {
      rise: () => {
        swell.kick(6);
      },
      replay: (peak, live) => {
        if (live > 0) swell.kick(6);
        if (peakReplay(peak, live) === 'pulse') pulse(peak);
      },
    },
    comboView(ctx.store.getState().cascadeCount, cascade).rank,
  );
  ctx.own(
    watch(
      ctx.store,
      (s) => comboView(s.cascadeCount, cascade),
      (view, previous) => {
        root.dataset.rank = String(view.rank);
        root.classList.toggle('is-active', view.count > 0);
        rungs.forEach((rung, i) => rung.classList.toggle('is-lit', i < view.rank));
        const draining = previous !== undefined && view.count < previous.count;
        void fill.to(view.fill, draining ? SPRINGS.gentle : SPRINGS.bouncy);
        openFor(view.rank);
        gate.update(view.rank);
        describe(view);
      },
      (a, b) => a.count === b.count,
    ),
  );
  ctx.own(() => {
    gate.dispose();
  });
  ctx.own(
    ctx.loc.bind(() => {
      describe(comboView(ctx.store.getState().cascadeCount, cascade));
    }),
  );
  return rail;
}
