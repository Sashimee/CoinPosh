import './inventory.css';
import { RARITIES, type Rarity } from '@coinposh/shared';
import type { UiApp } from '../../app/index.ts';
import { browserStorage } from '../../app/settings.ts';
import type { AudioEngine } from '../../audio/index.ts';
import type { HapticPattern } from '../../vfx/haptics.ts';
import { makePressable } from '../components/pressable.ts';
import { Odometer } from '../components/odometer.ts';
import { feedback, type UiContext } from '../context.ts';
import { h, restartAnimation } from '../dom.ts';
import { icon } from '../icons.ts';
import { Localizer } from '../localize.ts';
import { isReducedMotion, onReducedMotionChange } from '../motion/reduced.ts';
import { SPRINGS } from '../motion/spring.ts';
import { SpringValue } from '../motion/value.ts';
import { createSheet } from '../panels/sheet.ts';
import { CardArtStudio, type CardArtSource } from './art.ts';
import { ItemCard, itemName, rarityName, rarityStyle, type CardOptions } from './card.ts';
import { seenLevelsStore, type SeenLevels } from './data.ts';
import { inventoryKey, registerInventoryStrings } from './i18n.ts';
import { cuePlan, type CuePlan } from './juice.ts';
import {
  filterCounts,
  filterStacks,
  groupStacks,
  levelGains,
  NO_FILTER,
  ownedKinds,
  seenLevels,
  SORT_MODES,
  sortStacks,
  type InventoryData,
  type InventoryView,
  type ItemKind,
  type ItemStack,
  type SortMode,
  type StackFilter,
} from './model.ts';

export type InventoryAudioPort = Pick<AudioEngine, 'playImpact'>;

export interface InventoryMountOptions {
  readonly ui: Pick<UiApp, 'store' | 'bus' | 'i18n'>;
  /** Usually the UI root over the canvas. */
  readonly host: HTMLElement;
  readonly data: InventoryData;
  readonly audio?: (() => InventoryAudioPort | null) | null;
  readonly haptics?: { pulse(pattern: HapticPattern): boolean } | null;
  /** The stage renderer; without it the cards keep their painted medallions. */
  readonly art?: CardArtSource | null;
  readonly seen?: SeenLevels;
  /** Called after the panel closes itself (close button, backdrop, drag or Escape). */
  readonly onClose: () => void;
}

export interface InventoryPanel {
  readonly el: HTMLElement;
  readonly isOpen: boolean;
  open(trigger: HTMLElement): void;
  close(): void;
  /** Re-reads the data source, e.g. after a crate grants an item. */
  refresh(): Promise<void>;
  dispose(): void;
}

type Phase = 'loading' | 'ready' | 'error';

const DEAL_STAGGER_MS = 38;
const DEAL_MAX_STAGGER = 12;

export function mountInventory(options: InventoryMountOptions): InventoryPanel {
  registerInventoryStrings(options.ui.i18n);
  const disposers: (() => void)[] = [];
  const loc = new Localizer(options.ui.i18n);
  const ctx: UiContext = {
    i18n: options.ui.i18n,
    loc,
    store: options.ui.store,
    bus: options.ui.bus,
    own: (dispose) => disposers.push(dispose),
  };
  const { i18n } = ctx;
  const t = (key: Parameters<typeof inventoryKey>[0], values?: Record<string, string | number>) =>
    i18n.t(inventoryKey(key), values);
  const seen = options.seen ?? seenLevelsStore(browserStorage());
  const studio = options.art ? new CardArtStudio(options.art) : null;

  let view: InventoryView | null = null;
  let stacks: readonly ItemStack[] = [];
  let filter: StackFilter = NO_FILTER;
  let sort: SortMode = 'rarity';
  let phase: Phase = 'loading';
  let loadGeneration = 0;
  let pendingGains: readonly { key: string; from: number }[] = [];
  const cards = new Map<string, ItemCard>();
  let disposed = false;

  const tally = new Odometer();
  const tallyLabel = h('span', { class: 'cp-inv-tally-label' });
  const tallyEl = h(
    'p',
    { class: 'cp-inv-tally', attrs: { 'aria-hidden': 'true' } },
    tally.el,
    tallyLabel,
  );
  const kindRow = h('div', { class: 'cp-inv-kinds', attrs: { role: 'group' } });
  const sortButton = h(
    'button',
    { class: 'cp-inv-sort', attrs: { type: 'button', 'data-testid': 'inventory-sort' } },
    icon('upgrades'),
    h('span', { class: 'cp-inv-sort-label' }),
  );
  const gemRow = h('div', { class: 'cp-inv-gems', attrs: { role: 'group' } });
  const status = h('p', {
    class: 'cp-sr-only',
    attrs: { 'aria-live': 'polite', 'data-testid': 'inventory-status' },
  });
  const grid = h('ul', { class: 'cp-inv-grid', attrs: { 'data-testid': 'inventory-grid' } });
  const emptyTitle = h('p', { class: 'cp-inv-empty-title' });
  const emptyHint = h('p', { class: 'cp-inv-empty-hint' });
  const emptyAction = h('button', {
    class: 'cp-chip cp-inv-empty-action',
    attrs: { type: 'button' },
  });
  const empty = h(
    'div',
    { class: 'cp-inv-empty', attrs: { hidden: '', 'data-testid': 'inventory-empty' } },
    h('span', { class: 'cp-inv-empty-crest', attrs: { 'aria-hidden': 'true' } }, icon('laurel')),
    emptyTitle,
    emptyHint,
    emptyAction,
  );
  const loading = h(
    'div',
    { class: 'cp-inv-loading', attrs: { 'aria-busy': 'true' } },
    ...Array.from({ length: 4 }, () => h('span', { class: 'cp-inv-shimmer' })),
  );
  const hint = h('p', { class: 'cp-inv-hint' });
  const toolbar = h(
    'div',
    { class: 'cp-inv-toolbar' },
    h('div', { class: 'cp-inv-toolbar-row' }, tallyEl, sortButton),
    kindRow,
    gemRow,
  );
  const body = h(
    'div',
    { class: 'cp-inv', attrs: { 'data-testid': 'inventory' } },
    toolbar,
    loading,
    grid,
    empty,
    hint,
    status,
  );

  const sheet = createSheet(ctx, {
    id: 'inventory',
    title: () => t('title'),
    subtitle: () => {
      if (view) return t('count.subtitle', { count: stacksCount() });
      return phase === 'error' ? t('unavailable') : t('loading');
    },
    body,
    onRequestClose: () => {
      panel.close();
      options.onClose();
    },
  });
  const root = h('div', { class: 'cp-ui cp-inv-root' }, sheet.el);
  options.host.append(root);
  root.classList.toggle('is-reduced', isReducedMotion());
  ctx.own(
    onReducedMotionChange((reduced) => {
      root.classList.toggle('is-reduced', reduced);
    }),
  );

  loc.text(tallyLabel, () => t('count.shown', { count: visible().length }));
  loc.text(hint, () => t('inspectHint'));
  loc.attr(kindRow, 'aria-label', () => t('kindFilter'));
  loc.attr(gemRow, 'aria-label', () => t('rarityFilter'));
  loc.text(sortButton.querySelector('.cp-inv-sort-label') ?? sortButton, () =>
    t('sortBy', { mode: t(`sort.${sort}`) }),
  );

  function stacksCount(): number {
    return view?.entries.length ?? 0;
  }

  function nameOf(stack: ItemStack): string {
    return itemName(i18n, stack);
  }

  function visible(): readonly ItemStack[] {
    return sortStacks(filterStacks(stacks, filter), sort, nameOf);
  }

  function plan(cue: 'open' | 'flip' | 'levelUp', rarity: Rarity | null): CuePlan {
    return cuePlan(cue, rarity, isReducedMotion());
  }

  function play(cuePlanned: CuePlan, withBus: boolean): void {
    if (withBus) feedback(ctx, cuePlanned.feedback);
    if (cuePlanned.haptic) options.haptics?.pulse(cuePlanned.haptic);
    const audio = options.audio?.() ?? null;
    if (!audio) return;
    for (const step of cuePlanned.chime) {
      setTimeout(() => {
        if (!disposed) audio.playImpact(step.impact);
      }, step.at);
    }
  }

  const canFuse = (): boolean => options.data.levelUp !== undefined;
  const cardOptions = (): CardOptions => ({
    duplicatesPerLevel: view?.duplicatesPerLevel ?? null,
    canFuse: canFuse(),
    onTurn: (card, toBack) => {
      for (const other of cards.values()) if (other !== card) other.turn(false, null);
      card.turn(toBack, plan('flip', card.stack.rarity));
    },
    onFuse: (card) => {
      void fuse(card);
    },
  });

  function paintFilters(): void {
    const counts = filterCounts(stacks, filter.kind);
    const kinds = ownedKinds(counts);
    kindRow.hidden = kinds.length < 2;
    kindRow.replaceChildren(
      ...(['all', ...kinds] as const).map((kind) => filterChip(kind, counts.kinds[kind])),
    );
    const owned = RARITIES.filter((rarity) => counts.rarities[rarity] > 0);
    gemRow.hidden = owned.length < 2;
    gemRow.replaceChildren(
      gem('all', counts.rarities.all),
      ...owned.map((r) => gem(r, counts.rarities[r])),
    );
  }

  const chipDisposers: (() => void)[] = [];
  const chipCtx: UiContext = { ...ctx, own: (dispose) => chipDisposers.push(dispose) };

  function filterChip(kind: ItemKind | 'all', count: number): HTMLElement {
    const active = filter.kind === kind;
    const chip = h(
      'button',
      {
        class: `cp-inv-chip${active ? ' is-active' : ''}`,
        attrs: { type: 'button', 'aria-pressed': String(active), 'data-kind': kind },
      },
      h('span', { text: t(`kind.${kind}`) }),
      h('span', { class: 'cp-inv-chip-count', text: String(count) }),
    );
    makePressable(chip, chipCtx, {
      feedback: 'tick',
      onPress: () => {
        if (filter.kind === kind) return;
        filter = { kind, rarity: 'all' };
        render(true);
      },
    });
    return chip;
  }

  function gem(rarity: Rarity | 'all', count: number): HTMLElement {
    const active = filter.rarity === rarity;
    const label = rarity === 'all' ? t('rarityAll') : rarityName(i18n, rarity);
    const chip = h(
      'button',
      {
        class: `cp-inv-gem${active ? ' is-active' : ''}`,
        attrs: {
          type: 'button',
          'aria-pressed': String(active),
          'aria-label': `${label} (${count})`,
          title: label,
          'data-rarity': rarity,
          style: rarity === 'all' ? '' : rarityStyle(rarity),
        },
      },
      h('span', { class: 'cp-inv-gem-stone', attrs: { 'aria-hidden': 'true' } }),
      h('span', {
        class: 'cp-inv-gem-count',
        attrs: { 'aria-hidden': 'true' },
        text: String(count),
      }),
    );
    makePressable(chip, chipCtx, {
      feedback: 'tick',
      onPress: () => {
        if (filter.rarity === rarity) return;
        filter = { ...filter, rarity };
        render(true);
      },
    });
    return chip;
  }

  makePressable(sortButton, ctx, {
    feedback: 'tick',
    onPress: () => {
      sort = SORT_MODES[(SORT_MODES.indexOf(sort) + 1) % SORT_MODES.length] ?? 'rarity';
      loc.refresh();
      render(true);
    },
  });
  makePressable(emptyAction, ctx, {
    feedback: 'tap',
    onPress: () => {
      if (phase === 'error') {
        void refresh();
        return;
      }
      filter = NO_FILTER;
      render(true);
    },
  });

  /** FLIP: every card that stays slides from where it was to where the new order puts it. */
  function render(morph: boolean): void {
    for (const dispose of chipDisposers.splice(0)) dispose();
    root.dataset.phase = phase;
    loading.hidden = phase !== 'loading';
    paintFilters();
    const before = new Map<string, DOMRect>();
    if (morph && !isReducedMotion()) {
      for (const [key, card] of cards) before.set(key, card.el.getBoundingClientRect());
    }
    const shown = phase === 'ready' ? visible() : [];
    const live = new Set(shown.map((stack) => stack.key));
    for (const [key, card] of cards) {
      if (live.has(key)) continue;
      card.dispose();
      card.el.remove();
      cards.delete(key);
    }
    const fresh: ItemCard[] = [];
    const order = shown.map((stack) => {
      const existing = cards.get(stack.key);
      if (existing) {
        existing.update(stack, cardOptions());
        return existing;
      }
      const card = new ItemCard(ctx, stack, cardOptions());
      cards.set(stack.key, card);
      fresh.push(card);
      void studio?.art({ kind: stack.kind, rarity: stack.rarity }).then(
        (art) => {
          if (art && cards.get(stack.key) === card) card.setArt(art);
        },
        (error: unknown) => {
          console.error(`[CoinPosh] inventory card art for ${stack.key} failed to render`, error);
        },
      );
      return card;
    });
    grid.replaceChildren(...order.map((card) => card.el));
    fresh.forEach((card, index) => {
      card.el.style.setProperty(
        '--cp-inv-deal',
        `${Math.min(index, DEAL_MAX_STAGGER) * DEAL_STAGGER_MS}ms`,
      );
      restartAnimation(card.el, 'is-dealt');
    });
    for (const [key, rect] of before) {
      const card = cards.get(key);
      if (!card) continue;
      const after = card.el.getBoundingClientRect();
      const dx = rect.left - after.left;
      const dy = rect.top - after.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      const el = card.el;
      const slide = new SpringValue(1, SPRINGS.snappy, (p) => {
        el.style.translate = p === 0 ? '' : `${dx * p}px ${dy * p}px`;
      });
      void slide.to(0);
    }

    const isEmpty = phase === 'error' || (phase === 'ready' && shown.length === 0);
    empty.hidden = !isEmpty;
    empty.dataset.reason = phase === 'error' ? 'error' : stacks.length === 0 ? 'none' : 'filtered';
    emptyTitle.textContent =
      phase === 'error' ? t('error') : stacks.length === 0 ? t('empty') : t('emptyFiltered');
    emptyHint.textContent = phase === 'ready' && stacks.length === 0 ? t('emptyHint') : '';
    emptyHint.hidden = emptyHint.textContent === '';
    emptyAction.textContent = phase === 'error' ? t('retry') : t('clearFilters');
    emptyAction.hidden = phase === 'ready' && stacks.length === 0;
    hint.hidden = phase !== 'ready' || shown.length === 0;
    loc.refresh();
    tally.set(String(shown.length), 1);
  }

  async function load(next: Promise<InventoryView>): Promise<void> {
    const generation = ++loadGeneration;
    try {
      const loaded = await next;
      if (generation !== loadGeneration || disposed) return;
      view = loaded;
      stacks = groupStacks(loaded.entries);
      phase = 'ready';
      // Only an open panel marks levels as seen, so a refresh behind a closed panel keeps the
      // gain for the next open to celebrate.
      if (sheet.isOpen) {
        const previous = seen.read();
        pendingGains = previous ? levelGains(previous, stacks) : [];
        seen.write(seenLevels(stacks));
      }
    } catch (error) {
      if (generation !== loadGeneration || disposed) return;
      console.warn('[CoinPosh] the inventory could not be loaded', error);
      phase = 'error';
    }
    render(true);
    if (sheet.isOpen) celebrateGains();
  }

  function celebrateGains(): void {
    const gains = pendingGains;
    pendingGains = [];
    gains.forEach((gain, index) => {
      const card = cards.get(gain.key);
      if (!card) return;
      setTimeout(
        () => {
          if (disposed || cards.get(gain.key) !== card) return;
          const cue = plan('levelUp', card.stack.rarity);
          play(cue, true);
          void card.celebrate(gain.from, cue);
          status.textContent = t('levelUp', { name: nameOf(card.stack), level: card.stack.level });
        },
        420 + index * 520,
      );
    });
  }

  async function fuse(card: ItemCard): Promise<void> {
    const levelUp = options.data.levelUp;
    if (!levelUp) return;
    const from = card.stack.level;
    card.setBusy(true);
    try {
      const next = await levelUp(card.stack);
      if (disposed) return;
      view = next;
      stacks = groupStacks(next.entries);
      seen.write(seenLevels(stacks));
      render(false);
      const updated = cards.get(card.stack.key);
      if (updated && updated.stack.level > from) {
        const cue = plan('levelUp', updated.stack.rarity);
        play(cue, true);
        await updated.celebrate(from, cue);
        status.textContent = t('levelUp', {
          name: nameOf(updated.stack),
          level: updated.stack.level,
        });
      }
    } catch (error) {
      console.warn('[CoinPosh] fusing duplicates failed', error);
      feedback(ctx, 'deny');
      status.textContent = t('fuseFailed');
    } finally {
      card.setBusy(false);
    }
  }

  function refresh(): Promise<void> {
    if (view === null) {
      phase = 'loading';
      render(false);
    }
    return load(options.data.load());
  }

  const panel: InventoryPanel = {
    el: root,
    get isOpen() {
      return sheet.isOpen;
    },
    open(trigger) {
      if (sheet.isOpen) return;
      const cue = plan('open', null);
      play(cue, true);
      sheet.open(trigger);
      restartAnimation(root, 'is-opening');
      for (const card of cards.values()) card.turn(false, null);
      tally.jump('0');
      render(false);
      [...cards.values()].forEach((card, index) => {
        card.el.style.setProperty(
          '--cp-inv-deal',
          `${Math.min(index, DEAL_MAX_STAGGER) * DEAL_STAGGER_MS}ms`,
        );
        restartAnimation(card.el, 'is-dealt');
      });
      void refresh();
    },
    close() {
      sheet.close();
    },
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const card of cards.values()) card.dispose();
      cards.clear();
      for (const dispose of chipDisposers.splice(0)) dispose();
      for (const dispose of disposers.splice(0)) dispose();
      studio?.dispose();
      loc.dispose();
      root.remove();
    },
  };
  render(false);
  return panel;
}
