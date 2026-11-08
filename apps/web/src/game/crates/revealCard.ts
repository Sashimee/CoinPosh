import './crates.css';
import type { Rarity, Roll } from '@coinposh/shared';
import type { UiApp } from '../../app/index.ts';
import { formatBalance, type InterpolationValues, type Language } from '../../i18n/index.ts';
import { makePressable } from '../../ui/components/pressable.ts';
import { feedback, type UiContext } from '../../ui/context.ts';
import { h, listen, rectOf, restartAnimation } from '../../ui/dom.ts';
import { Localizer } from '../../ui/localize.ts';
import { HEIRLOOM_PRISM, RARITY_COLORS } from '../../vfx/palette.ts';
import { cratesKey, registerCratesStrings } from './i18n.ts';
import { pityOutlook, rewardLines, type RewardLine } from './loot.ts';

/** How long the card takes to fly into the inventory icon before it is removed. */
export const CARD_FLY_MS = 520;
const LINE_STAGGER_MS = 70;

export interface CrateRevealOptions {
  readonly ui: Pick<UiApp, 'store' | 'bus' | 'i18n'>;
  readonly host: HTMLElement;
  readonly rarity: Rarity;
  readonly roll: Roll;
  readonly reducedMotion: boolean;
  /** The HUD element the reward flies into; without one the card simply fades. */
  readonly inventoryTarget?: (() => HTMLElement | null) | undefined;
  /** A tap on the overlay before the reveal. */
  readonly onSkip: () => void;
  readonly onCollect: () => void;
}

export interface CrateReveal {
  readonly el: HTMLElement;
  readonly shown: boolean;
  /** Shows the card: the rarity banner, the rolled lines and Collect. */
  show(): void;
  dispose(): void;
}

/**
 * The DOM half of an unbox: a skip veil while the 3D cinematic plays, then the reward card
 * with the server's roll, the pity outlook and the fairness badge. Everything shown here is
 * what the server returned; nothing is computed from local state.
 */
export function mountCrateReveal(options: CrateRevealOptions): CrateReveal {
  const { ui, roll, rarity, reducedMotion } = options;
  const outlook = pityOutlook(roll.pity);
  registerCratesStrings(ui.i18n);
  const disposers: (() => void)[] = [];
  const loc = new Localizer(ui.i18n);
  const ctx: UiContext = {
    i18n: ui.i18n,
    loc,
    store: ui.store,
    bus: ui.bus,
    own: (dispose) => disposers.push(dispose),
  };
  const t = (key: Parameters<typeof cratesKey>[0], values?: InterpolationValues) =>
    ui.i18n.t(cratesKey(key), values);
  const rarityName = () => t(`rarity.${rarity}`);

  const title = h('h2', { class: 'cp-crate-title', attrs: { id: 'cp-crate-title' } });
  const list = h('ul', { class: 'cp-crate-lines' });
  ctx.own(loc.attr(list, 'aria-label', () => t('contents')));
  rewardLines(roll.rewards).forEach((line, index) => {
    const item = h('li', { class: `cp-crate-line cp-crate-line--${line.kind}` });
    item.style.setProperty('--cp-crate-stagger', `${index * LINE_STAGGER_MS}ms`);
    ctx.own(loc.text(item, () => lineText(line, t, ui.i18n.language)));
    list.append(item);
  });
  const pity = h('p', { class: 'cp-crate-pity' });
  ctx.own(
    loc.text(pity, () => {
      const values = { rarity: t(`rarity.${outlook.rarity}`), count: outlook.within };
      return outlook.within === 1 ? t('pityNext', values) : t('pity', values);
    }),
  );
  const fair = h('p', {
    class: 'cp-crate-fair',
    attrs: { title: `${roll.proof.serverSeedHash} · ${roll.proof.nonce}` },
  });
  const fairLabel = h('span');
  const fairHash = h('code', { text: roll.proof.serverSeedHash.slice(0, 10) });
  fair.append(fairLabel, fairHash);
  ctx.own(loc.text(fairLabel, () => t('fair')));
  const collectLabel = h('span');
  const collect = h(
    'button',
    { class: 'cp-buy cp-crate-collect', attrs: { type: 'button', 'data-testid': 'crate-collect' } },
    collectLabel,
  );
  ctx.own(loc.text(collectLabel, () => t('collect')));
  const card = h('div', { class: 'cp-crate-card' }, title, list, pity, fair, collect);
  card.hidden = true;
  const skipHint = h('p', { class: 'cp-crate-skip', attrs: { 'aria-hidden': 'true' } });
  ctx.own(loc.text(skipHint, () => t('skip')));
  const status = h('p', { class: 'cp-sr-only', attrs: { role: 'status' } });
  const root = h(
    'div',
    {
      class: 'cp-crate',
      attrs: {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'cp-crate-title',
        'data-motion': reducedMotion ? 'reduced' : 'full',
        'data-rarity': rarity,
        'data-testid': 'crate-reveal',
      },
    },
    skipHint,
    card,
    status,
  );
  root.style.setProperty('--cp-crate-accent', RARITY_COLORS[rarity]);
  if (rarity === 'heirloom') root.style.setProperty('--cp-crate-prism', HEIRLOOM_PRISM.join(', '));
  ctx.own(loc.text(title, () => t('opened', { rarity: rarityName() })));

  let shown = false;
  let collecting = false;
  const show = () => {
    if (shown) return;
    shown = true;
    card.hidden = false;
    skipHint.hidden = true;
    root.classList.add('is-revealed');
    restartAnimation(card, 'is-entering');
    ctx.own(loc.text(status, () => t('opened', { rarity: rarityName() })));
    collect.focus({ preventScroll: true });
  };

  makePressable(collect, ctx, {
    feedback: 'confirm',
    enabled: () => shown && !collecting,
    onPress: () => {
      if (collecting) return;
      collecting = true;
      root.classList.add('is-collecting');
      flyToward(card, options.inventoryTarget?.() ?? null, reducedMotion);
      options.onCollect();
    },
  });
  ctx.own(
    listen(root, 'pointerdown', (event) => {
      if (shown || (event.target instanceof Node && card.contains(event.target))) return;
      feedback(ctx, 'tap');
      options.onSkip();
    }),
  );
  ctx.own(
    listen(root, 'keydown', (event) => {
      if (shown || !(event.key === 'Enter' || event.key === ' ' || event.key === 'Escape')) return;
      event.preventDefault();
      options.onSkip();
    }),
  );

  root.tabIndex = -1;
  options.host.append(root);
  root.focus({ preventScroll: true });

  let disposed = false;
  return {
    el: root,
    get shown() {
      return shown;
    },
    show,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const off of disposers.splice(0)) off();
      loc.dispose();
      root.remove();
    },
  };
}

function lineText(
  line: RewardLine,
  t: (key: Parameters<typeof cratesKey>[0], values?: InterpolationValues) => string,
  language: Language,
): string {
  switch (line.kind) {
    case 'currency':
      return `+${formatBalance(line.amount, language)} ${t(`currency.${line.currency}`)}`;
    case 'charm':
      return line.duplicate ? t('charmLevel', { level: line.level }) : t('charmNew');
    case 'safe':
      return t('safe');
    case 'scratchCard':
      return t('scratchCard');
    case 'collectible':
      return t('collectible');
  }
}

/** Sends the card toward the inventory icon; CSS animates the transform it is handed. */
function flyToward(card: HTMLElement, target: HTMLElement | null, reduced: boolean): void {
  if (reduced || target === null) return;
  const from = rectOf(card);
  const to = rectOf(target);
  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  card.style.setProperty('--cp-crate-fly-x', `${Math.round(dx)}px`);
  card.style.setProperty('--cp-crate-fly-y', `${Math.round(dy)}px`);
}
