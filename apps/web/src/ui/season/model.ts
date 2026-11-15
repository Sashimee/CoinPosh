import {
  questStreak,
  questTemplates,
  seasonPremiumUnlocked,
  streakMilestone,
  type QuestDifficulty,
  type QuestMetricId,
  type QuestTemplateKey,
  type StreakConfig,
} from '@coinposh/economy';
import type {
  FeatureFlags,
  IdempotencyKey,
  Quest,
  QuestCadence,
  QuestClaimResponse,
  QuestId,
  QuestsResponse,
  Reward,
  RewardPreview,
  SeasonResponse,
} from '@coinposh/shared';

/** What the panel reads and claims; built on `ApiClient.call` in the app, on stubs in tests. */
export interface SeasonData {
  quests(): Promise<QuestsResponse>;
  claim(questId: QuestId, idempotencyKey: IdempotencyKey): Promise<QuestClaimResponse>;
  season(): Promise<SeasonResponse>;
}

export interface QuestCardView {
  readonly id: QuestId;
  readonly template: QuestTemplateKey;
  readonly cadence: QuestCadence;
  readonly difficulty: QuestDifficulty;
  readonly metric: QuestMetricId;
  readonly target: number;
  /** Clamped to `target`: the server may count past it, the card never shows 130 / 100. */
  readonly progress: number;
  readonly fraction: number;
  /** Complete and not yet claimed. */
  readonly ready: boolean;
  readonly claimed: boolean;
  readonly rewards: readonly RewardPreview[];
  readonly expiresAt: number;
}

export interface StreakMilestoneView {
  readonly day: number;
  readonly rewards: readonly RewardPreview[];
  readonly freezes: number;
  /** Qualifying days still to go. */
  readonly remaining: number;
  /** 0..1 of the way from the previous milestone (or day 0) to this one. */
  readonly fraction: number;
}

export interface StreakView {
  readonly days: number;
  readonly freezes: number;
  readonly maxFreezes: number;
  readonly next: StreakMilestoneView;
}

export interface QuestsView {
  readonly daily: readonly QuestCardView[];
  readonly weekly: readonly QuestCardView[];
  readonly streak: StreakView;
  readonly claimable: number;
  /** The earliest expiry per cadence, or null when the server sent none of that cadence. */
  readonly resets: Readonly<Record<QuestCadence, number | null>>;
}

export type TierState = 'claimed' | 'reached' | 'locked';

export interface TierView {
  readonly tier: number;
  readonly starsRequired: number;
  readonly free: readonly RewardPreview[];
  readonly premium: readonly RewardPreview[];
  readonly freeState: TierState;
  /** `comingSoon` while the premium track is shut, whatever the player's Stars. */
  readonly premiumState: TierState | 'comingSoon';
}

export interface SeasonView {
  readonly endsAt: number;
  readonly stars: number;
  /** Tiers whose Stars are reached. */
  readonly tier: number;
  readonly total: number;
  /** The next tier to reach, or null once every tier is. */
  readonly next: {
    readonly tier: number;
    readonly starsRequired: number;
    readonly remaining: number;
    readonly fraction: number;
  } | null;
  readonly premiumOpen: boolean;
  readonly tiers: readonly TierView[];
}

const TEMPLATES: ReadonlyMap<string, (typeof questTemplates)[number]> = new Map(
  questTemplates.map((template) => [template.id, template]),
);

const DIFFICULTY_ORDER: readonly QuestDifficulty[] = ['easy', 'medium', 'hard'];

function templateDef(quest: Quest): (typeof questTemplates)[number] {
  const def = TEMPLATES.get(quest.template);
  if (def === undefined) {
    throw new RangeError(
      `The server sent quest ${quest.id} with template "${quest.template}", which the economy quest catalogue does not list; ship the client with the server's packages/economy`,
    );
  }
  if (def.cadence !== quest.cadence) {
    throw new RangeError(
      `The server sent quest ${quest.id} as ${quest.cadence}, but template "${def.id}" is ${def.cadence} in packages/economy`,
    );
  }
  return def;
}

export function questCard(quest: Quest): QuestCardView {
  const def = templateDef(quest);
  const progress = Math.min(quest.progress, quest.target);
  return {
    id: quest.id,
    template: def.id,
    cadence: quest.cadence,
    difficulty: def.difficulty,
    metric: def.metric,
    target: quest.target,
    progress,
    fraction: progress / quest.target,
    ready: !quest.claimed && quest.progress >= quest.target,
    claimed: quest.claimed,
    rewards: quest.rewards,
    expiresAt: quest.expiresAt,
  };
}

/** Ready to claim first (the thumb's next tap), then in progress, then claimed; easy to hard. */
function cardRank(card: QuestCardView): number {
  const state = card.ready ? 0 : card.claimed ? 2 : 1;
  return state * DIFFICULTY_ORDER.length + DIFFICULTY_ORDER.indexOf(card.difficulty);
}

function sortCards(cards: readonly QuestCardView[]): QuestCardView[] {
  return [...cards].sort((a, b) => cardRank(a) - cardRank(b));
}

/** The next milestone after `days`, counting the repeat that follows the last listed one. */
export function nextStreakMilestone(
  days: number,
  streak: StreakConfig = questStreak,
): StreakMilestoneView {
  const lastListed = streak.milestones.at(-1)?.day ?? 0;
  const horizon = Math.max(days, lastListed) + streak.repeatEveryDays;
  let previous = 0;
  for (let day = 1; day <= horizon; day++) {
    const milestone = streakMilestone(day, streak);
    if (milestone === null) continue;
    if (day > days) {
      return {
        day,
        rewards: milestone.rewards,
        freezes: milestone.freezes,
        remaining: day - days,
        fraction: (days - previous) / (day - previous),
      };
    }
    previous = day;
  }
  throw new RangeError(
    `nextStreakMilestone: no milestone follows day ${days}; questStreak.repeatEveryDays must be ≥ 1`,
  );
}

function earliest(cards: readonly QuestCardView[]): number | null {
  return cards.length === 0 ? null : Math.min(...cards.map((card) => card.expiresAt));
}

export function questsView(response: QuestsResponse): QuestsView {
  const cards = response.quests.map(questCard);
  const daily = sortCards(cards.filter((card) => card.cadence === 'daily'));
  const weekly = sortCards(cards.filter((card) => card.cadence === 'weekly'));
  return {
    daily,
    weekly,
    streak: {
      days: response.streak.days,
      freezes: response.streak.freezes,
      maxFreezes: Math.max(questStreak.maxFreezes, response.streak.freezes),
      next: nextStreakMilestone(response.streak.days),
    },
    claimable: cards.filter((card) => card.ready).length,
    resets: { daily: earliest(daily), weekly: earliest(weekly) },
  };
}

/**
 * Folds a claim's answer into the view. The order stays put, so the card the player just
 * tapped does not jump away under their thumb; the next load sorts it.
 */
export function withClaimedQuest(view: QuestsView, quest: Quest): QuestsView {
  const card = questCard(quest);
  const swap = (cards: readonly QuestCardView[]) =>
    cards.map((existing) => (existing.id === card.id ? card : existing));
  const daily = swap(view.daily);
  const weekly = swap(view.weekly);
  return {
    ...view,
    daily,
    weekly,
    claimable: [...daily, ...weekly].filter((c) => c.ready).length,
  };
}

/** Marks a quest the server says is already claimed, without inventing its answer. */
export function withQuestMarkedClaimed(view: QuestsView, questId: QuestId): QuestsView {
  const mark = (cards: readonly QuestCardView[]) =>
    cards.map((card) => (card.id === questId ? { ...card, ready: false, claimed: true } : card));
  const daily = mark(view.daily);
  const weekly = mark(view.weekly);
  return {
    ...view,
    daily,
    weekly,
    claimable: [...daily, ...weekly].filter((c) => c.ready).length,
  };
}

function tierState(
  stars: number,
  starsRequired: number,
  claimed: ReadonlySet<number>,
  tier: number,
): TierState {
  if (claimed.has(tier)) return 'claimed';
  return stars >= starsRequired ? 'reached' : 'locked';
}

/**
 * The track as the panel draws it. The premium side opens only when the server reports it
 * unlocked and the client's flags allow it, so a stray `premiumUnlocked` never shows a paid
 * track while `flags.monetization` is off.
 */
export function seasonView(response: SeasonResponse, flags: FeatureFlags): SeasonView {
  const premiumOpen = response.premiumUnlocked && seasonPremiumUnlocked(flags);
  const free = new Set(response.claimedFree);
  const premium = new Set(response.claimedPremium);
  const tiers = [...response.tiers]
    .sort((a, b) => a.tier - b.tier)
    .map((tier): TierView => ({
      tier: tier.tier,
      starsRequired: tier.starsRequired,
      free: tier.free,
      premium: tier.premium,
      freeState: tierState(response.stars, tier.starsRequired, free, tier.tier),
      premiumState: premiumOpen
        ? tierState(response.stars, tier.starsRequired, premium, tier.tier)
        : 'comingSoon',
    }));
  const reached = tiers.filter((tier) => response.stars >= tier.starsRequired);
  const nextTier = tiers.find((tier) => response.stars < tier.starsRequired);
  const floor = reached.at(-1)?.starsRequired ?? 0;
  return {
    endsAt: response.endsAt,
    stars: response.stars,
    tier: reached.length,
    total: tiers.length,
    next: nextTier
      ? {
          tier: nextTier.tier,
          starsRequired: nextTier.starsRequired,
          remaining: nextTier.starsRequired - response.stars,
          fraction: (response.stars - floor) / (nextTier.starsRequired - floor),
        }
      : null,
    premiumOpen,
    tiers,
  };
}

export interface TimeLeft {
  readonly unit: 'days' | 'hours' | 'minutes' | 'soon';
  readonly days: number;
  readonly hours: number;
  readonly minutes: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Whole units left until `at`, rounded down so a countdown never promises time it lacks. */
export function timeLeft(at: number, now: number): TimeLeft {
  const left = Math.max(0, at - now);
  const days = Math.floor(left / DAY_MS);
  const hours = Math.floor((left % DAY_MS) / HOUR_MS);
  const minutes = Math.floor((left % HOUR_MS) / MINUTE_MS);
  const unit = days > 0 ? 'days' : hours > 0 ? 'hours' : minutes > 0 ? 'minutes' : 'soon';
  return { unit, days, hours, minutes };
}

/** Stars a claim's rewards add to the season, for the counter to roll toward. */
export function starsIn(rewards: readonly (Reward | RewardPreview)[]): number {
  return rewards.reduce(
    (sum, reward) =>
      sum + (reward.kind === 'currency' && reward.currency === 'stars' ? reward.amount : 0),
    0,
  );
}
