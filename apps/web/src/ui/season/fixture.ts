import {
  questRewards,
  questTemplates,
  seasonTiersForResponse,
  seasonTrack,
  type QuestTemplateKey,
} from '@coinposh/economy';
import {
  QuestClaimResponseSchema,
  QuestsResponseSchema,
  SeasonResponseSchema,
  type Quest,
  type QuestClaimResponse,
  type QuestsResponse,
  type SeasonResponse,
} from '@coinposh/shared';

const HOUR_MS = 3_600_000;
export const FIXTURE_NOW = 1_762_300_800_000;

export interface QuestSeed {
  readonly template: QuestTemplateKey;
  /** Fraction of the target done; 1 or more is complete. */
  readonly done: number;
  readonly claimed?: boolean;
}

export const DEFAULT_QUESTS: readonly QuestSeed[] = [
  { template: 'dailyDropsEasy', done: 1 },
  { template: 'dailyFusionsMedium', done: 0.45 },
  { template: 'dailyDropsHard', done: 1, claimed: true },
  { template: 'weeklyVisitsMedium', done: 0.6 },
  { template: 'weeklyCratesEasy', done: 1 },
  { template: 'weeklyFusionsHard', done: 0.12 },
];

function questId(index: number): string {
  return `quest_fixture${String(index).padStart(4, '0')}`;
}

export function fixtureQuest(seed: QuestSeed, index: number, now = FIXTURE_NOW): Quest {
  const def = questTemplates.find((template) => template.id === seed.template);
  if (def === undefined) throw new Error(`fixtureQuest: unknown template ${seed.template}`);
  const expiresAt = now + (def.cadence === 'daily' ? 7 : 4 * 24 + 7) * HOUR_MS;
  return QuestsResponseSchema.shape.quests.element.parse({
    id: questId(index),
    template: def.id,
    cadence: def.cadence,
    target: def.target,
    progress: Math.round(def.target * seed.done),
    rewards: questRewards(def),
    claimed: seed.claimed ?? false,
    expiresAt,
  });
}

export function questsResponse(
  seeds: readonly QuestSeed[] = DEFAULT_QUESTS,
  streak = { days: 5, freezes: 1 },
  now = FIXTURE_NOW,
): QuestsResponse {
  return QuestsResponseSchema.parse({
    quests: seeds.map((seed, index) => fixtureQuest(seed, index, now)),
    streak,
  });
}

export function claimResponse(quest: Quest): QuestClaimResponse {
  return QuestClaimResponseSchema.parse({
    quest: { ...quest, claimed: true },
    rewards: quest.rewards.map((reward) =>
      reward.kind === 'scratchCard'
        ? { kind: 'scratchCard', cardId: 'scratch_fixture0001' }
        : reward,
    ),
    wallet: {
      coins: 12_500,
      bullion: 40,
      goldBars: 0,
      pearls: 320,
      keys: 4,
      tickets: 6,
      stars: 1_220,
    },
  });
}

export function seasonResponse(
  stars = 1_220,
  options: { claimedFree?: readonly number[]; premiumUnlocked?: boolean; now?: number } = {},
): SeasonResponse {
  const now = options.now ?? FIXTURE_NOW;
  return SeasonResponseSchema.parse({
    id: 'season_fixture0001',
    startsAt: now - 9 * 24 * HOUR_MS,
    endsAt: now - 9 * 24 * HOUR_MS + seasonTrack.weeks * 7 * 24 * HOUR_MS,
    stars,
    tiers: seasonTiersForResponse(),
    claimedFree: options.claimedFree ?? [1, 2],
    claimedPremium: [],
    premiumUnlocked: options.premiumUnlocked ?? false,
  });
}
