import { questStreak, seasonTrack } from '@coinposh/economy';
import { DEFAULT_FEATURE_FLAGS, QuestTemplateIdSchema, type FeatureFlags } from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import {
  claimResponse,
  fixtureQuest,
  FIXTURE_NOW,
  questsResponse,
  seasonResponse,
} from './fixture.ts';
import {
  nextStreakMilestone,
  questCard,
  questsView,
  seasonView,
  starsIn,
  timeLeft,
  withClaimedQuest,
  withQuestMarkedClaimed,
} from './model.ts';

const PREMIUM_ON: FeatureFlags = {
  ...DEFAULT_FEATURE_FLAGS,
  monetization: true,
  premiumSeasonTrack: true,
};

describe('questCard', () => {
  it('clamps progress the server counts past the target', () => {
    const quest = fixtureQuest({ template: 'dailyDropsEasy', done: 1.4 }, 0);
    const card = questCard(quest);
    expect(card.progress).toBe(card.target);
    expect(card.fraction).toBe(1);
    expect(card.ready).toBe(true);
    expect(card.difficulty).toBe('easy');
    expect(card.metric).toBe('drops');
  });

  it('is not ready once claimed, and not ready below the target', () => {
    expect(
      questCard(fixtureQuest({ template: 'dailyDropsHard', done: 1, claimed: true }, 0)).ready,
    ).toBe(false);
    const partial = questCard(fixtureQuest({ template: 'weeklyFusionsHard', done: 0.5 }, 0));
    expect(partial.ready).toBe(false);
    expect(partial.fraction).toBeCloseTo(0.5, 1);
  });

  it('throws loudly on a template the economy does not list or a cadence mismatch', () => {
    const quest = fixtureQuest({ template: 'dailyDropsEasy', done: 0 }, 0);
    expect(() =>
      questCard({ ...quest, template: QuestTemplateIdSchema.parse('dailyMystery') }),
    ).toThrow(/dailyMystery/);
    expect(() => questCard({ ...quest, cadence: 'weekly' })).toThrow(/weekly/);
  });
});

describe('questsView', () => {
  it('splits by cadence and puts ready quests first, claimed last, easy before hard', () => {
    const view = questsView(questsResponse());
    expect(view.daily.map((card) => [card.template, card.ready, card.claimed])).toEqual([
      ['dailyDropsEasy', true, false],
      ['dailyFusionsMedium', false, false],
      ['dailyDropsHard', false, true],
    ]);
    expect(view.weekly.map((card) => card.template)).toEqual([
      'weeklyCratesEasy',
      'weeklyVisitsMedium',
      'weeklyFusionsHard',
    ]);
    expect(view.claimable).toBe(2);
    expect(view.resets.daily).toBe(FIXTURE_NOW + 7 * 3_600_000);
  });

  it('reports the streak, its freezes and the next milestone', () => {
    const view = questsView(questsResponse(undefined, { days: 5, freezes: 1 }));
    expect(view.streak).toMatchObject({ days: 5, freezes: 1, maxFreezes: questStreak.maxFreezes });
    expect(view.streak.next).toMatchObject({ day: 7, remaining: 2, freezes: 1, fraction: 0.5 });
  });

  it('handles no quests at all', () => {
    const view = questsView(questsResponse([], { days: 0, freezes: 0 }));
    expect(view.daily).toEqual([]);
    expect(view.weekly).toEqual([]);
    expect(view.claimable).toBe(0);
    expect(view.resets).toEqual({ daily: null, weekly: null });
  });

  it('folds a claim in without reordering, and marks an already-claimed quest', () => {
    const response = questsResponse();
    const view = questsView(response);
    const first = response.quests[0];
    if (first === undefined) throw new Error('fixture has quests');
    const claimed = withClaimedQuest(view, claimResponse(first).quest);
    expect(claimed.daily.map((card) => card.id)).toEqual(view.daily.map((card) => card.id));
    expect(claimed.daily[0]).toMatchObject({ claimed: true, ready: false });
    expect(claimed.claimable).toBe(1);
    const weeklyReady = view.weekly[0];
    if (weeklyReady === undefined) throw new Error('fixture has weekly quests');
    const marked = withQuestMarkedClaimed(claimed, weeklyReady.id);
    expect(marked.weekly[0]).toMatchObject({ claimed: true, ready: false });
    expect(marked.claimable).toBe(0);
  });
});

describe('nextStreakMilestone', () => {
  it('starts at the first milestone and counts toward it from day 0', () => {
    expect(nextStreakMilestone(0)).toMatchObject({ day: 3, remaining: 3, fraction: 0 });
  });

  it('moves on exactly on a milestone day', () => {
    expect(nextStreakMilestone(7)).toMatchObject({ day: 14, remaining: 7, fraction: 0 });
  });

  it('follows the repeat after the last listed milestone', () => {
    const last = questStreak.milestones.at(-1)?.day ?? 0;
    const next = nextStreakMilestone(last);
    expect(next.day).toBe(last + questStreak.repeatEveryDays);
    expect(next.rewards).toEqual(questStreak.repeat.rewards);
    expect(nextStreakMilestone(last + 3).day).toBe(last + questStreak.repeatEveryDays);
  });
});

describe('seasonView', () => {
  it('keeps the premium track coming soon while monetization is off, even if the server says unlocked', () => {
    const view = seasonView(
      seasonResponse(1_220, { premiumUnlocked: true }),
      DEFAULT_FEATURE_FLAGS,
    );
    expect(view.premiumOpen).toBe(false);
    expect(view.tiers.every((tier) => tier.premiumState === 'comingSoon')).toBe(true);
  });

  it('keeps premium shut when the flags allow it but the server has not unlocked it', () => {
    const view = seasonView(seasonResponse(1_220, { premiumUnlocked: false }), PREMIUM_ON);
    expect(view.premiumOpen).toBe(false);
    expect(view.tiers[0]?.premiumState).toBe('comingSoon');
  });

  it('opens premium only with both the server and the flags', () => {
    const view = seasonView(seasonResponse(1_220, { premiumUnlocked: true }), PREMIUM_ON);
    expect(view.premiumOpen).toBe(true);
    expect(view.tiers[0]?.premiumState).toBe('reached');
  });

  it('marks claimed, reached and locked tiers and the progress to the next', () => {
    const per = seasonTrack.starsPerTier;
    const stars = per * 3 + Math.floor(per / 2);
    const view = seasonView(seasonResponse(stars, { claimedFree: [1] }), DEFAULT_FEATURE_FLAGS);
    expect(view.tiers.slice(0, 5).map((tier) => tier.freeState)).toEqual([
      'claimed',
      'reached',
      'reached',
      'locked',
      'locked',
    ]);
    expect(view.tier).toBe(3);
    expect(view.total).toBe(view.tiers.length);
    expect(view.next).toMatchObject({ tier: 4, remaining: per - Math.floor(per / 2) });
    expect(view.next?.fraction).toBeCloseTo(Math.floor(per / 2) / per, 5);
  });

  it('has no next tier once the track is complete, and none reached at zero', () => {
    expect(
      seasonView(seasonResponse(seasonTrack.totalStars), DEFAULT_FEATURE_FLAGS).next,
    ).toBeNull();
    const fresh = seasonView(seasonResponse(0, { claimedFree: [] }), DEFAULT_FEATURE_FLAGS);
    expect(fresh.tier).toBe(0);
    expect(fresh.next).toMatchObject({ tier: 1, fraction: 0 });
  });
});

describe('timeLeft and starsIn', () => {
  it('rounds down and picks the largest unit', () => {
    const hour = 3_600_000;
    expect(timeLeft(FIXTURE_NOW + 2 * 24 * hour + 5 * hour + 1, FIXTURE_NOW)).toMatchObject({
      unit: 'days',
      days: 2,
      hours: 5,
    });
    expect(timeLeft(FIXTURE_NOW + 90 * 60_000, FIXTURE_NOW)).toMatchObject({
      unit: 'hours',
      hours: 1,
      minutes: 30,
    });
    expect(timeLeft(FIXTURE_NOW + 59_999, FIXTURE_NOW).unit).toBe('soon');
    expect(timeLeft(FIXTURE_NOW - 1, FIXTURE_NOW).unit).toBe('soon');
  });

  it('sums only Stars', () => {
    expect(
      starsIn([
        { kind: 'currency', currency: 'stars', amount: 30 },
        { kind: 'currency', currency: 'pearls', amount: 99 },
        { kind: 'currency', currency: 'stars', amount: 12 },
        { kind: 'scratchCard', count: 1 },
      ]),
    ).toBe(42);
    expect(starsIn([])).toBe(0);
  });
});
