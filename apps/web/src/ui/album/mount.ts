import './album.css';
import type { Rarity } from '@coinposh/shared';
import type { UiApp } from '../../app/index.ts';
import { browserStorage } from '../../app/settings.ts';
import type { AudioEngine } from '../../audio/index.ts';
import { cratesKey } from '../../game/crates/i18n.ts';
import type { AlbumSetKey } from '../../game/crates/loot.ts';
import { formatInteger, formatPercent } from '../../i18n/index.ts';
import { HEIRLOOM_PRISM, RARITY_COLORS } from '../../vfx/palette.ts';
import type { HapticPattern } from '../../vfx/haptics.ts';
import { makePressable } from '../components/pressable.ts';
import { Odometer } from '../components/odometer.ts';
import { feedback, type UiContext } from '../context.ts';
import { h, listen, restartAnimation } from '../dom.ts';
import { icon } from '../icons.ts';
import { Localizer } from '../localize.ts';
import { sharedLayoutMorph } from '../motion/morph.ts';
import { isReducedMotion, onReducedMotionChange } from '../motion/reduced.ts';
import { createSheet } from '../panels/sheet.ts';
import { seenCompletionsStore, type SeenCompletions } from './data.ts';
import { albumT, registerAlbumStrings } from './i18n.ts';
import { albumCuePlan, type AlbumCue, type AlbumCuePlan } from './juice.ts';
import {
  bonusBefore,
  newlyCompleted,
  setLore,
  setProgress,
  slotLore,
  type AlbumData,
  type AlbumSetView,
  type AlbumSlot,
  type AlbumView,
  type LoreTarget,
} from './model.ts';

export type AlbumAudioPort = Pick<AudioEngine, 'playImpact'>;

export interface AlbumMountOptions {
  readonly ui: Pick<UiApp, 'store' | 'bus' | 'i18n'>;
  /** Usually the UI root over the canvas. */
  readonly host: HTMLElement;
  readonly data: AlbumData;
  readonly audio?: (() => AlbumAudioPort | null) | null;
  readonly haptics?: { pulse(pattern: HapticPattern): boolean } | null;
  readonly seen?: SeenCompletions;
  /** Called after the panel closes itself (close button, backdrop, drag or Escape). */
  readonly onClose: () => void;
}

export interface AlbumPanel {
  readonly el: HTMLElement;
  readonly isOpen: boolean;
  open(trigger: HTMLElement): void;
  close(): void;
  /** Re-reads the album, e.g. after a crate grants a collectible. */
  refresh(): Promise<void>;
  dispose(): void;
}

type Phase = 'loading' | 'ready' | 'error';

interface SetPage {
  readonly set: AlbumSetView;
  readonly el: HTMLElement;
  readonly page: HTMLElement;
  readonly stamp: HTMLElement;
  readonly sparks: HTMLElement;
  readonly bonus: HTMLElement;
  readonly meter: HTMLElement;
}

const DEAL_STAGGER_MS = 70;
const FANFARE_FIRST_MS = 560;
const FANFARE_GAP_MS = 1500;
const SPARK_LIFE_MS = 950;
const LORE_RADIUS = 22;

const PRISM_LOOP = [...HEIRLOOM_PRISM, HEIRLOOM_PRISM[0]].join(', ');

function accentStyle(rarity: Rarity): string {
  return `--cp-album-accent: ${RARITY_COLORS[rarity]}; --cp-album-prism: ${PRISM_LOOP}`;
}

function setAccent(el: HTMLElement, rarity: Rarity): void {
  el.style.setProperty('--cp-album-accent', RARITY_COLORS[rarity]);
  el.style.setProperty('--cp-album-prism', PRISM_LOOP);
}

export function mountAlbum(options: AlbumMountOptions): AlbumPanel {
  registerAlbumStrings(options.ui.i18n);
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
  const t = albumT(i18n);
  const seen = options.seen ?? seenCompletionsStore(browserStorage());

  let view: AlbumView | null = null;
  let phase: Phase = 'loading';
  let loadGeneration = 0;
  let disposed = false;
  let awaiting = new Set<AlbumSetKey>();
  let shownBonus = 0;
  const pages = new Map<AlbumSetKey, SetPage>();
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const later = (ms: number, run: () => void): void => {
    const id = setTimeout(() => {
      timers.delete(id);
      if (!disposed) run();
    }, ms);
    timers.add(id);
  };
  const clearTimers = (): void => {
    for (const id of timers) clearTimeout(id);
    timers.clear();
  };

  const setName = (id: AlbumSetKey): string => i18n.t(cratesKey(`set.${id}`));
  const slotName = (slot: AlbumSlot): string => i18n.t(cratesKey(`item.${slot.id}`));
  const rarityName = (rarity: Rarity): string => i18n.t(cratesKey(`chip.${rarity}`));
  const percent = (fraction: number): string => formatPercent(fraction, i18n.language);
  const bonusText = (fraction: number): string => t('bonusValue', { value: percent(fraction) });

  const tally = new Odometer();
  const tallyTotal = h('span', { class: 'cp-album-tally-total' });
  const tallyLabel = h('span', { class: 'cp-album-tally-label' });
  const total = new Odometer();
  const totalCaption = h('span', { class: 'cp-album-total-caption' });
  const totalNone = h('span', { class: 'cp-album-total-none' });
  const totalEl = h(
    'div',
    { class: 'cp-album-total', attrs: { 'aria-hidden': 'true' } },
    h('span', { class: 'cp-album-total-crest' }, icon('laurel')),
    h('span', { class: 'cp-album-total-figure' }, total.el, totalCaption),
    totalNone,
  );
  const overall = h('span', { class: 'cp-album-overall-fill' });
  const ledgerSr = h('p', { class: 'cp-sr-only' });
  const ledger = h(
    'div',
    { class: 'cp-album-ledger' },
    h(
      'p',
      { class: 'cp-album-tally', attrs: { 'aria-hidden': 'true' } },
      tally.el,
      tallyTotal,
      tallyLabel,
    ),
    totalEl,
    h('span', { class: 'cp-album-overall', attrs: { 'aria-hidden': 'true' } }, overall),
    ledgerSr,
  );
  const hint = h('p', { class: 'cp-album-hint' });
  const list = h('ul', { class: 'cp-album-sets', attrs: { 'data-testid': 'album-sets' } });
  const loading = h(
    'div',
    { class: 'cp-album-loading', attrs: { 'aria-busy': 'true' } },
    ...Array.from({ length: 2 }, () => h('span', { class: 'cp-album-shimmer' })),
  );
  const emptyTitle = h('p', { class: 'cp-album-empty-title' });
  const retry = h('button', {
    class: 'cp-chip cp-album-retry',
    attrs: { type: 'button', 'data-testid': 'album-retry' },
  });
  const empty = h(
    'div',
    { class: 'cp-album-empty', attrs: { hidden: '', 'data-testid': 'album-empty' } },
    h('span', { class: 'cp-album-empty-crest', attrs: { 'aria-hidden': 'true' } }, icon('laurel')),
    emptyTitle,
    retry,
  );
  const status = h('p', {
    class: 'cp-sr-only',
    attrs: { 'aria-live': 'polite', 'data-testid': 'album-status' },
  });
  const body = h(
    'div',
    { class: 'cp-album', attrs: { 'data-testid': 'album' } },
    ledger,
    hint,
    loading,
    list,
    empty,
    status,
  );

  const sheet = createSheet(ctx, {
    id: 'album',
    title: () => t('title'),
    subtitle: () => {
      if (view) {
        return t('count.subtitle', {
          count: view.completedSets - awaiting.size,
          owned: formatInteger(view.owned, i18n.language),
          total: formatInteger(view.total, i18n.language),
        });
      }
      return phase === 'error' ? t('unavailable') : t('loading');
    },
    body,
    onRequestClose: () => {
      panel.close();
      options.onClose();
    },
  });

  const loreTitle = h('h3', { class: 'cp-album-lore-title', attrs: { id: 'album-lore-title' } });
  const loreEyebrow = h('p', { class: 'cp-album-lore-eyebrow' });
  const loreText = h('p', { class: 'cp-album-lore-text', attrs: { id: 'album-lore-text' } });
  const loreMeta = h('p', { class: 'cp-album-lore-meta' });
  const loreFigure = h('p', { class: 'cp-album-lore-figure' });
  const loreCrest = h('div', { class: 'cp-album-lore-crest', attrs: { 'aria-hidden': 'true' } });
  const loreClose = h('button', {
    class: 'cp-chip cp-album-lore-close',
    attrs: { type: 'button', 'data-testid': 'album-lore-close' },
  });
  const loreFoil = h('span', { class: 'cp-album-lore-foil', attrs: { 'aria-hidden': 'true' } });
  const loreContent = h(
    'div',
    { class: 'cp-album-lore-content' },
    loreFoil,
    loreCrest,
    loreEyebrow,
    loreTitle,
    h('span', { class: 'cp-album-lore-rule', attrs: { 'aria-hidden': 'true' } }),
    loreText,
    h('footer', { class: 'cp-album-lore-foot' }, loreMeta, loreFigure),
    loreClose,
  );
  const loreCard = h(
    'article',
    {
      class: 'cp-album-lore cp-panel',
      attrs: {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'album-lore-title',
        'aria-describedby': 'album-lore-text',
        tabindex: '-1',
        'data-testid': 'album-lore',
      },
    },
    loreContent,
  );
  const loreBackdrop = h('div', {
    class: 'cp-album-lore-backdrop',
    attrs: { 'aria-hidden': 'true' },
  });
  const loreLayer = h(
    'div',
    { class: 'cp-album-lore-layer', attrs: { hidden: '' } },
    loreBackdrop,
    loreCard,
  );
  const loreMorph = sharedLayoutMorph(loreCard, loreContent, LORE_RADIUS);
  let loreSource: HTMLElement | null = null;
  let loreGeneration = 0;

  const root = h('div', { class: 'cp-ui cp-album-root' }, sheet.el, loreLayer);
  options.host.append(root);
  root.classList.toggle('is-reduced', isReducedMotion());
  ctx.own(
    onReducedMotionChange((reduced) => {
      root.classList.toggle('is-reduced', reduced);
    }),
  );
  ctx.own(
    i18n.onLanguageChanged(() => {
      render(false);
    }),
  );

  loc.text(hint, () => t('hint'));
  loc.text(tallyLabel, () => t('piecesLabel'));
  loc.text(totalCaption, () => t('albumBonusCaption'));
  loc.text(totalNone, () => t('albumBonusNone'));
  loc.text(retry, () => t('retry'));
  loc.text(loreClose, () => t('loreClose'));

  const renderDisposers: (() => void)[] = [];
  const renderCtx: UiContext = { ...ctx, own: (dispose) => renderDisposers.push(dispose) };

  function play(plan: AlbumCuePlan, withBus: boolean): void {
    if (withBus) feedback(ctx, plan.feedback);
    if (plan.haptic) options.haptics?.pulse(plan.haptic);
    const audio = options.audio?.() ?? null;
    if (!audio) return;
    for (const step of plan.chime) {
      later(step.at, () => {
        audio.playImpact(step.impact);
      });
    }
  }

  function plan(cue: AlbumCue, bonus = 0): AlbumCuePlan {
    return albumCuePlan(cue, isReducedMotion(), bonus);
  }

  function slotEl(set: AlbumSetView, slot: AlbumSlot): HTMLElement {
    const lore = slotLore(slot, set.id);
    const name = slot.owned ? slotName(slot) : t('slotMissingName');
    const label = slot.owned
      ? t('slotOwned', { name, rarity: rarityName(slot.rarity), kind: t(`kind.${slot.kind}`) })
      : t('slotMissing', { rarity: rarityName(slot.rarity) });
    const copies =
      slot.count > 1
        ? h('span', {
            class: 'cp-album-copies',
            attrs: { 'aria-hidden': 'true' },
            text: `×${formatInteger(slot.count, i18n.language)}`,
          })
        : null;
    const copiesSr = slot.count > 1 ? `, ${t('copies', { count: slot.count })}` : '';
    const inner = [
      h('span', { class: 'cp-album-medal', attrs: { 'aria-hidden': 'true' } }),
      h('span', { class: 'cp-album-slot-name', attrs: { 'aria-hidden': 'true' }, text: name }),
      copies,
    ];
    let face: HTMLElement;
    if (lore) {
      const button = h(
        'button',
        {
          class: 'cp-album-slot-face',
          attrs: {
            type: 'button',
            'aria-label': `${t('readLore', { name })}${copiesSr}`,
            'data-testid': 'album-slot-lore',
          },
        },
        ...inner,
      );
      makePressable(button, renderCtx, {
        feedback: 'tap',
        onPress: () => {
          openLore(lore, button);
        },
      });
      face = button;
    } else {
      face = h(
        'span',
        { class: 'cp-album-slot-face' },
        ...inner,
        h('span', { class: 'cp-sr-only', text: `${label}${copiesSr}` }),
      );
    }
    return h(
      'li',
      {
        class: 'cp-album-slot',
        attrs: {
          'data-testid': 'album-slot',
          'data-rarity': slot.rarity,
          'data-kind': slot.kind,
          'data-owned': String(slot.owned),
          style: accentStyle(slot.rarity),
        },
      },
      face,
    );
  }

  function pageEl(set: AlbumSetView, index: number): SetPage {
    const titleId = `album-set-${set.id}`;
    const name = setName(set.id);
    const lore = setLore(set);
    const titleButton = lore
      ? h(
          'button',
          {
            class: 'cp-album-set-lore',
            attrs: {
              type: 'button',
              'aria-label': t('readSetLore', { set: name }),
              'data-testid': 'album-set-lore',
            },
          },
          h('span', { text: name }),
          h('span', { class: 'cp-album-set-lore-mark', attrs: { 'aria-hidden': 'true' } }, '❦'),
        )
      : null;
    const title = h(
      'h3',
      { class: 'cp-album-set-title', attrs: { id: titleId } },
      titleButton ?? name,
    );
    const progress = setProgress(set);
    const meter = h(
      'div',
      {
        class: 'cp-album-meter',
        attrs: {
          role: 'progressbar',
          'aria-valuemin': '0',
          'aria-valuemax': String(set.total),
          'aria-valuenow': String(set.owned),
          'aria-label': t('setProgressLabel', { set: name, owned: set.owned, total: set.total }),
        },
      },
      h('span', { class: 'cp-album-meter-fill' }),
    );
    const bonus = h(
      'div',
      { class: 'cp-album-bonus' },
      h('span', { class: 'cp-album-bonus-label', text: t('bonusLabel') }),
      h('strong', { class: 'cp-album-bonus-value', text: bonusText(set.bonus) }),
      h('span', {
        class: 'cp-album-bonus-state',
        text: set.completed ? t('bonusEarned') : t('bonusLocked'),
      }),
    );
    const stamp = h(
      'div',
      { class: 'cp-album-stamp', attrs: { 'aria-hidden': 'true' } },
      h('span', { class: 'cp-album-stamp-ring' }, icon('laurel')),
      h('span', { class: 'cp-album-stamp-text', text: t('stamp') }),
    );
    const sparks = h('span', { class: 'cp-album-sparks', attrs: { 'aria-hidden': 'true' } });
    const page = h(
      'article',
      { class: 'cp-album-page', attrs: { 'aria-labelledby': titleId } },
      h('span', { class: 'cp-album-foil', attrs: { 'aria-hidden': 'true' } }),
      h(
        'header',
        { class: 'cp-album-set-head' },
        h(
          'div',
          { class: 'cp-album-set-heading' },
          h('p', { class: 'cp-album-venue', text: t(`venue.${set.venue}`) }),
          title,
        ),
        h(
          'div',
          { class: 'cp-album-progress' },
          h('span', {
            class: 'cp-album-progress-count',
            attrs: { 'aria-hidden': 'true' },
            text: t('setProgress', { owned: set.owned, total: set.total }),
          }),
          meter,
        ),
      ),
      h('ul', { class: 'cp-album-slots' }, ...set.slots.map((slot) => slotEl(set, slot))),
      h(
        'footer',
        { class: 'cp-album-set-foot' },
        bonus,
        h('div', { class: 'cp-album-seal' }, stamp, sparks),
      ),
    );
    const el = h(
      'li',
      {
        class: 'cp-album-set',
        attrs: {
          'data-testid': 'album-set',
          'data-set': set.id,
          'data-complete': String(set.completed),
          style: `--cp-album-progress: 0; --cp-album-deal: ${String(index * DEAL_STAGGER_MS)}ms`,
        },
      },
      page,
    );
    el.classList.toggle('is-awaiting', awaiting.has(set.id));
    el.dataset.targetProgress = String(progress);
    if (titleButton) {
      makePressable(titleButton, renderCtx, {
        feedback: 'tap',
        onPress: () => {
          if (lore) openLore(lore, titleButton);
        },
      });
    }
    return { set, el, page, stamp, sparks, bonus, meter };
  }

  function paintLedger(roll: boolean): void {
    if (!view) return;
    const language = i18n.language;
    const owned = formatInteger(view.owned, language);
    if (roll) tally.set(owned, 1);
    else tally.jump(owned);
    tallyTotal.textContent = `/ ${formatInteger(view.total, language)}`;
    const bonus = shownBonus;
    totalEl.classList.toggle('has-bonus', bonus > 0);
    const figure = `+${percent(bonus)}`;
    if (roll) total.set(figure, 1);
    else total.jump(figure);
    ledgerSr.textContent = [
      `${owned} / ${formatInteger(view.total, language)} ${t('piecesLabel')}`,
      bonus > 0 ? t('albumBonus', { value: `+${percent(bonus)}` }) : t('albumBonusNone'),
    ].join('. ');
    overall.style.setProperty(
      '--cp-album-overall',
      String(view.total ? view.owned / view.total : 0),
    );
  }

  function fillMeters(): void {
    const apply = (): void => {
      for (const page of pages.values()) {
        page.el.style.setProperty('--cp-album-progress', page.el.dataset.targetProgress ?? '0');
      }
    };
    if (isReducedMotion()) apply();
    else requestAnimationFrame(() => requestAnimationFrame(apply));
  }

  function render(deal: boolean): void {
    for (const dispose of renderDisposers.splice(0)) dispose();
    root.dataset.phase = phase;
    loading.hidden = phase !== 'loading';
    ledger.hidden = phase !== 'ready';
    const sets = phase === 'ready' && view ? view.sets : [];
    pages.clear();
    const built = sets.map((set, index) => pageEl(set, index));
    for (const page of built) pages.set(page.set.id, page);
    list.replaceChildren(...built.map((page) => page.el));
    if (deal) for (const page of built) restartAnimation(page.el, 'is-dealt');
    const isEmpty = phase === 'error' || (phase === 'ready' && sets.length === 0);
    empty.hidden = !isEmpty;
    empty.dataset.reason = phase === 'error' ? 'error' : 'none';
    emptyTitle.textContent = phase === 'error' ? t('error') : t('empty');
    retry.hidden = phase !== 'error';
    hint.hidden = phase !== 'ready' || sets.length === 0;
    paintLedger(false);
    loc.refresh();
    fillMeters();
  }

  function burst(page: SetPage, count: number): void {
    if (count === 0) return;
    const sparks = Array.from({ length: count }, (_, i) => {
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.5;
      const reach = 54 + Math.random() * 64;
      const gold = i % 3 !== 0;
      return h('span', {
        class: `cp-album-spark${gold ? '' : ' is-prism'}`,
        attrs: {
          style: `--dx: ${(Math.cos(angle) * reach).toFixed(1)}px; --dy: ${(Math.sin(angle) * reach).toFixed(1)}px; --delay: ${String(Math.round(Math.random() * 90))}ms; --spin: ${String(Math.round(Math.random() * 360))}deg`,
        },
      });
    });
    page.sparks.replaceChildren(...sparks);
    later(SPARK_LIFE_MS, () => {
      page.sparks.replaceChildren();
    });
  }

  function celebrate(id: AlbumSetKey): void {
    const page = pages.get(id);
    if (!page || !view) return;
    const cue = plan('fanfare', page.set.bonus);
    const reduced = isReducedMotion();
    // A set page can be taller than the sheet; the seal is where the stamp lands and sparks fly.
    page.stamp.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
    if (cue.hold > 0) page.el.classList.add('is-holding');
    later(cue.hold, () => {
      const current = pages.get(id);
      if (!current || !view) return;
      current.el.classList.remove('is-holding', 'is-awaiting');
      awaiting.delete(id);
      seen.write([...new Set([...(seen.read() ?? []), id])]);
      restartAnimation(current.el, cue.foil === 'sweep' ? 'is-foiling' : 'is-glowing');
      restartAnimation(current.stamp, 'is-stamping');
      restartAnimation(current.bonus, 'is-popping');
      play(cue, true);
      burst(current, cue.sparks);
      shownBonus += current.set.bonus;
      paintLedger(true);
      loc.refresh();
      status.textContent = t('fanfare', { set: setName(id), bonus: bonusText(current.set.bonus) });
    });
  }

  function scheduleFanfares(ids: readonly AlbumSetKey[]): void {
    ids.forEach((id, index) => {
      later(FANFARE_FIRST_MS + index * FANFARE_GAP_MS, () => {
        celebrate(id);
      });
    });
  }

  async function load(next: Promise<AlbumView>, deal: boolean): Promise<void> {
    const generation = ++loadGeneration;
    let fanfares: readonly AlbumSetKey[] = [];
    try {
      const loaded = await next;
      if (generation !== loadGeneration || disposed) return;
      view = loaded;
      phase = 'ready';
      // Only an open album marks completions as seen, so a set finished behind a closed sheet
      // keeps its fanfare for the next open.
      if (sheet.isOpen) {
        clearTimers();
        fanfares = newlyCompleted(seen.read(), loaded);
        awaiting = new Set(fanfares);
      } else {
        awaiting = new Set();
      }
      shownBonus = bonusBefore(loaded, fanfares);
    } catch (error) {
      if (generation !== loadGeneration || disposed) return;
      console.warn('[CoinPosh] the album could not be loaded', error);
      phase = 'error';
    }
    render(deal);
    if (deal && view && phase === 'ready') {
      tally.jump('0');
      total.jump(`+${percent(0)}`);
      paintLedger(true);
    }
    scheduleFanfares(fanfares);
  }

  function refresh(): Promise<void> {
    const first = view === null;
    if (first) {
      phase = 'loading';
      render(false);
    }
    return load(options.data.load(), first);
  }

  function paintLore(target: LoreTarget): void {
    loreCrest.replaceChildren();
    if (target.kind === 'heirloom') {
      const slot = view?.sets
        .find((set) => set.id === target.set)
        ?.slots.find((candidate) => candidate.id === target.id);
      const name = i18n.t(cratesKey(`item.${target.id}`));
      loreCard.dataset.kind = 'heirloom';
      setAccent(loreCard, 'heirloom');
      loreCrest.append(h('span', { class: 'cp-album-medal' }));
      loreEyebrow.textContent = rarityName('heirloom');
      loreTitle.textContent = name;
      loreText.textContent = t(`lore.item.${target.id}`);
      loreMeta.textContent = t('loreFromSet', { set: setName(target.set) });
      loreFigure.textContent = `${t('loreOwned')} ×${formatInteger(slot?.count ?? 1, i18n.language)}`;
    } else {
      const set = view?.sets.find((candidate) => candidate.id === target.id);
      loreCard.dataset.kind = 'set';
      setAccent(loreCard, 'legendary');
      loreCrest.append(
        h(
          'span',
          { class: 'cp-album-stamp is-static' },
          h('span', { class: 'cp-album-stamp-ring' }, icon('laurel')),
          h('span', { class: 'cp-album-stamp-text', text: t('stamp') }),
        ),
      );
      loreEyebrow.textContent = t('loreSetEyebrow');
      loreTitle.textContent = setName(target.id);
      loreText.textContent = t(`lore.set.${target.id}`);
      loreMeta.textContent = set ? t(`venue.${set.venue}`) : '';
      loreFigure.textContent = set ? `${bonusText(set.bonus)} · ${t('bonusEarned')}` : '';
    }
  }

  function openLore(target: LoreTarget, source: HTMLElement): void {
    ++loreGeneration;
    const cue = plan('lore');
    paintLore(target);
    loreSource = source;
    loreLayer.hidden = false;
    sheet.el.inert = true;
    restartAnimation(loreLayer, 'is-open');
    restartAnimation(loreCard, cue.foil === 'sweep' ? 'is-foiling' : 'is-glowing');
    restartAnimation(loreFigure, 'is-popping');
    play(cue, false);
    if (isReducedMotion()) loreMorph.jump(true);
    else void loreMorph.open(source.getBoundingClientRect());
    loreClose.focus({ preventScroll: true });
  }

  function closeLore(): void {
    if (loreLayer.hidden || !loreLayer.classList.contains('is-open')) return;
    const generation = ++loreGeneration;
    const source = loreSource;
    loreLayer.classList.remove('is-open');
    sheet.el.inert = false;
    source?.focus({ preventScroll: true });
    const finish = (): void => {
      if (generation !== loreGeneration) return;
      loreLayer.hidden = true;
    };
    if (isReducedMotion() || !source?.isConnected) {
      loreMorph.jump(false);
      later(160, finish);
    } else {
      void loreMorph.close(source.getBoundingClientRect()).then(finish);
    }
  }

  makePressable(loreClose, ctx, { feedback: 'close', onPress: closeLore });
  makePressable(retry, ctx, {
    feedback: 'tap',
    onPress: () => {
      void refresh();
    },
  });
  ctx.own(
    listen(loreBackdrop, 'pointerdown', () => {
      feedback(ctx, 'close');
      closeLore();
    }),
  );
  ctx.own(
    listen(loreLayer, 'keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        feedback(ctx, 'close');
        closeLore();
      } else if (event.key === 'Tab') {
        event.preventDefault();
        loreClose.focus();
      }
    }),
  );

  const panel: AlbumPanel = {
    el: root,
    get isOpen() {
      return sheet.isOpen;
    },
    open(trigger) {
      if (sheet.isOpen) return;
      play(plan('open'), true);
      sheet.open(trigger);
      restartAnimation(root, 'is-opening');
      for (const page of pages.values()) page.el.style.setProperty('--cp-album-progress', '0');
      if (view === null) {
        phase = 'loading';
        render(false);
      }
      void load(options.data.load(), true);
    },
    close() {
      clearTimers();
      if (!loreLayer.hidden) {
        loreLayer.classList.remove('is-open');
        loreLayer.hidden = true;
        loreMorph.jump(false);
        sheet.el.inert = false;
      }
      for (const id of awaiting) pages.get(id)?.el.classList.remove('is-holding');
      sheet.close();
    },
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimers();
      for (const dispose of renderDisposers.splice(0)) dispose();
      for (const dispose of disposers.splice(0)) dispose();
      loc.dispose();
      root.remove();
    },
  };
  render(false);
  return panel;
}
