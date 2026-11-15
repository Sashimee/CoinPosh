import './season.css';
import { QUEST_DIFFICULTIES } from '@coinposh/economy';
import {
  DEFAULT_FEATURE_FLAGS,
  IdempotencyKeySchema,
  type FeatureFlags,
  type IdempotencyKey,
  type QuestCadence,
  type QuestClaimResponse,
  type RewardPreview,
} from '@coinposh/shared';
import type { UiApp } from '../../app/index.ts';
import type { AudioEngine } from '../../audio/index.ts';
import { formatInteger } from '../../i18n/index.ts';
import type { HapticPattern } from '../../vfx/haptics.ts';
import { makePressable } from '../components/pressable.ts';
import { Odometer } from '../components/odometer.ts';
import { feedback, type UiContext } from '../context.ts';
import { h, listen, restartAnimation } from '../dom.ts';
import { Localizer } from '../localize.ts';
import { isReducedMotion, onReducedMotionChange } from '../motion/reduced.ts';
import { createSheet } from '../panels/sheet.ts';
import { QuestClaims } from './claim.ts';
import { loadSeasonStrings, seasonT } from './i18n.ts';
import { seasonIcon } from './icons.ts';
import { seasonCuePlan, type SeasonCue, type SeasonCuePlan } from './juice.ts';
import {
  questsView,
  seasonView,
  starsIn,
  timeLeft,
  withClaimedQuest,
  withQuestMarkedClaimed,
  type QuestCardView,
  type QuestsView,
  type SeasonData,
  type SeasonView,
  type TierView,
} from './model.ts';
import {
  questAction,
  questProgressText,
  questTitle,
  rewardPreviews,
  rewardText,
  rewardsText,
  tierLabel,
  tierStateText,
  timeText,
  type TrackSide,
} from './present.ts';

export type SeasonAudioPort = Pick<AudioEngine, 'playImpact'>;

export type SeasonTab = 'quests' | 'season';

export interface SeasonMountOptions {
  readonly ui: Pick<UiApp, 'store' | 'bus' | 'i18n'>;
  /** Usually the UI root over the canvas. */
  readonly host: HTMLElement;
  readonly data: SeasonData;
  readonly audio?: (() => SeasonAudioPort | null) | null;
  readonly haptics?: { pulse(pattern: HapticPattern): boolean } | null;
  /** Called after the panel closes itself (close button, backdrop, drag or Escape). */
  readonly onClose: () => void;
  /** Called with each paid claim, so the wallet and HUD can take the server's new balances. */
  readonly onClaimed?: (response: QuestClaimResponse) => void;
  readonly flags?: FeatureFlags;
  /** The clock the countdowns read; pass the server-corrected one when there is one. */
  readonly now?: () => number;
  readonly newKey?: () => IdempotencyKey;
}

export interface SeasonPanel {
  readonly el: HTMLElement;
  readonly isOpen: boolean;
  open(trigger: HTMLElement, tab?: SeasonTab): void;
  close(): void;
  /** Re-reads quests and the season, e.g. after play that counts toward a quest. */
  refresh(): Promise<void>;
  dispose(): void;
}

type Phase = 'loading' | 'ready' | 'error';

interface CardRefs {
  readonly card: QuestCardView;
  readonly el: HTMLElement;
  readonly sparks: HTMLElement;
  readonly pops: HTMLElement;
  readonly stamp: HTMLElement | null;
  readonly action: HTMLElement;
}

const TICK_MS = 30_000;
const SPARK_LIFE_MS = 950;
const POP_STAGGER_MS = 110;
const POP_LIFE_MS = 1300;

function newIdempotencyKey(): IdempotencyKey {
  return IdempotencyKeySchema.parse(crypto.randomUUID());
}

/**
 * Daily and weekly quests, the streak and the season track in one sheet. Loads its strings
 * first, so it resolves once they are registered and every label it paints is translated.
 */
export async function mountSeason(options: SeasonMountOptions): Promise<SeasonPanel> {
  await loadSeasonStrings(options.ui.i18n);
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
  const t = seasonT(i18n);
  const flags = options.flags ?? DEFAULT_FEATURE_FLAGS;
  const now = options.now ?? (() => Date.now());
  const claims = new QuestClaims(
    (questId, key) => options.data.claim(questId, key),
    options.newKey ?? newIdempotencyKey,
  );
  const n = (value: number): string => formatInteger(value, i18n.language);

  let quests: QuestsView | null = null;
  let season: SeasonView | null = null;
  let questsPhase: Phase = 'loading';
  let seasonPhase: Phase = 'loading';
  let tab: SeasonTab = 'quests';
  let questsGeneration = 0;
  let seasonGeneration = 0;
  let disposed = false;
  let tick: ReturnType<typeof setInterval> | null = null;
  let expiredAt: number | null = null;
  const cards = new Map<string, CardRefs>();
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

  const tabButtons: Record<SeasonTab, HTMLButtonElement> = {
    quests: h('button', {
      class: 'cp-season-tab',
      attrs: {
        type: 'button',
        role: 'tab',
        id: 'season-tab-quests',
        'aria-controls': 'season-panel-quests',
        'data-testid': 'season-tab-quests',
      },
    }),
    season: h('button', {
      class: 'cp-season-tab',
      attrs: {
        type: 'button',
        role: 'tab',
        id: 'season-tab-season',
        'aria-controls': 'season-panel-season',
        'data-testid': 'season-tab-season',
      },
    }),
  };
  const questsTabLabel = h('span', { class: 'cp-season-tab-label' });
  const readyBadge = h('span', {
    class: 'cp-season-badge',
    attrs: { 'aria-hidden': 'true', 'data-testid': 'season-ready-badge', hidden: '' },
  });
  const readySr = h('span', { class: 'cp-sr-only' });
  tabButtons.quests.append(questsTabLabel, readyBadge, readySr);
  const seasonTabLabel = h('span', { class: 'cp-season-tab-label' });
  tabButtons.season.append(seasonTabLabel);
  const tabInk = h('span', { class: 'cp-season-tab-ink', attrs: { 'aria-hidden': 'true' } });
  const tabList = h(
    'div',
    { class: 'cp-season-tabs', attrs: { role: 'tablist' } },
    tabInk,
    tabButtons.quests,
    tabButtons.season,
  );

  const streakDays = new Odometer();
  const streakUnit = h('span', { class: 'cp-season-streak-unit' });
  const streakTitle = h('p', { class: 'cp-season-eyebrow' });
  const streakNone = h('p', { class: 'cp-season-streak-none' });
  const freezePips = h('span', {
    class: 'cp-season-freeze-pips',
    attrs: { 'aria-hidden': 'true' },
  });
  const freezeLabel = h('span', { class: 'cp-season-freeze-label' });
  const freezeHint = h('p', { class: 'cp-season-freeze-hint' });
  const nextLabel = h('span', { class: 'cp-season-next-label' });
  const nextDay = h('strong', { class: 'cp-season-next-day' });
  const nextIn = h('span', { class: 'cp-season-next-in' });
  const nextFill = h('span', { class: 'cp-season-bar-fill' });
  const nextBar = h('span', { class: 'cp-season-bar', attrs: { 'aria-hidden': 'true' } }, nextFill);
  const nextRewards = h('ul', { class: 'cp-season-rewards' });
  const streakSr = h('p', { class: 'cp-sr-only' });
  const streakCard = h(
    'section',
    { class: 'cp-season-streak', attrs: { 'data-testid': 'season-streak' } },
    h('span', { class: 'cp-season-sheen', attrs: { 'aria-hidden': 'true' } }),
    h(
      'div',
      { class: 'cp-season-streak-head', attrs: { 'aria-hidden': 'true' } },
      h('span', { class: 'cp-season-flame' }, seasonIcon('flame')),
      h(
        'div',
        { class: 'cp-season-streak-figure' },
        streakTitle,
        h('p', { class: 'cp-season-streak-count' }, streakDays.el, streakUnit),
      ),
      h(
        'div',
        { class: 'cp-season-freezes', attrs: { 'data-testid': 'season-freezes' } },
        freezePips,
        freezeLabel,
      ),
    ),
    streakSr,
    streakNone,
    h(
      'div',
      { class: 'cp-season-next' },
      h('p', { class: 'cp-season-next-head' }, nextLabel, nextDay, nextIn),
      nextBar,
      nextRewards,
    ),
    freezeHint,
  );

  function cadenceSection(cadence: QuestCadence) {
    const title = h('h3', { class: 'cp-season-section-title', attrs: { id: `season-${cadence}` } });
    const resets = h('span', { class: 'cp-season-resets' });
    const list = h('ul', {
      class: 'cp-season-quests',
      attrs: { 'aria-labelledby': `season-${cadence}`, 'data-testid': `season-${cadence}` },
    });
    const empty = h('p', { class: 'cp-season-quests-empty', attrs: { hidden: '' } });
    const el = h(
      'section',
      { class: 'cp-season-section' },
      h('header', { class: 'cp-season-section-head' }, title, resets),
      list,
      empty,
    );
    loc.text(title, () => t(`quests.${cadence}`));
    loc.text(empty, () => t('quests.empty'));
    return { el, resets, list, empty };
  }
  const sections = { daily: cadenceSection('daily'), weekly: cadenceSection('weekly') };

  function stateBlock(testid: string) {
    const loading = h(
      'div',
      { class: 'cp-season-loading', attrs: { 'aria-busy': 'true' } },
      ...Array.from({ length: 3 }, () => h('span', { class: 'cp-season-shimmer' })),
    );
    const title = h('p', { class: 'cp-season-error-title' });
    const retry = h('button', {
      class: 'cp-chip cp-season-retry',
      attrs: { type: 'button', 'data-testid': `${testid}-retry` },
    });
    const error = h(
      'div',
      { class: 'cp-season-error', attrs: { hidden: '', 'data-testid': `${testid}-error` } },
      title,
      retry,
    );
    loc.text(title, () => t('error'));
    loc.text(retry, () => t('retry'));
    return { loading, error, retry };
  }
  const questsState = stateBlock('season-quests');
  const seasonState = stateBlock('season-track');

  const questsContent = h(
    'div',
    { class: 'cp-season-quests-content' },
    streakCard,
    sections.daily.el,
    sections.weekly.el,
  );
  const questsPanel = h(
    'div',
    {
      class: 'cp-season-panel',
      attrs: {
        role: 'tabpanel',
        id: 'season-panel-quests',
        'aria-labelledby': 'season-tab-quests',
        'data-testid': 'season-panel-quests',
      },
    },
    questsState.loading,
    questsState.error,
    questsContent,
  );

  const stars = new Odometer();
  const starsLabel = h('span', { class: 'cp-season-stars-label' });
  const tierOf = h('p', { class: 'cp-season-tier-of' });
  const tierFill = h('span', { class: 'cp-season-bar-fill' });
  const tierBar = h('span', { class: 'cp-season-bar', attrs: { 'aria-hidden': 'true' } }, tierFill);
  const toNext = h('p', { class: 'cp-season-to-next' });
  const trackSr = h('p', { class: 'cp-sr-only' });
  const trackHead = h(
    'div',
    { class: 'cp-season-track-head' },
    h('span', { class: 'cp-season-sheen', attrs: { 'aria-hidden': 'true' } }),
    h(
      'div',
      { class: 'cp-season-stars', attrs: { 'aria-hidden': 'true' } },
      h('span', { class: 'cp-season-star' }, seasonIcon('star')),
      h('p', { class: 'cp-season-stars-figure' }, stars.el, starsLabel),
      tierOf,
    ),
    tierBar,
    toNext,
    trackSr,
  );
  const freeRowLabel = h('span', { class: 'cp-season-row-name' });
  const premiumRowLabel = h('span', { class: 'cp-season-row-name' });
  const ribbon = h('span', {
    class: 'cp-season-ribbon',
    attrs: { 'data-testid': 'season-coming-soon' },
  });
  const rowLabels = h(
    'div',
    { class: 'cp-season-row-labels', attrs: { 'aria-hidden': 'true' } },
    h('span', { class: 'cp-season-row-label is-medal' }),
    h('span', { class: 'cp-season-row-label is-free' }, freeRowLabel),
    h('span', { class: 'cp-season-row-label is-premium' }, premiumRowLabel, ribbon),
  );
  const rail = h('ol', { class: 'cp-season-rail', attrs: { 'data-testid': 'season-rail' } });
  const premiumNote = h('p', {
    class: 'cp-season-premium-note',
    attrs: { 'data-testid': 'season-premium-note' },
  });
  const trackContent = h(
    'div',
    { class: 'cp-season-track-content' },
    trackHead,
    h('div', { class: 'cp-season-track' }, rowLabels, rail),
    premiumNote,
  );
  const seasonPanel = h(
    'div',
    {
      class: 'cp-season-panel',
      attrs: {
        role: 'tabpanel',
        id: 'season-panel-season',
        'aria-labelledby': 'season-tab-season',
        'data-testid': 'season-panel-season',
        hidden: '',
      },
    },
    seasonState.loading,
    seasonState.error,
    trackContent,
  );

  const status = h('p', {
    class: 'cp-sr-only',
    attrs: { 'aria-live': 'polite', 'data-testid': 'season-status' },
  });
  const body = h(
    'div',
    { class: 'cp-season', attrs: { 'data-testid': 'season' } },
    tabList,
    questsPanel,
    seasonPanel,
    status,
  );

  const sheet = createSheet(ctx, {
    id: 'season',
    title: () => t('title'),
    subtitle: () => {
      if (season) {
        const left = season.endsAt - now();
        return left > 0
          ? t('subtitle', { time: timeText(t, timeLeft(season.endsAt, now()), i18n.language) })
          : t('subtitleEnded');
      }
      return seasonPhase === 'error' ? t('unavailable') : t('loading');
    },
    body,
    onRequestClose: () => {
      panel.close();
      options.onClose();
    },
  });

  const root = h('div', { class: 'cp-ui cp-season-root' }, sheet.el);
  options.host.append(root);
  root.classList.toggle('is-reduced', isReducedMotion());
  ctx.own(
    onReducedMotionChange((reduced) => {
      root.classList.toggle('is-reduced', reduced);
    }),
  );
  ctx.own(
    i18n.onLanguageChanged(() => {
      renderQuests();
      renderSeason(false);
    }),
  );

  loc.attr(tabList, 'aria-label', () => t('tabs.label'));
  loc.text(questsTabLabel, () => t('tabs.quests'));
  loc.text(seasonTabLabel, () => t('tabs.season'));
  loc.text(streakTitle, () => t('streak.title'));
  loc.text(streakNone, () => t('streak.none'));
  loc.text(freezeHint, () => t('streak.freezeHint'));
  loc.text(nextLabel, () => t('streak.nextLabel'));
  loc.text(starsLabel, () => t('season.stars'));
  loc.text(freeRowLabel, () => t('season.free'));
  loc.text(premiumRowLabel, () => t('season.premium'));
  loc.text(ribbon, () => t('season.comingSoon'));
  loc.text(premiumNote, () => t('season.premiumLocked'));

  function play(plan: SeasonCuePlan): void {
    feedback(ctx, plan.feedback);
    if (plan.haptic) options.haptics?.pulse(plan.haptic);
    const audio = options.audio?.() ?? null;
    if (!audio) return;
    for (const step of plan.chime) {
      later(step.at, () => {
        audio.playImpact(step.impact);
      });
    }
  }

  function plan(cue: SeasonCue): SeasonCuePlan {
    return seasonCuePlan(cue, isReducedMotion());
  }

  const cardDisposers = new Map<string, (() => void)[]>();

  function rewardChips(rewards: readonly RewardPreview[]): HTMLElement[] {
    return rewards.map((reward) =>
      h('li', {
        class: 'cp-season-reward',
        attrs: { 'data-kind': reward.kind === 'currency' ? reward.currency : reward.kind },
        text: rewardText(t, reward, i18n.language),
      }),
    );
  }

  function selectTab(next: SeasonTab, cue: boolean): void {
    const changed = next !== tab;
    tab = next;
    for (const [name, button] of Object.entries(tabButtons) as [SeasonTab, HTMLButtonElement][]) {
      const selected = name === tab;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    tabList.dataset.tab = tab;
    questsPanel.hidden = tab !== 'quests';
    seasonPanel.hidden = tab !== 'season';
    if (cue && changed) {
      play(plan('tab'));
      restartAnimation(tab === 'quests' ? questsPanel : seasonPanel, 'is-entering');
    }
    if (tab === 'season') later(0, centreCurrentTier);
  }

  function centreCurrentTier(): void {
    if (!season || seasonPanel.hidden) return;
    const index = Math.min(season.tier, season.total - 1);
    const target = rail.children.item(index);
    if (!(target instanceof HTMLElement)) return;
    const left = target.offsetLeft - (rail.clientWidth - target.offsetWidth) / 2;
    rail.scrollTo({ left: Math.max(0, left), behavior: isReducedMotion() ? 'auto' : 'smooth' });
  }

  function paintBadge(): void {
    const count = quests?.claimable ?? 0;
    readyBadge.hidden = count === 0;
    readyBadge.textContent = n(count);
    readySr.textContent = count > 0 ? `, ${t('tabs.ready', { count })}` : '';
  }

  function paintStreak(roll: boolean): void {
    if (!quests) return;
    const { streak } = quests;
    const days = n(streak.days);
    if (roll) streakDays.set(days, 1);
    else streakDays.jump(days);
    streakUnit.textContent = t('streak.days', { count: streak.days });
    streakCard.dataset.active = String(streak.days > 0);
    streakNone.hidden = streak.days > 0;
    freezePips.replaceChildren(
      ...Array.from({ length: streak.maxFreezes }, (_, i) =>
        h(
          'span',
          { class: `cp-season-freeze${i < streak.freezes ? ' is-held' : ''}` },
          seasonIcon('snowflake'),
        ),
      ),
    );
    freezeLabel.textContent = t('streak.freezes', {
      count: streak.freezes,
      max: n(streak.maxFreezes),
    });
    nextDay.textContent = t('streak.next', { day: n(streak.next.day) });
    nextIn.textContent = t('streak.nextIn', { count: streak.next.remaining });
    nextFill.style.setProperty('--cp-season-fill', String(streak.next.fraction));
    const bonus =
      streak.next.freezes > 0
        ? [
            h('li', {
              class: 'cp-season-reward is-freeze',
              text: t('streak.bonusFreeze', { count: streak.next.freezes }),
            }),
          ]
        : [];
    nextRewards.replaceChildren(...rewardChips(streak.next.rewards), ...bonus);
    streakSr.textContent = [
      t('streak.summary', { count: streak.days }),
      t('streak.freezes', { count: streak.freezes, max: n(streak.maxFreezes) }),
      `${t('streak.nextLabel')}: ${t('streak.next', { day: n(streak.next.day) })}, ${t('streak.nextIn', { count: streak.next.remaining })}, ${rewardsText(t, streak.next.rewards, i18n.language)}`,
    ].join('. ');
  }

  function cardEl(card: QuestCardView): CardRefs {
    const owned: (() => void)[] = [];
    cardDisposers.set(card.id, owned);
    const cardCtx: UiContext = { ...ctx, own: (dispose) => owned.push(dispose) };
    const claimStatus = claims.status(card.id);
    const action = questAction(card, claimStatus);
    const title = questTitle(t, card, i18n.language);
    const titleId = `season-quest-${card.id}`;
    const rewards = rewardsText(t, card.rewards, i18n.language);
    const progressText = questProgressText(t, card, i18n.language);
    let actionEl: HTMLElement;
    let stamp: HTMLElement | null = null;
    if (action === 'claim' || action === 'retry' || action === 'claiming') {
      const button = h('button', {
        class: `cp-season-action is-${action}`,
        attrs: {
          type: 'button',
          'data-testid': 'season-claim',
          'aria-label':
            action === 'retry'
              ? t('quest.retryLabel', { title })
              : t('quest.claimLabel', { rewards, title }),
        },
        text:
          action === 'claim'
            ? t('quest.claim')
            : action === 'retry'
              ? t('quest.retry')
              : t('quest.claiming'),
      });
      if (action === 'claiming') {
        button.setAttribute('aria-disabled', 'true');
        button.setAttribute('aria-busy', 'true');
      }
      makePressable(button, cardCtx, {
        feedback: 'tap',
        enabled: () => claims.status(card.id) !== 'pending',
        onPress: () => {
          void claim(card.id);
        },
      });
      actionEl = button;
    } else if (action === 'claimed' || action === 'already') {
      stamp = h(
        'span',
        { class: `cp-season-stamp${action === 'already' ? ' is-already' : ''}` },
        h('span', { class: 'cp-season-stamp-ring' }, seasonIcon('check')),
        h('span', {
          class: 'cp-season-stamp-text',
          text: action === 'already' ? t('quest.already') : t('quest.claimed'),
        }),
      );
      actionEl = h('div', { class: 'cp-season-action is-done' }, stamp);
    } else {
      actionEl = h('div', {
        class: 'cp-season-action is-progress',
        attrs: { 'aria-hidden': 'true' },
        text: `${String(Math.floor(card.fraction * 100))}%`,
      });
    }
    const sparks = h('span', { class: 'cp-season-sparks', attrs: { 'aria-hidden': 'true' } });
    const pops = h('span', { class: 'cp-season-pops', attrs: { 'aria-hidden': 'true' } });
    const el = h(
      'li',
      {
        class: 'cp-season-quest',
        attrs: {
          'data-testid': 'season-quest',
          'data-quest': card.id,
          'data-state': action,
          'data-difficulty': card.difficulty,
          style: `--cp-season-fill: ${String(card.fraction)}`,
        },
      },
      h(
        'article',
        { class: 'cp-season-quest-card', attrs: { 'aria-labelledby': titleId } },
        h('span', { class: 'cp-season-sheen', attrs: { 'aria-hidden': 'true' } }),
        h(
          'header',
          { class: 'cp-season-quest-head' },
          h(
            'span',
            { class: 'cp-season-difficulty' },
            h(
              'span',
              { class: 'cp-season-pips', attrs: { 'aria-hidden': 'true' } },
              ...QUEST_DIFFICULTIES.map((level, i) =>
                h('span', {
                  class: `cp-season-pip${i <= QUEST_DIFFICULTIES.indexOf(card.difficulty) ? ' is-on' : ''}`,
                  attrs: { 'data-level': level },
                }),
              ),
            ),
            h('span', { text: t(`difficulty.${card.difficulty}`) }),
          ),
          h('h4', { class: 'cp-season-quest-title', attrs: { id: titleId }, text: title }),
        ),
        h(
          'div',
          { class: 'cp-season-quest-progress' },
          h(
            'span',
            {
              class: 'cp-season-bar',
              attrs: {
                role: 'progressbar',
                'aria-valuemin': '0',
                'aria-valuemax': String(card.target),
                'aria-valuenow': String(card.progress),
                'aria-label': t('quest.progressLabel', {
                  title,
                  progress: n(card.progress),
                  target: n(card.target),
                }),
              },
            },
            h('span', { class: 'cp-season-bar-fill' }),
          ),
          h('span', {
            class: 'cp-season-quest-count',
            attrs: { 'aria-hidden': 'true' },
            text: progressText,
          }),
        ),
        h(
          'footer',
          { class: 'cp-season-quest-foot' },
          h(
            'ul',
            {
              class: 'cp-season-rewards',
              attrs: { 'aria-label': t('quest.rewardsLabel', { rewards }) },
            },
            ...rewardChips(card.rewards),
          ),
          actionEl,
        ),
        claimStatus === 'failed'
          ? h('p', {
              class: 'cp-season-quest-note',
              attrs: { 'data-testid': 'season-claim-error' },
              text: t('quest.failed'),
            })
          : null,
        sparks,
        pops,
      ),
    );
    return { card, el, sparks, pops, stamp, action: actionEl };
  }

  function disposeCard(id: string): void {
    for (const dispose of cardDisposers.get(id)?.splice(0) ?? []) dispose();
    cardDisposers.delete(id);
  }

  /** Repaints one card in place, keeping focus on its action when the player had it there. */
  function repaintCard(id: string): CardRefs | null {
    const old = cards.get(id);
    const card = [...(quests?.daily ?? []), ...(quests?.weekly ?? [])].find((c) => c.id === id);
    if (!old || !card) return null;
    const hadFocus = old.el.contains(document.activeElement);
    disposeCard(id);
    const next = cardEl(card);
    next.el.style.setProperty('--cp-season-fill', String(card.fraction));
    old.el.replaceWith(next.el);
    cards.set(id, next);
    if (hadFocus) {
      const target = next.action instanceof HTMLButtonElement ? next.action : next.el;
      if (target === next.el) next.el.tabIndex = -1;
      target.focus({ preventScroll: true });
    }
    return next;
  }

  function paintResets(): void {
    if (!quests) return;
    for (const cadence of ['daily', 'weekly'] as const) {
      const at = quests.resets[cadence];
      sections[cadence].resets.textContent =
        at === null
          ? ''
          : t('quests.resets', { time: timeText(t, timeLeft(at, now()), i18n.language) });
    }
  }

  function renderQuests(deal = false): void {
    for (const id of [...cardDisposers.keys()]) disposeCard(id);
    cards.clear();
    questsPanel.dataset.phase = questsPhase;
    questsState.loading.hidden = questsPhase !== 'loading';
    questsState.error.hidden = questsPhase !== 'error';
    questsContent.hidden = questsPhase !== 'ready' || !quests;
    if (quests && questsPhase === 'ready') {
      for (const cadence of ['daily', 'weekly'] as const) {
        const built = quests[cadence].map(cardEl);
        for (const refs of built) cards.set(refs.card.id, refs);
        sections[cadence].list.replaceChildren(...built.map((refs) => refs.el));
        sections[cadence].empty.hidden = built.length > 0;
        built.forEach((refs, i) => {
          refs.el.style.setProperty('--cp-season-deal', `${String(i * 60)}ms`);
          if (deal) restartAnimation(refs.el, 'is-dealt');
        });
      }
      paintStreak(false);
      paintResets();
    }
    paintBadge();
    loc.refresh();
  }

  function tierCell(tier: TierView, side: TrackSide): HTMLElement {
    const rewards = side === 'free' ? tier.free : tier.premium;
    const state = side === 'free' ? tier.freeState : tier.premiumState;
    return h(
      'div',
      {
        class: `cp-season-cell is-${side}`,
        attrs: {
          'data-state': state,
          'data-testid': `season-${side}-cell`,
          'aria-label': tierLabel(t, tier, side, i18n.language),
          role: 'group',
        },
      },
      state === 'comingSoon' || state === 'locked'
        ? h(
            'span',
            { class: 'cp-season-cell-lock', attrs: { 'aria-hidden': 'true' } },
            seasonIcon('lock'),
          )
        : state === 'claimed'
          ? h(
              'span',
              { class: 'cp-season-cell-check', attrs: { 'aria-hidden': 'true' } },
              seasonIcon('check'),
            )
          : null,
      h(
        'ul',
        { class: 'cp-season-cell-rewards', attrs: { 'aria-hidden': 'true' } },
        ...rewardChips(rewards),
      ),
      h('span', {
        class: 'cp-season-cell-state',
        attrs: { 'aria-hidden': 'true' },
        text: tierStateText(t, tier, side),
      }),
    );
  }

  function paintTrackHead(roll: boolean): void {
    if (!season) return;
    const figure = n(season.stars);
    if (roll) stars.set(figure, 1);
    else stars.jump(figure);
    tierOf.textContent = t('season.tierOf', { tier: n(season.tier), total: n(season.total) });
    tierFill.style.setProperty('--cp-season-fill', String(season.next ? season.next.fraction : 1));
    toNext.textContent = season.next
      ? t('season.toNext', {
          count: season.next.remaining,
          value: n(season.next.remaining),
          tier: n(season.next.tier),
        })
      : t('season.complete');
    trackSr.textContent = t('season.progressLabel', {
      stars: n(season.stars),
      tier: n(season.tier),
      total: n(season.total),
    });
  }

  function renderSeason(roll: boolean): void {
    seasonPanel.dataset.phase = seasonPhase;
    seasonState.loading.hidden = seasonPhase !== 'loading';
    seasonState.error.hidden = seasonPhase !== 'error';
    trackContent.hidden = seasonPhase !== 'ready' || !season;
    if (season && seasonPhase === 'ready') {
      const current = season.tier;
      rail.replaceChildren(
        ...season.tiers.map((tier) =>
          h(
            'li',
            {
              class: `cp-season-tier${tier.tier === current ? ' is-current' : ''}${tier.tier === current + 1 ? ' is-next' : ''}`,
              attrs: {
                'data-testid': 'season-tier',
                'data-tier': String(tier.tier),
                'data-reached': String(tier.freeState !== 'locked'),
              },
            },
            h(
              'span',
              { class: 'cp-season-medal', attrs: { 'aria-hidden': 'true' } },
              h('span', { class: 'cp-season-medal-number', text: n(tier.tier) }),
            ),
            tierCell(tier, 'free'),
            tierCell(tier, 'premium'),
          ),
        ),
      );
      root.dataset.premium = season.premiumOpen ? 'open' : 'comingSoon';
      ribbon.hidden = season.premiumOpen;
      premiumNote.hidden = season.premiumOpen;
      paintTrackHead(roll);
    }
    loc.refresh();
  }

  function burst(refs: CardRefs, count: number): void {
    if (count === 0) return;
    const sparks = Array.from({ length: count }, (_, i) => {
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.5;
      const reach = 40 + Math.random() * 54;
      return h('span', {
        class: `cp-season-spark${i % 3 === 0 ? ' is-sea' : ''}`,
        attrs: {
          style: `--dx: ${(Math.cos(angle) * reach).toFixed(1)}px; --dy: ${(Math.sin(angle) * reach).toFixed(1)}px; --delay: ${String(Math.round(Math.random() * 80))}ms; --spin: ${String(Math.round(Math.random() * 360))}deg`,
        },
      });
    });
    refs.sparks.replaceChildren(...sparks);
    later(SPARK_LIFE_MS, () => {
      refs.sparks.replaceChildren();
    });
  }

  function popRewards(
    refs: CardRefs,
    rewards: readonly RewardPreview[],
    mode: 'float' | 'pulse',
  ): void {
    refs.pops.replaceChildren(
      ...rewards.map((reward, i) =>
        h('span', {
          class: `cp-season-pop is-${mode}`,
          attrs: {
            style: `--cp-season-pop-delay: ${String(i * POP_STAGGER_MS)}ms; --cp-season-pop-i: ${String(i)}`,
          },
          text: `+${rewardText(t, reward, i18n.language)}`,
        }),
      ),
    );
    later(POP_LIFE_MS + rewards.length * POP_STAGGER_MS, () => {
      refs.pops.replaceChildren();
    });
  }

  async function claim(id: string): Promise<void> {
    const card = cards.get(id)?.card;
    if (!card) return;
    const pending = claims.claim(card.id);
    repaintCard(id);
    const outcome = await pending;
    if (disposed || outcome.kind === 'ignored') return;
    const title = questTitle(t, card, i18n.language);
    if (outcome.kind === 'claimed') {
      const { response } = outcome;
      if (quests) quests = withClaimedQuest(quests, response.quest);
      const cue = plan('claim');
      const refs = cards.get(id);
      if (refs && cue.hold > 0) refs.el.classList.add('is-holding');
      options.onClaimed?.(response);
      later(cue.hold, () => {
        const next = repaintCard(id);
        if (next) {
          next.el.classList.remove('is-holding');
          restartAnimation(next.el, cue.light === 'sweep' ? 'is-sweeping' : 'is-glowing');
          if (next.stamp) restartAnimation(next.stamp, 'is-stamping');
          burst(next, cue.sparks);
          popRewards(next, rewardPreviews(response.rewards), cue.pop ?? 'pulse');
        }
        play(cue);
        paintBadge();
        restartAnimation(readyBadge, 'is-popping');
        status.textContent = t('quest.claimedStatus', {
          rewards: rewardsText(t, rewardPreviews(response.rewards), i18n.language),
        });
      });
      if (starsIn(response.rewards) > 0 || season === null) void loadSeason(true);
      return;
    }
    if (outcome.kind === 'already') {
      if (quests) quests = withQuestMarkedClaimed(quests, card.id);
      const next = repaintCard(id);
      const cue = plan('already');
      if (next?.stamp) restartAnimation(next.stamp, 'is-glowing');
      play(cue);
      paintBadge();
      status.textContent = t('quest.alreadyStatus', { title });
      void loadQuests(false);
      void loadSeason(true);
      return;
    }
    console.warn('[CoinPosh] a quest claim did not go through', outcome.error);
    const next = repaintCard(id);
    play(plan('failed'));
    if (next) restartAnimation(next.el, 'is-denied');
    status.textContent = t('quest.failedStatus', { title });
  }

  async function loadQuests(deal: boolean): Promise<void> {
    const generation = ++questsGeneration;
    try {
      const loaded = questsView(await options.data.quests());
      if (generation !== questsGeneration || disposed) return;
      if (claims.busy) return;
      claims.forgetSettled();
      quests = loaded;
      questsPhase = 'ready';
      expiredAt = null;
    } catch (error) {
      if (generation !== questsGeneration || disposed) return;
      console.warn('[CoinPosh] quests could not be loaded', error);
      if (!quests) questsPhase = 'error';
    }
    renderQuests(deal);
    if (deal && quests && questsPhase === 'ready') {
      streakDays.jump('0');
      paintStreak(true);
    }
  }

  async function loadSeason(roll: boolean): Promise<void> {
    const generation = ++seasonGeneration;
    const before = season?.stars ?? null;
    try {
      const loaded = seasonView(await options.data.season(), flags);
      if (generation !== seasonGeneration || disposed) return;
      season = loaded;
      seasonPhase = 'ready';
    } catch (error) {
      if (generation !== seasonGeneration || disposed) return;
      console.warn('[CoinPosh] the season could not be loaded', error);
      if (!season) seasonPhase = 'error';
    }
    renderSeason(false);
    if (roll && season && seasonPhase === 'ready') {
      if (before === null) stars.jump('0');
      else stars.jump(n(before));
      paintTrackHead(true);
      if (before !== null && season.stars > before) restartAnimation(trackHead, 'is-glowing');
    }
    if (tab === 'season') later(0, centreCurrentTier);
  }

  function refresh(): Promise<void> {
    return Promise.all([loadQuests(false), loadSeason(false)]).then(() => undefined);
  }

  function onTick(): void {
    paintResets();
    loc.refresh();
    if (!quests) return;
    const due = [quests.resets.daily, quests.resets.weekly].filter(
      (at): at is number => at !== null && at <= now(),
    );
    const first = due.length > 0 ? Math.min(...due) : null;
    if (first !== null && first !== expiredAt) {
      expiredAt = first;
      void loadQuests(true);
    }
  }

  function startTick(): void {
    if (tick !== null) return;
    tick = setInterval(onTick, TICK_MS);
  }

  function stopTick(): void {
    if (tick === null) return;
    clearInterval(tick);
    tick = null;
  }

  for (const [name, button] of Object.entries(tabButtons) as [SeasonTab, HTMLButtonElement][]) {
    makePressable(button, ctx, {
      feedback: 'toggle',
      enabled: () => true,
      onPress: () => {
        selectTab(name, true);
      },
    });
  }
  ctx.own(
    listen(tabList, 'keydown', (event) => {
      if (
        event.key !== 'ArrowLeft' &&
        event.key !== 'ArrowRight' &&
        event.key !== 'Home' &&
        event.key !== 'End'
      )
        return;
      event.preventDefault();
      const order: readonly SeasonTab[] = ['quests', 'season'];
      const index = order.indexOf(tab);
      const next =
        event.key === 'Home'
          ? order[0]
          : event.key === 'End'
            ? order[order.length - 1]
            : order[(index + (event.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length];
      if (next === undefined) return;
      selectTab(next, true);
      tabButtons[next].focus();
    }),
  );
  makePressable(questsState.retry, ctx, {
    feedback: 'tap',
    onPress: () => {
      questsPhase = 'loading';
      renderQuests();
      void loadQuests(true);
    },
  });
  makePressable(seasonState.retry, ctx, {
    feedback: 'tap',
    onPress: () => {
      seasonPhase = 'loading';
      renderSeason(false);
      void loadSeason(true);
    },
  });

  const panel: SeasonPanel = {
    el: root,
    get isOpen() {
      return sheet.isOpen;
    },
    open(trigger, openTab) {
      if (sheet.isOpen) return;
      const cue = plan('open');
      play(cue);
      selectTab(openTab ?? tab, false);
      sheet.open(trigger);
      restartAnimation(root, 'is-opening');
      startTick();
      if (!quests) {
        questsPhase = 'loading';
        renderQuests();
      }
      if (!season) {
        seasonPhase = 'loading';
        renderSeason(false);
      }
      void loadQuests(true);
      void loadSeason(true);
    },
    close() {
      clearTimers();
      stopTick();
      for (const refs of cards.values()) refs.el.classList.remove('is-holding');
      sheet.close();
    },
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimers();
      stopTick();
      for (const id of [...cardDisposers.keys()]) disposeCard(id);
      for (const dispose of disposers.splice(0)) dispose();
      loc.dispose();
      root.remove();
    },
  };
  selectTab('quests', false);
  renderQuests();
  renderSeason(false);
  return panel;
}
