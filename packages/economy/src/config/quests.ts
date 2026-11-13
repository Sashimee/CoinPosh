/**
 * Daily and weekly quests and the daily streak (T-3.05). The numbers and the rules that read
 * them ship together, as for the Steward's allowance: the server rotates, tracks and pays
 * quests through these functions, the Demo mock does the same with its own clock, and the
 * client only ever shows the quests and rewards they report.
 *
 * Every quest of a cadence and difficulty pays the same bundle, so whichever template the draw
 * picks, the day's and the week's rewards are fixed and the season's Stars budget is exact
 * (`season.test.ts` holds it to the 02-ECONOMY pacing band).
 */
import {
  QUEST_CADENCES,
  QuestTemplateIdSchema,
  RewardPreviewSchema,
  type QuestCadence,
  type RewardPreview,
} from '@coinposh/shared';
import type { Rng } from '../rng.ts';
import type { ValidationIssue } from '../validate.ts';

/** What a quest counts, each measured by the server from its own ledger of the player's table. */
export const QUEST_METRIC_IDS = [
  /** Coins dropped onto the table. */
  'drops',
  /** Coins pushed off the front edge into the wallet. */
  'coinsBanked',
  /** Contact Fusions on the table. */
  'fusions',
  'cratesOpened',
  /** UTC days in the period with at least one drop. */
  'activeDays',
] as const;
export type QuestMetricId = (typeof QUEST_METRIC_IDS)[number];

export const QUEST_DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type QuestDifficulty = (typeof QUEST_DIFFICULTIES)[number];

/** Quests pay only meta currencies: Coins scale with the venue and Bullion is earned by play. */
export const QUEST_REWARD_CURRENCIES = ['pearls', 'keys', 'tickets', 'stars'] as const;

export interface QuestTemplateDef {
  readonly id: string;
  readonly cadence: QuestCadence;
  readonly difficulty: QuestDifficulty;
  readonly metric: QuestMetricId;
  readonly target: number;
}

export interface QuestCadenceRules {
  /**
   * One slot per entry, filled from that difficulty's pool: a daily set is always one easy, one
   * medium and one hard quest, never three hard ones on an unlucky draw.
   */
  readonly slots: readonly QuestDifficulty[];
  /** Leave every template of the previous period's set out of the next draw. */
  readonly restPreviousSet: boolean;
  /** No two quests of one set count the same metric, so every set asks for different play. */
  readonly distinctMetrics: boolean;
  readonly rewards: Readonly<Record<QuestDifficulty, readonly RewardPreview[]>>;
}

export interface StreakMilestoneDef {
  /** Streak length that pays it, in qualifying days. */
  readonly day: number;
  readonly rewards: readonly RewardPreview[];
  /** Streak freezes it grants, up to `maxFreezes` held. */
  readonly freezes: number;
}

export interface StreakConfig {
  /** Daily quests claimed in one UTC day for that day to extend the streak. */
  readonly qualifyingClaims: number;
  readonly milestones: readonly StreakMilestoneDef[];
  /** After the last milestone, this one pays again every `repeatEveryDays` days. */
  readonly repeat: Omit<StreakMilestoneDef, 'day'>;
  readonly repeatEveryDays: number;
  readonly startingFreezes: number;
  readonly maxFreezes: number;
  /** Pearls for one freeze, bought only while fewer than `maxFreezes` are held. */
  readonly freezeCostPearls: number;
}

export interface QuestConfig {
  readonly templates: readonly QuestTemplateDef[];
  readonly cadences: Readonly<Record<QuestCadence, QuestCadenceRules>>;
  readonly streak: StreakConfig;
}

const pearls = (amount: number) => ({ kind: 'currency', currency: 'pearls', amount }) as const;
const keys = (amount: number) => ({ kind: 'currency', currency: 'keys', amount }) as const;
const tickets = (amount: number) => ({ kind: 'currency', currency: 'tickets', amount }) as const;
const stars = (amount: number) => ({ kind: 'currency', currency: 'stars', amount }) as const;

/**
 * Targets are sized on the economy sim's slowest day, a new player's first 43-minute session
 * (the 30 h ÷ 42 days a free-track finisher plays), with 0.0375 fusions per drop for the
 * least-fusing physics style. A daily easy quest fits in its first 10 minutes, medium in 20 and
 * hard in the session; a weekly quest takes two to five sessions, hard ones at least three.
 * `quests.test.ts` replays the sim on five seeds and holds every target to its band.
 */
export const questTemplates = [
  { id: 'dailyDropsEasy', cadence: 'daily', difficulty: 'easy', metric: 'drops', target: 500 },
  {
    id: 'dailyCratesEasy',
    cadence: 'daily',
    difficulty: 'easy',
    metric: 'cratesOpened',
    target: 12,
  },
  {
    id: 'dailyBankEasy',
    cadence: 'daily',
    difficulty: 'easy',
    metric: 'coinsBanked',
    target: 1_000,
  },
  {
    id: 'dailyDropsMedium',
    cadence: 'daily',
    difficulty: 'medium',
    metric: 'drops',
    target: 1_200,
  },
  {
    id: 'dailyCratesMedium',
    cadence: 'daily',
    difficulty: 'medium',
    metric: 'cratesOpened',
    target: 25,
  },
  {
    id: 'dailyFusionsMedium',
    cadence: 'daily',
    difficulty: 'medium',
    metric: 'fusions',
    target: 40,
  },
  {
    id: 'dailyBankMedium',
    cadence: 'daily',
    difficulty: 'medium',
    metric: 'coinsBanked',
    target: 2_500,
  },
  { id: 'dailyDropsHard', cadence: 'daily', difficulty: 'hard', metric: 'drops', target: 2_000 },
  {
    id: 'dailyCratesHard',
    cadence: 'daily',
    difficulty: 'hard',
    metric: 'cratesOpened',
    target: 70,
  },
  { id: 'dailyFusionsHard', cadence: 'daily', difficulty: 'hard', metric: 'fusions', target: 75 },
  {
    id: 'dailyBankHard',
    cadence: 'daily',
    difficulty: 'hard',
    metric: 'coinsBanked',
    target: 7_500,
  },
  { id: 'weeklyDropsEasy', cadence: 'weekly', difficulty: 'easy', metric: 'drops', target: 7_500 },
  {
    id: 'weeklyCratesEasy',
    cadence: 'weekly',
    difficulty: 'easy',
    metric: 'cratesOpened',
    target: 300,
  },
  {
    id: 'weeklyFusionsMedium',
    cadence: 'weekly',
    difficulty: 'medium',
    metric: 'fusions',
    target: 350,
  },
  {
    id: 'weeklyBankMedium',
    cadence: 'weekly',
    difficulty: 'medium',
    metric: 'coinsBanked',
    target: 50_000,
  },
  {
    id: 'weeklyVisitsMedium',
    cadence: 'weekly',
    difficulty: 'medium',
    metric: 'activeDays',
    target: 4,
  },
  { id: 'weeklyDropsHard', cadence: 'weekly', difficulty: 'hard', metric: 'drops', target: 16_000 },
  {
    id: 'weeklyCratesHard',
    cadence: 'weekly',
    difficulty: 'hard',
    metric: 'cratesOpened',
    target: 650,
  },
  {
    id: 'weeklyFusionsHard',
    cadence: 'weekly',
    difficulty: 'hard',
    metric: 'fusions',
    target: 600,
  },
  {
    id: 'weeklyBankHard',
    cadence: 'weekly',
    difficulty: 'hard',
    metric: 'coinsBanked',
    target: 75_000,
  },
] as const satisfies readonly QuestTemplateDef[];

export type QuestTemplateKey = (typeof questTemplates)[number]['id'];

export const questCadences = {
  daily: {
    slots: ['easy', 'medium', 'hard'],
    restPreviousSet: true,
    distinctMetrics: true,
    rewards: {
      easy: [pearls(10), stars(5)],
      medium: [pearls(15), tickets(1), stars(5)],
      hard: [pearls(20), keys(1), stars(10)],
    },
  },
  weekly: {
    slots: ['easy', 'medium', 'hard'],
    restPreviousSet: true,
    distinctMetrics: true,
    rewards: {
      easy: [pearls(40), tickets(1), stars(10)],
      medium: [pearls(60), tickets(2), stars(15)],
      hard: [pearls(100), keys(2), tickets(2), stars(25)],
    },
  },
} as const satisfies Readonly<Record<QuestCadence, QuestCadenceRules>>;

/**
 * Milestones pay Pearls, Keys and Tickets only: Stars from the streak would pay a player for
 * calendar days rather than play and squeeze the season's 25–35 h band from below.
 */
export const questStreak = {
  qualifyingClaims: 1,
  milestones: [
    { day: 3, rewards: [pearls(15), tickets(1)], freezes: 0 },
    { day: 7, rewards: [pearls(40), keys(1), tickets(2)], freezes: 1 },
    { day: 14, rewards: [pearls(60), keys(2), tickets(2)], freezes: 1 },
    { day: 21, rewards: [pearls(80), keys(2), tickets(3)], freezes: 1 },
    { day: 30, rewards: [pearls(120), keys(3), tickets(5)], freezes: 1 },
  ],
  repeat: { rewards: [pearls(80), keys(2), tickets(3)], freezes: 1 },
  repeatEveryDays: 7,
  startingFreezes: 1,
  maxFreezes: 2,
  freezeCostPearls: 50,
} as const satisfies StreakConfig;

export const questConfig = {
  templates: questTemplates,
  cadences: questCadences,
  streak: questStreak,
} as const satisfies QuestConfig;

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
/** 1970-01-01 was a Thursday; weeks start Monday 00:00 UTC, three days earlier. */
const EPOCH_TO_MONDAY_MS = 3 * DAY_MS;

export interface QuestPeriod {
  /** Whole periods since the epoch: the UTC day, or the week starting Monday 00:00 UTC. */
  readonly index: number;
  readonly startsAt: number;
  /** Exclusive: the next period's `startsAt`, which a quest reports as its `expiresAt`. */
  readonly endsAt: number;
}

/** The daily (00:00 UTC) or weekly (Monday 00:00 UTC) period containing server time `nowMs`. */
export function questPeriod(cadence: QuestCadence, nowMs: number): QuestPeriod {
  if (!Number.isFinite(nowMs)) {
    throw new RangeError(`questPeriod: nowMs must be a finite epoch time in ms, got ${nowMs}`);
  }
  const length = cadence === 'daily' ? DAY_MS : WEEK_MS;
  const offset = cadence === 'daily' ? 0 : EPOCH_TO_MONDAY_MS;
  const index = Math.floor((nowMs + offset) / length);
  const startsAt = index * length - offset;
  return { index, startsAt, endsAt: startsAt + length };
}

/** The bundle a quest from `template` pays, fixed by its cadence and difficulty. */
export function questRewards(
  template: Pick<QuestTemplateDef, 'cadence' | 'difficulty'>,
  config: QuestConfig = questConfig,
): readonly RewardPreview[] {
  return config.cadences[template.cadence].rewards[template.difficulty];
}

/** Every set the rotation may hand out after `previous`, in config order. */
export function eligibleQuestSets(
  cadence: QuestCadence,
  previous: readonly string[],
  config: QuestConfig = questConfig,
): readonly (readonly QuestTemplateDef[])[] {
  const rules = config.cadences[cadence];
  const resting = new Set(rules.restPreviousSet ? previous : []);
  const pools = rules.slots.map((difficulty) =>
    config.templates.filter(
      (t) => t.cadence === cadence && t.difficulty === difficulty && !resting.has(t.id),
    ),
  );
  const sets: QuestTemplateDef[][] = [];
  const pick = (slot: number, chosen: QuestTemplateDef[]): void => {
    const pool = pools[slot];
    if (pool === undefined) {
      sets.push(chosen);
      return;
    }
    for (const template of pool) {
      if (rules.distinctMetrics && chosen.some((c) => c.metric === template.metric)) continue;
      pick(slot + 1, [...chosen, template]);
    }
  };
  pick(0, []);
  return sets;
}

/**
 * Draws the next period's set uniformly among the eligible ones, with the server's seeded PRNG.
 * `previous` is the template ids of the period before (empty for a new player).
 */
export function drawQuestSet(
  cadence: QuestCadence,
  previous: readonly string[],
  rng: Rng,
  config: QuestConfig = questConfig,
): readonly QuestTemplateDef[] {
  const sets = eligibleQuestSets(cadence, previous, config);
  const set = sets[rng.nextInt(sets.length)];
  if (set === undefined) {
    throw new Error(
      `drawQuestSet: no ${cadence} set fits after [${previous.join(', ')}]; ` +
        'add templates to the pools so validateQuestConfig passes.',
    );
  }
  return set;
}

/** What the server keeps per player between daily claims. */
export interface StreakState {
  /** Current streak length in qualifying UTC days. */
  readonly days: number;
  readonly freezes: number;
  /** UTC day index of the latest qualifying day, or null before the first. */
  readonly lastDay: number | null;
}

export const initialStreakState: StreakState = {
  days: 0,
  freezes: questStreak.startingFreezes,
  lastDay: null,
};

export interface StreakAdvance {
  readonly state: StreakState;
  /** Freezes spent covering the days missed since `lastDay`. */
  readonly freezesUsed: number;
  /** The milestone the new length reached, if any; its freezes are already in `state`. */
  readonly milestone: Omit<StreakMilestoneDef, 'day'> | null;
}

function assertDay(fn: string, day: number): void {
  if (!Number.isInteger(day) || day < 0) {
    throw new RangeError(`${fn}: day must be a UTC day index (integer ≥ 0), got ${day}`);
  }
}

/** The milestone a streak of exactly `days` pays, or null. */
export function streakMilestone(
  days: number,
  streak: StreakConfig = questStreak,
): Omit<StreakMilestoneDef, 'day'> | null {
  const hit = streak.milestones.find((m) => m.day === days);
  if (hit !== undefined) return hit;
  const last = streak.milestones.at(-1)?.day ?? 0;
  if (days > last && (days - last) % streak.repeatEveryDays === 0) return streak.repeat;
  return null;
}

/**
 * Applies a qualifying `day` (the UTC day the player reached `qualifyingClaims` daily claims).
 * Missed days in between each spend a freeze; with too few freezes the streak restarts at 1
 * and the freezes are kept for the next one. A freeze saves the streak but adds no day to it.
 */
export function advanceStreak(
  state: StreakState,
  day: number,
  streak: StreakConfig = questStreak,
): StreakAdvance {
  assertDay('advanceStreak', day);
  if (state.lastDay !== null && day <= state.lastDay) {
    if (day === state.lastDay) return { state, freezesUsed: 0, milestone: null };
    throw new RangeError(
      `advanceStreak: day ${day} is before the last qualifying day ${state.lastDay}`,
    );
  }
  const missed = state.lastDay === null ? 0 : day - state.lastDay - 1;
  const kept = state.lastDay !== null && missed <= state.freezes;
  const freezesUsed = kept ? missed : 0;
  const days = kept ? state.days + 1 : 1;
  const milestone = streakMilestone(days, streak);
  const freezes = Math.min(
    streak.maxFreezes,
    state.freezes - freezesUsed + (milestone?.freezes ?? 0),
  );
  return {
    state: { days, freezes, lastDay: day },
    freezesUsed,
    milestone,
  };
}

/**
 * The streak as the player should see it on `today`: 0 once more days were missed than the
 * held freezes can cover, otherwise the stored length (today's claim may still extend it).
 */
export function streakAsOf(state: StreakState, today: number): StreakState {
  assertDay('streakAsOf', today);
  if (state.lastDay === null) return state;
  const missed = Math.max(0, today - state.lastDay - 1);
  return missed > state.freezes ? { ...state, days: 0 } : state;
}

/** Buys one freeze for `freezeCostPearls`; throws when the player is at `maxFreezes`. */
export function buyStreakFreeze(
  state: StreakState,
  streak: StreakConfig = questStreak,
): { readonly state: StreakState; readonly costPearls: number } {
  if (state.freezes >= streak.maxFreezes) {
    throw new RangeError(
      `buyStreakFreeze: already holding ${state.freezes} of ${streak.maxFreezes} freezes`,
    );
  }
  return { state: { ...state, freezes: state.freezes + 1 }, costPearls: streak.freezeCostPearls };
}

function checkRewards(
  report: (path: string, message: string) => void,
  path: string,
  rewards: readonly RewardPreview[],
): void {
  if (rewards.length === 0) report(path, 'must pay at least one reward');
  const seen = new Set<string>();
  rewards.forEach((reward, i) => {
    if (!RewardPreviewSchema.safeParse(reward).success)
      report(`${path}[${i}]`, 'is not a RewardPreview');
    if (reward.kind !== 'currency') return;
    if (!(QUEST_REWARD_CURRENCIES as readonly string[]).includes(reward.currency)) {
      report(`${path}[${i}]`, `quests may not pay ${reward.currency}`);
    }
    if (seen.has(reward.currency)) report(`${path}[${i}]`, `pays ${reward.currency} twice`);
    seen.add(reward.currency);
  });
}

export function validateQuestConfig(config: QuestConfig = questConfig): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const report = (path: string, message: string): void => void issues.push({ path, message });
  const ids = new Set<string>();
  config.templates.forEach((t, i) => {
    const path = `quests.templates[${i}]`;
    if (!QuestTemplateIdSchema.safeParse(t.id).success)
      report(path, `"${t.id}" is not a catalog key`);
    if (ids.has(t.id)) report(path, `duplicate id "${t.id}"`);
    ids.add(t.id);
    if (!(QUEST_CADENCES as readonly string[]).includes(t.cadence))
      report(path, `unknown cadence ${t.cadence}`);
    if (!(QUEST_METRIC_IDS as readonly string[]).includes(t.metric))
      report(path, `unknown metric ${t.metric}`);
    if (!(QUEST_DIFFICULTIES as readonly string[]).includes(t.difficulty)) {
      report(path, `unknown difficulty ${t.difficulty}`);
    }
    if (!Number.isInteger(t.target) || t.target <= 0) report(path, 'target must be an integer > 0');
    if (t.metric === 'activeDays' && (t.cadence !== 'weekly' || t.target > 7)) {
      report(path, 'activeDays fits only a weekly quest, with a target of at most 7');
    }
  });
  for (const cadence of QUEST_CADENCES) {
    const rules = config.cadences[cadence];
    const path = `quests.cadences.${cadence}`;
    if (rules.slots.length === 0) report(path, 'needs at least one slot');
    for (const difficulty of QUEST_DIFFICULTIES) {
      checkRewards(report, `${path}.rewards.${difficulty}`, rules.rewards[difficulty]);
    }
    const sets = eligibleQuestSets(cadence, [], config);
    if (sets.length === 0) report(path, 'no set fits the slots with distinct metrics');
    for (const previous of sets) {
      if (
        eligibleQuestSets(
          cadence,
          previous.map((t) => t.id),
          config,
        ).length === 0
      ) {
        report(path, `no set may follow [${previous.map((t) => t.id).join(', ')}]`);
      }
    }
  }
  const s = config.streak;
  if (!Number.isInteger(s.qualifyingClaims) || s.qualifyingClaims < 1) {
    report('quests.streak.qualifyingClaims', 'must be an integer ≥ 1');
  }
  const dailySlots = config.cadences.daily.slots.length;
  if (s.qualifyingClaims > dailySlots) {
    report('quests.streak.qualifyingClaims', `cannot exceed the ${dailySlots} daily slots`);
  }
  s.milestones.forEach((m, i) => {
    const path = `quests.streak.milestones[${i}]`;
    const prev = s.milestones[i - 1];
    if (!Number.isInteger(m.day) || m.day < 1) report(path, 'day must be an integer ≥ 1');
    if (prev !== undefined && m.day <= prev.day) report(path, 'days must ascend');
    if (!Number.isInteger(m.freezes) || m.freezes < 0)
      report(path, 'freezes must be an integer ≥ 0');
    checkRewards(report, `${path}.rewards`, m.rewards);
    if (m.rewards.some((r) => r.kind === 'currency' && r.currency === 'stars')) {
      report(path, 'streak milestones pay no Stars (the season budget counts play, not days)');
    }
  });
  checkRewards(report, 'quests.streak.repeat.rewards', s.repeat.rewards);
  if (s.repeat.rewards.some((r) => r.kind === 'currency' && r.currency === 'stars')) {
    report('quests.streak.repeat', 'streak milestones pay no Stars');
  }
  if (!Number.isInteger(s.repeatEveryDays) || s.repeatEveryDays < 1) {
    report('quests.streak.repeatEveryDays', 'must be an integer ≥ 1');
  }
  if (!Number.isInteger(s.maxFreezes) || s.maxFreezes < 0) {
    report('quests.streak.maxFreezes', 'must be an integer ≥ 0');
  }
  if (
    !Number.isInteger(s.startingFreezes) ||
    s.startingFreezes < 0 ||
    s.startingFreezes > s.maxFreezes
  ) {
    report('quests.streak.startingFreezes', 'must be an integer in [0, maxFreezes]');
  }
  if (!Number.isInteger(s.freezeCostPearls) || s.freezeCostPearls <= 0) {
    report('quests.streak.freezeCostPearls', 'must be an integer > 0');
  }
  return issues;
}

export function assertValidQuestConfig(config: QuestConfig = questConfig): void {
  const issues = validateQuestConfig(config);
  if (issues.length > 0) {
    throw new Error(
      `Quest config is invalid (${issues.length} issue${issues.length === 1 ? '' : 's'}):\n` +
        issues.map((issue) => `  - ${issue.path}: ${issue.message}`).join('\n'),
    );
  }
}
