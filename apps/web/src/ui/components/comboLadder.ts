import { cascade } from '@coinposh/economy';
import { comboView, type ComboView } from '../../app/model.ts';
import { watch } from '../../app/store.ts';
import { formatDecimal, formatInteger } from '../../i18n/index.ts';
import { tr, type UiContext } from '../context.ts';
import { fromMarkup, h } from '../dom.ts';
import { SPRINGS } from '../motion/spring.ts';
import { SpringValue } from '../motion/value.ts';

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
  return `<svg class="cp-flute" viewBox="0 0 48 168" aria-hidden="true" focusable="false">
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

export function createComboLadder(ctx: UiContext): HTMLElement {
  const id = `cp-flute-${++fluteIds}`;
  const flute = fromMarkup(fluteMarkup(id, cascade.tiers.length));
  const wine = flute.querySelector<SVGRectElement>('.cp-flute-wine');
  const foam = flute.querySelector<SVGRectElement>('.cp-flute-foam');
  const rungs = [...flute.querySelectorAll<SVGPathElement>('.cp-flute-rung')];
  if (!wine || !foam) throw new Error('Combo flute markup is missing its fill layers');

  const heading = h('span', { class: 'cp-side-label' });
  const tierName = h('span', { class: 'cp-combo-tier' });
  const multiplier = h('span', { class: 'cp-combo-mult' });
  const hint = h('span', { class: 'cp-combo-hint' });
  const spoken = h('span', { class: 'cp-sr-only', attrs: { 'aria-live': 'polite' } });
  const root = h(
    'div',
    { class: 'cp-combo cp-side-meter', attrs: { 'data-testid': 'hud-combo', 'data-rank': '0' } },
    heading,
    flute,
    h('span', { class: 'cp-combo-caption' }, tierName, multiplier),
    hint,
    spoken,
  );

  const fill = new SpringValue(0, SPRINGS.bouncy, (value) => {
    const level = Math.min(1.04, Math.max(0, value));
    const y = BOWL_BOTTOM - level * BOWL_SPAN;
    wine.setAttribute('y', String(y));
    foam.setAttribute('y', String(y - 1));
    root.style.setProperty('--cp-fill', String(level));
  });
  const swell = new SpringValue(1, SPRINGS.pop, (value) => {
    tierName.style.scale = value === 1 ? '' : String(value);
  });

  ctx.loc.text(heading, () => tr(ctx, 'combo.label'));

  const describe = (view: ComboView): void => {
    const language = ctx.i18n.language;
    const tier = view.tier ? tr(ctx, `combo.tier.${view.tier.id}`) : '';
    const mult = tr(ctx, 'combo.multiplier', { value: formatDecimal(view.multiplier, language) });
    tierName.textContent = view.tier ? tier : '—';
    multiplier.textContent = view.tier ? mult : '';
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
        if (previous && view.rank > previous.rank) swell.kick(6);
        describe(view);
      },
      (a, b) => a.count === b.count,
    ),
  );
  ctx.own(
    ctx.loc.bind(() => {
      describe(comboView(ctx.store.getState().cascadeCount, cascade));
    }),
  );
  return root;
}
