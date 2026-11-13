/**
 * The Season Pass track (T-3.05). Its length and price come from `season` in ./progression.ts,
 * which the balancing sim already reads, so the tiers the UI shows and the Stars the sim counts
 * can never disagree. The premium rewards are defined so the locked track can render, and pay
 * only while `flags.monetization` and `flags.premiumSeasonTrack` are both on.
 */
import {
  RewardPreviewSchema,
  type FeatureFlags,
  type RewardPreview,
  type SeasonTier,
} from '@coinposh/shared';
import type { SeasonConfig } from '../types.ts';
import type { ValidationIssue } from '../validate.ts';
import { season } from './progression.ts';
import { questConfig, type QuestConfig } from './quests.ts';

/** Tier rewards pay meta currencies and scratch cards; Stars and venue currencies never. */
export const SEASON_REWARD_CURRENCIES = ['pearls', 'keys', 'tickets'] as const;

export interface SeasonTierDef {
  readonly tier: number;
  /** Season Stars at which the tier unlocks: `tier × starsPerTier`. */
  readonly starsRequired: number;
  readonly free: readonly RewardPreview[];
  readonly premium: readonly RewardPreview[];
}

const pearls = (amount: number) => ({ kind: 'currency', currency: 'pearls', amount }) as const;
const keys = (amount: number) => ({ kind: 'currency', currency: 'keys', amount }) as const;
const tickets = (amount: number) => ({ kind: 'currency', currency: 'tickets', amount }) as const;
const scratchCards = (count: number) => ({ kind: 'scratchCard', count }) as const;

/**
 * Each ten tiers repeat one rhythm, a small Pearl purse on odd steps between Keys and Tickets,
 * a scratch card at the fifth and a showpiece at the tenth, and every decade's Pearls climb so
 * the back half of the season pays more than the front.
 */
function freeRewards(tier: number): readonly RewardPreview[] {
  const decade = Math.floor((tier - 1) / 10);
  switch (tier % 10) {
    case 1:
      return [pearls(15 + 5 * decade)];
    case 2:
    case 6:
      return [tickets(1)];
    case 3:
      return [pearls(20 + 5 * decade)];
    case 4:
    case 8:
      return [keys(1)];
    case 5:
      return [pearls(40 + 10 * decade), scratchCards(1)];
    case 7:
      return [pearls(25 + 5 * decade)];
    case 9:
      return [tickets(2)];
    default:
      return [pearls(80 + 20 * decade), keys(2), tickets(2)];
  }
}

/** The final free tier: the season's crown, more than a casual day's crate Pearls in one claim. */
const finaleFree = [pearls(300), keys(5), tickets(5), scratchCards(3)] as const;

const PREMIUM_FACTOR = 2;

function premiumRewards(free: readonly RewardPreview[]): readonly RewardPreview[] {
  return free.map((reward) => {
    if (reward.kind === 'currency') return { ...reward, amount: reward.amount * PREMIUM_FACTOR };
    if (reward.kind === 'scratchCard') return { ...reward, count: reward.count * PREMIUM_FACTOR };
    return reward;
  });
}

export function buildSeasonTiers(config: SeasonConfig = season): readonly SeasonTierDef[] {
  return Array.from({ length: config.freeTiers }, (_, i) => {
    const tier = i + 1;
    const free = tier === config.freeTiers ? finaleFree : freeRewards(tier);
    return { tier, starsRequired: tier * config.starsPerTier, free, premium: premiumRewards(free) };
  });
}

export const seasonTrack = {
  weeks: season.weeks,
  starsPerTier: season.starsPerTier,
  totalStars: season.freeTiers * season.starsPerTier,
  tiers: buildSeasonTiers(season),
} as const;

/** Whether the premium track pays: never while `flags.monetization` is off. */
export function seasonPremiumUnlocked(flags: FeatureFlags): boolean {
  return flags.monetization && flags.premiumSeasonTrack;
}

/** Tiers unlocked at `stars`, as the sim and the track UI count them. */
export function seasonTierAt(stars: number, config: SeasonConfig = season): number {
  if (!Number.isFinite(stars) || stars < 0) {
    throw new RangeError(`seasonTierAt: stars must be a finite number ≥ 0, got ${stars}`);
  }
  return Math.min(config.freeTiers, Math.floor(stars / config.starsPerTier));
}

/** The track as `SeasonResponse.tiers` carries it. */
export function seasonTiersForResponse(
  tiers: readonly SeasonTierDef[] = seasonTrack.tiers,
): SeasonTier[] {
  return tiers.map((t) => ({
    tier: t.tier,
    starsRequired: t.starsRequired,
    free: [...t.free],
    premium: [...t.premium],
  }));
}

/** Stars a player who claims every quest earns from quests over a season of `weeks`. */
export function questStarsPerSeason(
  weeks: number = season.weeks,
  config: QuestConfig = questConfig,
): number {
  const starsIn = (rewards: readonly RewardPreview[]): number =>
    rewards.reduce(
      (sum, r) => sum + (r.kind === 'currency' && r.currency === 'stars' ? r.amount : 0),
      0,
    );
  const perPeriod = (cadence: 'daily' | 'weekly'): number => {
    const rules = config.cadences[cadence];
    return rules.slots.reduce((sum, difficulty) => sum + starsIn(rules.rewards[difficulty]), 0);
  };
  return weeks * (7 * perPeriod('daily') + perPeriod('weekly'));
}

export function validateSeasonTrack(
  tiers: readonly SeasonTierDef[] = seasonTrack.tiers,
  config: SeasonConfig = season,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const report = (path: string, message: string): void => void issues.push({ path, message });
  if (tiers.length !== config.freeTiers) {
    report('season.tiers', `has ${tiers.length} tiers, season.freeTiers is ${config.freeTiers}`);
  }
  const checkSide = (path: string, rewards: readonly RewardPreview[]): void => {
    if (rewards.length === 0) report(path, 'must pay at least one reward');
    rewards.forEach((reward, i) => {
      if (!RewardPreviewSchema.safeParse(reward).success)
        report(`${path}[${i}]`, 'is not a RewardPreview');
      if (
        reward.kind === 'currency' &&
        !(SEASON_REWARD_CURRENCIES as readonly string[]).includes(reward.currency)
      ) {
        report(`${path}[${i}]`, `season tiers may not pay ${reward.currency}`);
      }
    });
  };
  tiers.forEach((t, i) => {
    const path = `season.tiers[${i}]`;
    if (t.tier !== i + 1) report(path, `tier must be ${i + 1}, got ${t.tier}`);
    if (t.starsRequired !== t.tier * config.starsPerTier) {
      report(path, `starsRequired must be tier × ${config.starsPerTier}`);
    }
    checkSide(`${path}.free`, t.free);
    checkSide(`${path}.premium`, t.premium);
  });
  return issues;
}

export function assertValidSeasonTrack(
  tiers: readonly SeasonTierDef[] = seasonTrack.tiers,
  config: SeasonConfig = season,
): void {
  const issues = validateSeasonTrack(tiers, config);
  if (issues.length > 0) {
    throw new Error(
      `Season track is invalid (${issues.length} issue${issues.length === 1 ? '' : 's'}):\n` +
        issues.map((issue) => `  - ${issue.path}: ${issue.message}`).join('\n'),
    );
  }
}
