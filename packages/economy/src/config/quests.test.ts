import { QUEST_CADENCES, QuestTemplateIdSchema, RewardPreviewSchema } from '@coinposh/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ladderRuns } from '../../sim/ladderRuns.ts';
import { simModel } from '../../sim/model.ts';
import { activeTick, claimOffline, createContext, createPlayer, rates } from '../../sim/player.ts';
import { createRng } from '../rng.ts';
import { economyConfig } from './index.ts';
import {
  QUEST_METRIC_IDS,
  advanceStreak,
  buyStreakFreeze,
  drawQuestSet,
  eligibleQuestSets,
  initialStreakState,
  questConfig,
  questPeriod,
  questRewards,
  questStreak,
  questTemplates,
  streakAsOf,
  streakMilestone,
  validateQuestConfig,
  type QuestConfig,
  type QuestMetricId,
  type StreakState,
} from './quests.ts';

const RUNS = { numRuns: 300 };
const DAY_MS = 86_400_000;
const MONDAY_2026_11_16 = 1_794_787_200_000;
/** 30 h of play spread over the 42-day season, rounded up to whole minutes. */
const REFERENCE_SESSION_MINUTES = Math.ceil((30 * 60) / 42);
/** The least-fusing physics style the ladder measured: quests must fit the gentlest player. */
const FUSIONS_PER_DROP = Math.min(
  ...Object.values(ladderRuns).map(
    (runs) => runs.reduce((s, r) => s + r.fusions, 0) / runs.reduce((s, r) => s + r.drops, 0),
  ),
);

type Tally = Record<Exclude<QuestMetricId, 'activeDays'>, number>;

/**
 * A new player's first week in the economy sim, one reference session a day at 19:00 with the
 * offline vault claimed in between, recording each quest metric minute by minute.
 */
function firstWeekMinuteByMinute(seed: number): Tally[][] {
  const ctx = createContext(economyConfig, simModel, createRng(seed));
  const player = createPlayer(ctx);
  const sessions: Tally[][] = [];
  const total: Tally = { drops: 0, coinsBanked: 0, fusions: 0, cratesOpened: 0 };
  let lastEndHour: number | null = null;
  for (let day = 0; day < 7; day++) {
    const start = day * 24 + 19;
    if (lastEndHour !== null) claimOffline(ctx, player, start - lastEndHour);
    const minutes: Tally[] = [];
    for (let minute = 0; minute < REFERENCE_SESSION_MINUTES; minute++) {
      for (let t = 0; t < 60 / simModel.tickSeconds; t++) {
        const drops = player.drops;
        const crates = player.crates;
        const fallsPerDrop = rates(ctx, player).fallsPerDrop;
        activeTick(ctx, player);
        total.drops += player.drops - drops;
        total.coinsBanked += (player.drops - drops) * fallsPerDrop;
        total.fusions += (player.drops - drops) * FUSIONS_PER_DROP;
        total.cratesOpened += player.crates - crates;
      }
      minutes.push({ ...total });
    }
    sessions.push(minutes);
    lastEndHour = start + REFERENCE_SESSION_MINUTES / 60;
  }
  return sessions;
}

const SEEDS = [1, 2, 3, 4, 5];
const weeks = SEEDS.map(firstWeekMinuteByMinute);

/** Minutes into day one's session the slowest seed needs for `target` of `metric`. */
function dailyMinutes(metric: keyof Tally, target: number): number {
  return Math.max(
    ...weeks.map((week) => {
      const i = (week[0] ?? []).findIndex((m) => m[metric] >= target);
      return i === -1 ? Number.POSITIVE_INFINITY : i + 1;
    }),
  );
}

/** Sessions (days) of the first week the slowest and fastest seeds need for a weekly target. */
function weeklySessions(metric: QuestMetricId, target: number): { min: number; max: number } {
  const per = weeks.map((week) => {
    if (metric === 'activeDays') return target;
    const i = week.findIndex((session) => (session.at(-1)?.[metric] ?? 0) >= target);
    return i === -1 ? Number.POSITIVE_INFINITY : i + 1;
  });
  return { min: Math.min(...per), max: Math.max(...per) };
}

describe('quest config', () => {
  it('validates', () => {
    expect(validateQuestConfig()).toEqual([]);
  });

  it('keys every template as a QuestTemplateId and pays only RewardPreviews', () => {
    for (const t of questTemplates) {
      expect(QuestTemplateIdSchema.safeParse(t.id).success).toBe(true);
      for (const r of questRewards(t)) expect(RewardPreviewSchema.safeParse(r).success).toBe(true);
    }
  });

  it('pays Stars from every quest, harder quests at least as much', () => {
    const starsOf = (cadence: 'daily' | 'weekly', d: 'easy' | 'medium' | 'hard') =>
      questRewards({ cadence, difficulty: d }).reduce(
        (s, r) => s + (r.kind === 'currency' && r.currency === 'stars' ? r.amount : 0),
        0,
      );
    for (const cadence of QUEST_CADENCES) {
      expect(starsOf(cadence, 'easy')).toBeGreaterThan(0);
      expect(starsOf(cadence, 'medium')).toBeGreaterThanOrEqual(starsOf(cadence, 'easy'));
      expect(starsOf(cadence, 'hard')).toBeGreaterThanOrEqual(starsOf(cadence, 'medium'));
    }
  });

  it('rejects a set that cannot rotate: one template per slot leaves nothing after a cooldown', () => {
    const one: QuestConfig = {
      ...questConfig,
      templates: questTemplates.filter(
        (t) => t.id !== 'dailyDropsEasy' && t.id !== 'dailyBankEasy',
      ),
    };
    expect(validateQuestConfig(one).some((i) => i.message.startsWith('no set may follow'))).toBe(
      true,
    );
  });

  it('rejects Stars from streak milestones and non-meta currencies from quests', () => {
    const bad: QuestConfig = {
      ...questConfig,
      cadences: {
        ...questConfig.cadences,
        daily: {
          ...questConfig.cadences.daily,
          rewards: {
            ...questConfig.cadences.daily.rewards,
            easy: [{ kind: 'currency', currency: 'coins', amount: 100 }],
          },
        },
      },
      streak: {
        ...questStreak,
        repeat: { rewards: [{ kind: 'currency', currency: 'stars', amount: 10 }], freezes: 1 },
      },
    };
    const paths = validateQuestConfig(bad).map((i) => i.path);
    expect(paths).toContain('quests.cadences.daily.rewards.easy[0]');
    expect(paths).toContain('quests.streak.repeat');
  });
});

describe('quest targets in the economy sim (reference session of 43 min, day 1 is slowest)', () => {
  const bands = { easy: 10, medium: 20, hard: REFERENCE_SESSION_MINUTES } as const;

  it.each(questTemplates.filter((t) => t.cadence === 'daily'))(
    'daily $id ($target $metric) fits its band on a new player’s first session',
    (t) => {
      const minutes = dailyMinutes(t.metric, t.target);
      expect(minutes).toBeLessThanOrEqual(bands[t.difficulty]);
      if (t.difficulty !== 'easy') expect(minutes).toBeGreaterThan(bands.easy / 2);
    },
  );

  it.each(questTemplates.filter((t) => t.cadence === 'weekly'))(
    'weekly $id ($target $metric) takes 2 to 5 reference sessions',
    (t) => {
      const { min, max } = weeklySessions(t.metric, t.target);
      expect(min).toBeGreaterThanOrEqual(2);
      expect(max).toBeLessThanOrEqual(5);
      if (t.difficulty === 'hard') expect(min).toBeGreaterThanOrEqual(3);
    },
  );

  it('covers every metric it can count, so the rotation has variety', () => {
    for (const metric of QUEST_METRIC_IDS) {
      expect(questTemplates.some((t) => t.metric === metric)).toBe(true);
    }
  });
});

describe('quest periods', () => {
  it('contain the time they are asked for, days from 00:00 UTC and weeks from Monday', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4_102_444_800_000 }), (now) => {
        for (const cadence of QUEST_CADENCES) {
          const p = questPeriod(cadence, now);
          expect(p.startsAt).toBeLessThanOrEqual(now);
          expect(p.endsAt).toBeGreaterThan(now);
          expect(p.endsAt - p.startsAt).toBe(cadence === 'daily' ? DAY_MS : 7 * DAY_MS);
          expect(questPeriod(cadence, p.endsAt).index).toBe(p.index + 1);
        }
        expect(Math.abs(questPeriod('daily', now).startsAt % DAY_MS)).toBe(0);
        expect(
          Math.abs((questPeriod('weekly', now).startsAt - MONDAY_2026_11_16) % (7 * DAY_MS)),
        ).toBe(0);
      }),
      RUNS,
    );
  });

  it('starts the week on Monday 00:00 UTC', () => {
    expect(questPeriod('weekly', MONDAY_2026_11_16).startsAt).toBe(MONDAY_2026_11_16);
    expect(questPeriod('weekly', MONDAY_2026_11_16 - 1).endsAt).toBe(MONDAY_2026_11_16);
  });

  it('rejects a non-finite time', () => {
    expect(() => questPeriod('daily', Number.NaN)).toThrow(RangeError);
  });
});

describe('quest rotation', () => {
  it('fills every slot with its difficulty, distinct metrics, none from the previous set', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...QUEST_CADENCES),
        fc.integer(),
        fc.integer({ min: 1, max: 30 }),
        (cadence, seed, periods) => {
          const rng = createRng(seed);
          let previous: readonly string[] = [];
          for (let i = 0; i < periods; i++) {
            const set = drawQuestSet(cadence, previous, rng);
            expect(set.map((t) => t.difficulty)).toEqual(questConfig.cadences[cadence].slots);
            expect(new Set(set.map((t) => t.metric)).size).toBe(set.length);
            expect(set.every((t) => t.cadence === cadence && !previous.includes(t.id))).toBe(true);
            previous = set.map((t) => t.id);
          }
        },
      ),
      RUNS,
    );
  });

  it('is deterministic for a seed', () => {
    fc.assert(
      fc.property(fc.constantFrom(...QUEST_CADENCES), fc.integer(), (cadence, seed) => {
        const a = drawQuestSet(cadence, [], createRng(seed)).map((t) => t.id);
        const b = drawQuestSet(cadence, [], createRng(seed)).map((t) => t.id);
        expect(a).toEqual(b);
      }),
      RUNS,
    );
  });

  it('reaches every template within a season of draws', () => {
    for (const cadence of QUEST_CADENCES) {
      const rng = createRng(7);
      const seen = new Set<string>();
      let previous: readonly string[] = [];
      for (let i = 0; i < (cadence === 'daily' ? 42 : 6); i++) {
        previous = drawQuestSet(cadence, previous, rng).map((t) => t.id);
        for (const id of previous) seen.add(id);
      }
      const pool = questTemplates.filter((t) => t.cadence === cadence).map((t) => t.id);
      if (cadence === 'daily') expect([...seen].sort()).toEqual([...pool].sort());
      else expect(seen.size).toBeGreaterThanOrEqual(pool.length - 2);
    }
  });

  it('draws every eligible set with roughly equal frequency', () => {
    const sets = eligibleQuestSets('daily', []);
    const counts = new Map<string, number>();
    const rng = createRng(11);
    const draws = sets.length * 400;
    for (let i = 0; i < draws; i++) {
      const key = drawQuestSet('daily', [], rng)
        .map((t) => t.id)
        .join();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(counts.size).toBe(sets.length);
    for (const n of counts.values()) {
      expect(n).toBeGreaterThan(400 * 0.75);
      expect(n).toBeLessThan(400 * 1.25);
    }
  });
});

describe('daily streak', () => {
  const play = (days: readonly number[], from: StreakState = initialStreakState) =>
    days.reduce((s, d) => advanceStreak(s, d).state, from);

  it('grows by one per consecutive qualifying day and ignores a second claim the same day', () => {
    const s = play([100, 101, 102]);
    expect(s.days).toBe(3);
    expect(advanceStreak(s, 102).state).toBe(s);
  });

  it('spends a freeze per missed day and keeps the streak, without adding the missed day', () => {
    const s = play([100, 101, 102]);
    const next = advanceStreak(s, 104);
    expect(next.freezesUsed).toBe(1);
    expect(next.state).toEqual({ days: 4, freezes: s.freezes - 1, lastDay: 104 });
  });

  it('restarts at 1 when the gap is longer than the held freezes, keeping the freezes', () => {
    const s = play([100, 101]);
    const next = advanceStreak(s, 101 + s.freezes + 2);
    expect(next.state.days).toBe(1);
    expect(next.state.freezes).toBe(s.freezes);
    expect(next.freezesUsed).toBe(0);
  });

  it('shows 0 once the gap outruns the freezes', () => {
    const s = play([100, 101]);
    expect(streakAsOf(s, 102).days).toBe(2);
    expect(streakAsOf(s, 102 + s.freezes).days).toBe(2);
    expect(streakAsOf(s, 103 + s.freezes).days).toBe(0);
  });

  it('pays the milestones at their days and then every repeatEveryDays', () => {
    let s = initialStreakState;
    const paidAt: number[] = [];
    for (let d = 0; d < 60; d++) {
      const step = advanceStreak(s, d);
      if (step.milestone !== null) paidAt.push(step.state.days);
      s = step.state;
    }
    expect(paidAt).toEqual([3, 7, 14, 21, 30, 37, 44, 51, 58]);
    expect(streakMilestone(37)).toBe(questStreak.repeat);
  });

  it('never holds more freezes than maxFreezes, never goes negative, never shrinks a kept streak', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 5 }), { maxLength: 80 }), (gaps) => {
        let s = initialStreakState;
        let day = 0;
        for (const gap of gaps) {
          day += gap;
          const step = advanceStreak(s, day);
          expect(step.state.freezes).toBeGreaterThanOrEqual(0);
          expect(step.state.freezes).toBeLessThanOrEqual(questStreak.maxFreezes);
          expect(step.state.days === 1 || step.state.days === s.days + 1).toBe(true);
          if (gap - 1 <= s.freezes && s.lastDay !== null) expect(step.state.days).toBe(s.days + 1);
          s = step.state;
        }
      }),
      RUNS,
    );
  });

  it('sells a freeze for freezeCostPearls only below the cap', () => {
    const bought = buyStreakFreeze({ days: 5, freezes: 0, lastDay: 10 });
    expect(bought).toEqual({ state: { days: 5, freezes: 1, lastDay: 10 }, costPearls: 50 });
    expect(() =>
      buyStreakFreeze({ days: 5, freezes: questStreak.maxFreezes, lastDay: 10 }),
    ).toThrow(RangeError);
  });

  it('rejects a day before the last qualifying one', () => {
    expect(() => advanceStreak(play([100]), 99)).toThrow(RangeError);
    expect(() => advanceStreak(initialStreakState, -1)).toThrow(RangeError);
  });
});
