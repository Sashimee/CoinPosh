import './crates.css';
import type { Rarity, Roll } from '@coinposh/shared';
import type { UiApp } from '../../app/index.ts';
import { formatBalance, type InterpolationValues, type Language } from '../../i18n/index.ts';
import { makePressable } from '../../ui/components/pressable.ts';
import { feedback, type UiContext } from '../../ui/context.ts';
import { fromMarkup, h, listen, rectOf, restartAnimation } from '../../ui/dom.ts';
import { Localizer } from '../../ui/localize.ts';
import { HEIRLOOM_PRISM, RARITY_COLORS } from '../../vfx/palette.ts';
import { PLAQUE_SWELL } from './hint.ts';
import { cratesKey, registerCratesStrings } from './i18n.ts';
import {
  pityOutlook,
  rewardLines,
  type AlbumProgress,
  type AlbumProgressMap,
  type RewardLine,
} from './loot.ts';

/** How long the card takes to fly into the inventory icon before it is removed. */
export const CARD_FLY_MS = 520;
const LINE_STAGGER_MS = 70;
/** Air kept between the card and the HUD it must never cover, wide enough for a dock badge. */
export const CARD_CHROME_GAP = 12;

export interface CrateCardLayout {
  readonly viewportHeight: number;
  /** The Vault plaque, which the credit pop swells about its centre while coins keep landing. */
  readonly plaque: { readonly top: number; readonly bottom: number } | null;
  /** Top edge of the dock. */
  readonly base: number;
  /** The card's untransformed height. */
  readonly cardHeight: number;
}

export interface CrateCardPlacement {
  /** Distance from the viewport top to the card's top edge. */
  readonly top: number;
  /** Uniform shrink, about the card's top centre, that fits a tall card between the HUD. */
  readonly scale: number;
}

/**
 * Where the reward card rests for the whole reveal: just above the dock, like a tray it was
 * served on, never under the Vault plaque at the peak of its credit pop. A card taller than the
 * room between them shrinks to fit rather than covering either.
 */
export function placeCrateCard(layout: CrateCardLayout): CrateCardPlacement {
  let ceiling = 0;
  if (layout.plaque && layout.plaque.bottom > layout.plaque.top) {
    const { top, bottom } = layout.plaque;
    ceiling = (top + bottom) / 2 + ((bottom - top) * PLAQUE_SWELL) / 2;
  }
  const base = layout.base > ceiling ? layout.base : layout.viewportHeight;
  const room = Math.max(0, base - ceiling - 2 * CARD_CHROME_GAP);
  const height = Math.max(1, layout.cardHeight);
  const scale = height <= room ? 1 : Math.floor((room / height) * 100) / 100;
  const top = Math.floor(base - CARD_CHROME_GAP - height * scale);
  return { top: Math.max(Math.ceil(ceiling + CARD_CHROME_GAP), top), scale };
}

/** Final `scale()` of the `cp-crate-fly` keyframe in crates.css. */
export const CARD_FLY_SCALE = 0.15;

export interface CrateFlyRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The `--cp-crate-fly-x/y` translation that lands the shrunken card's centre on the target's
 * centre. `from` is the card's on-screen box (fit scale included), `originY` its transform
 * origin as a fraction of its height; the keyframe translation is applied inside `scale`.
 */
export function crateFlyOffset(
  from: CrateFlyRect,
  to: CrateFlyRect,
  scale: number,
  originY = 0,
): { readonly x: number; readonly y: number } {
  const k = scale > 0 ? scale : 1;
  const originTop = from.top + originY * from.height;
  const centreY = from.top + from.height / 2;
  const landedY = originTop + CARD_FLY_SCALE * (centreY - originTop);
  return {
    x: (to.left + to.width / 2 - (from.left + from.width / 2)) / k,
    y: (to.top + to.height / 2 - landedY) / k,
  };
}

const DOCK = '[data-testid="hud-dock"]';
const BALANCE = '[data-testid="hud-balance"]';

export interface CrateRevealOptions {
  readonly ui: Pick<UiApp, 'store' | 'bus' | 'i18n'>;
  readonly host: HTMLElement;
  readonly rarity: Rarity;
  readonly roll: Roll;
  /** Set progress for the roll's album cards, when the server's album has already answered. */
  readonly album?: AlbumProgressMap | null;
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
  /** The server's album answered: album lines gain their set progress. */
  setAlbum(progress: AlbumProgressMap): void;
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
  const t: CratesT = (key, values) => ui.i18n.t(cratesKey(key), values);
  const rarityName = () => t(`rarity.${rarity}`);

  const title = h('h2', { class: 'cp-crate-title', attrs: { id: 'cp-crate-title' } });
  const list = h('ul', { class: 'cp-crate-lines' });
  ctx.own(loc.attr(list, 'aria-label', () => t('contents')));
  let album: AlbumProgressMap | null = options.album ?? null;
  rewardLines(roll.rewards).forEach((line, index) => {
    const copy = () =>
      rewardLineCopy(
        line,
        t,
        ui.i18n.language,
        line.kind === 'collectible' ? (album?.[line.item] ?? null) : null,
      );
    const item = rewardLineItem(line, copy, ctx, loc);
    item.style.setProperty('--cp-crate-stagger', `${index * LINE_STAGGER_MS}ms`);
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
  let scale = 1;
  const place = () => {
    if (collecting) return;
    const dock = options.host.querySelector(DOCK)?.getBoundingClientRect();
    if (!dock || dock.height <= 0) return;
    const at = placeCrateCard({
      viewportHeight: document.documentElement.clientHeight,
      plaque: options.host.querySelector(BALANCE)?.getBoundingClientRect() ?? null,
      base: dock.top,
      cardHeight: card.offsetHeight,
    });
    scale = at.scale;
    card.classList.add('is-placed');
    card.style.setProperty('--cp-crate-card-top', `${at.top}px`);
    card.style.setProperty('--cp-crate-card-scale', String(at.scale));
  };
  const show = () => {
    if (shown) return;
    shown = true;
    card.hidden = false;
    skipHint.hidden = true;
    place();
    const observer = new ResizeObserver(place);
    observer.observe(document.documentElement);
    observer.observe(card);
    ctx.own(() => {
      observer.disconnect();
    });
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
      flyToward(card, options.inventoryTarget?.() ?? null, reducedMotion, scale);
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
    setAlbum(progress) {
      if (disposed) return;
      album = progress;
      loc.refresh();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const off of disposers.splice(0)) off();
      loc.dispose();
      root.remove();
    },
  };
}

export type CratesT = (
  key: Parameters<typeof cratesKey>[0],
  values?: InterpolationValues,
) => string;

/** What one reward line says: the headline, the line under it, and the rarity it wears. */
export interface RewardLineCopy {
  readonly name: string;
  readonly detail: string | null;
  readonly rarity: Rarity | null;
  /** The rarity chip beside an item's name. */
  readonly chip: string | null;
  /** The album card just finished its set. */
  readonly completes: boolean;
}

/**
 * The words on a reward line. Charms and album cards are named from the catalogue the server's
 * ids point into; set progress appears once the server's album has answered.
 */
export function rewardLineCopy(
  line: RewardLine,
  t: CratesT,
  language: Language,
  progress: AlbumProgress | null = null,
): RewardLineCopy {
  switch (line.kind) {
    case 'currency':
      return {
        name: t(`gain.${line.currency}`, {
          count: line.amount,
          value: formatBalance(line.amount, language),
        }),
        detail: null,
        rarity: null,
        chip: null,
        completes: false,
      };
    case 'charm':
      return {
        name: t(`item.${line.item}`),
        detail: line.duplicate ? t('charmLevel', { level: line.level }) : t('charmNew'),
        rarity: line.rarity,
        chip: t(`chip.${line.rarity}`),
        completes: false,
      };
    case 'collectible': {
      const completes = progress !== null && progress.owned >= progress.total;
      const values = {
        set: t(`set.${line.set}`),
        owned: progress?.owned ?? 0,
        total: progress?.total ?? 0,
      };
      return {
        name: t(`item.${line.item}`),
        detail:
          progress === null
            ? t('collectible')
            : t(completes ? 'albumSetComplete' : 'albumSet', values),
        rarity: line.rarity,
        chip: t(`chip.${line.rarity}`),
        completes,
      };
    }
    case 'safe':
    case 'scratchCard':
      return { name: t(line.kind), detail: null, rarity: null, chip: null, completes: false };
  }
}

const LINE_ICON_BODY = {
  charm:
    '<path d="M12 2.8v3.4"/><path d="M6.6 10 12 6.2l5.4 3.8L12 21Z" fill="currentColor" fill-opacity=".22"/><path d="M6.6 10h10.8M12 6.2 10 10l2 11 2-11Z"/>',
  collectible:
    '<rect x="5.5" y="3" width="13" height="18" rx="2.2" fill="currentColor" fill-opacity=".18"/><circle cx="12" cy="10.5" r="3.4"/><path d="M8.8 16.8h6.4M10.6 10.5h2.8"/>',
} as const;

function lineIcon(kind: keyof typeof LINE_ICON_BODY): HTMLElement {
  const badge = h('span', { class: 'cp-crate-line-icon', attrs: { 'aria-hidden': 'true' } });
  badge.append(
    fromMarkup(
      `<svg class="cp-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${LINE_ICON_BODY[kind]}</svg>`,
    ),
  );
  return badge;
}

/** One `<li>`: currencies are a single gain, items an icon, a name, a rarity chip and a detail. */
function rewardLineItem(
  line: RewardLine,
  copy: () => RewardLineCopy,
  ctx: UiContext,
  loc: Localizer,
): HTMLElement {
  const item = h('li', { class: `cp-crate-line cp-crate-line--${line.kind}` });
  if (line.kind !== 'charm' && line.kind !== 'collectible') {
    ctx.own(loc.text(item, () => copy().name));
    return item;
  }
  item.classList.add('cp-crate-line--item');
  item.dataset.rarity = line.rarity;
  item.style.setProperty('--cp-crate-line-accent', RARITY_COLORS[line.rarity]);
  if (line.rarity === 'heirloom') {
    item.style.setProperty('--cp-crate-prism', HEIRLOOM_PRISM.join(', '));
  }
  const name = h('span', { class: 'cp-crate-line-name' });
  const chip = h('span', { class: 'cp-crate-line-rarity' });
  const detail = h('span', { class: 'cp-crate-line-detail' });
  const text = h(
    'span',
    { class: 'cp-crate-line-text' },
    h('span', { class: 'cp-crate-line-head' }, name, chip),
    detail,
  );
  item.append(lineIcon(line.kind), text);
  ctx.own(loc.text(chip, () => copy().chip ?? ''));
  ctx.own(
    loc.bind(() => {
      const next = copy();
      if (name.textContent !== next.name) name.textContent = next.name;
      const words = next.detail ?? '';
      if (detail.textContent !== words) detail.textContent = words;
      item.classList.toggle('is-complete', next.completes);
    }),
  );
  return item;
}

/**
 * Sends the card toward the inventory icon. The fly keyframe shrinks the card about its
 * transform origin (top centre once placed, centre before), inside the fit `scale`.
 */
function flyToward(
  card: HTMLElement,
  target: HTMLElement | null,
  reduced: boolean,
  scale: number,
): void {
  if (reduced || target === null) return;
  const originY = card.classList.contains('is-placed') ? 0 : 0.5;
  const fly = crateFlyOffset(rectOf(card), rectOf(target), scale, originY);
  card.style.setProperty('--cp-crate-fly-x', `${Math.round(fly.x)}px`);
  card.style.setProperty('--cp-crate-fly-y', `${Math.round(fly.y)}px`);
}
