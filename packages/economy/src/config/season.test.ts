import {
  DEFAULT_FEATURE_FLAGS,
  FeatureFlagsSchema,
  SeasonResponseSchema,
  SeasonTierSchema,
} from '@coinposh/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { simModel } from '../../sim/model.ts';
import { activeTick, claimOffline, createContext, createPlayer } from '../../sim/player.ts';
import { createRng } from '../rng.ts';
import { economyConfig, pacing, season } from './index.ts';
import { questCadences } from './quests.ts';
import {
  buildSeasonTiers,
  questStarsPerSeason,
  seasonPremiumUnlocked,
  seasonTierAt,
  seasonTiersForResponse,
  seasonTrack,
  validateSeasonTrack,
} from './season.ts';

const SEASON_DAYS = season.weeks * 7;
/** 30 h of play spread over the season, rounded up to whole minutes (≈ 43 min a day). */
const REFERENCE_SESSION_MINUTES = Math.ceil((30 * 60) / SEASON_DAYS);
/** quests.test.ts proves every weekly target falls inside the first five reference sessions. */
const WEEKLY_DONE_BY_SESSION = 5;
const SEEDS = [1, 2, 3, 4, 5];

const band = pacing.find((t) => t.id === 'seasonFreeTrack');
if (band === undefined) throw new Error('pacing has no seasonFreeTrack row');

const starsOf = (rewards: readonly { kind: string; currency?: string; amount?: number }[]) =>
  rewards.reduce(
    (s, r) => s + (r.kind === 'currency' && r.currency === 'stars' ? (r.amount ?? 0) : 0),
    0,
  );
const dailyQuestStars = questCadences.daily.slots.reduce(
  (s, d) => s + starsOf(questCadences.daily.rewards[d]),
  0,
);
const weeklyQuestStars = questCadences.weekly.slots.reduce(
  (s, d) => s + starsOf(questCadences.weekly.rewards[d]),
  0,
);

interface SeasonRun {
  /** Active hours when the last free tier unlocked, or null if the season ended first. */
  readonly finishHours: number | null;
  readonly finishDay: number | null;
  readonly questStars: number;
}

/**
 * One reference session a day at 19:00 in the economy sim (drops, crates and album sets pay
 * Stars there), the offline vault claimed in between, and, with `withQuests`, every daily
 * quest claimed at the end of each session and every weekly one at the end of the fifth.
 */
function playSeason(seed: number, withQuests: boolean): SeasonRun {
  const ctx = createContext(economyConfig, simModel, createRng(seed));
  const player = createPlayer(ctx);
  let questStars = 0;
  let lastEndHour: number | null = null;
  for (let day = 0; day < SEASON_DAYS; day++) {
    const start = day * 24 + 19;
    if (lastEndHour !== null) claimOffline(ctx, player, start - lastEndHour);
    for (let t = 0; t < (REFERENCE_SESSION_MINUTES * 60) / simModel.tickSeconds; t++) {
      activeTick(ctx, player);
      if (player.stars + questStars >= seasonTrack.totalStars) {
        return { finishHours: player.activeSeconds / 3_600, finishDay: day + 1, questStars };
      }
    }
    if (withQuests) {
      questStars += dailyQuestStars;
      if (day % 7 === WEEKLY_DONE_BY_SESSION - 1) questStars += weeklyQuestStars;
    }
    if (player.stars + questStars >= seasonTrack.totalStars) {
      return { finishHours: player.activeSeconds / 3_600, finishDay: day + 1, questStars };
    }
    lastEndHour = start + REFERENCE_SESSION_MINUTES / 60;
  }
  return { finishHours: null, finishDay: null, questStars };
}

const withQuests = SEEDS.map((seed) => playSeason(seed, true));
const withoutQuests = SEEDS.map((seed) => playSeason(seed, false));

describe('season track', () => {
  it('validates against season in progression.ts', () => {
    expect(validateSeasonTrack()).toEqual([]);
    expect(seasonTrack.tiers).toHaveLength(season.freeTiers);
    expect(seasonTrack.totalStars).toBe(season.freeTiers * season.starsPerTier);
  });

  it('reports what SeasonTierSchema and SeasonResponseSchema accept', () => {
    const tiers = seasonTiersForResponse();
    for (const t of tiers) expect(SeasonTierSchema.safeParse(t).success).toBe(true);
    const response = {
      id: 'season_abcdefgh',
      startsAt: 0,
      endsAt: SEASON_DAYS * 86_400_000,
      stars: 0,
      tiers,
      claimedFree: [],
      claimedPremium: [],
      premiumUnlocked: seasonPremiumUnlocked(DEFAULT_FEATURE_FLAGS),
    };
    expect(SeasonResponseSchema.safeParse(response).success).toBe(true);
  });

  it('pays something on every free tier, never Stars or venue currencies', () => {
    for (const t of seasonTrack.tiers) {
      expect(t.free.length).toBeGreaterThan(0);
      for (const r of [...t.free, ...t.premium]) {
        if (r.kind === 'currency') expect(['pearls', 'keys', 'tickets']).toContain(r.currency);
      }
    }
  });

  it('climbs: each decade’s showpiece outpays the last and the finale outpays them all', () => {
    const pearlsAt = (tier: number) =>
      seasonTrack.tiers[tier - 1]?.free.reduce(
        (s, r) => s + (r.kind === 'currency' && r.currency === 'pearls' ? r.amount : 0),
        0,
      ) ?? 0;
    const showpieces = [10, 20, 30, 40].map(pearlsAt);
    for (let i = 1; i < showpieces.length; i++) {
      expect(showpieces[i]).toBeGreaterThan(showpieces[i - 1] ?? Number.POSITIVE_INFINITY);
    }
    expect(pearlsAt(season.freeTiers)).toBeGreaterThan(Math.max(...showpieces));
  });

  it('rejects a track that drifts from season.freeTiers or starsPerTier', () => {
    const tiers = buildSeasonTiers();
    const issues = validateSeasonTrack(tiers.slice(1), season).map((i) => i.path);
    expect(issues).toContain('season.tiers');
    const wrongStars = tiers.map((t) => ({ ...t, starsRequired: t.starsRequired + 1 }));
    expect(validateSeasonTrack(wrongStars, season).length).toBe(season.freeTiers);
  });

  it('counts tiers as the sim does: whole tiers of starsPerTier, capped at freeTiers', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10 * seasonTrack.totalStars }), (stars) => {
        const tier = seasonTierAt(stars);
        expect(tier).toBe(Math.min(season.freeTiers, Math.floor(stars / season.starsPerTier)));
        if (tier > 0 && tier < season.freeTiers) {
          expect(stars).toBeGreaterThanOrEqual(
            seasonTrack.tiers[tier - 1]?.starsRequired ?? Infinity,
          );
          expect(stars).toBeLessThan(seasonTrack.tiers[tier]?.starsRequired ?? -Infinity);
        }
      }),
      { numRuns: 300 },
    );
    expect(() => seasonTierAt(-1)).toThrow(RangeError);
  });
});

describe('premium track', () => {
  it('stays locked whenever flags.monetization is off, whatever else is set', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), fc.boolean(), (monetization, premium, ads) => {
        const parsed = FeatureFlagsSchema.safeParse({
          monetization,
          premiumSeasonTrack: premium,
          rewardedAds: ads,
        });
        if (!parsed.success) return;
        if (!parsed.data.monetization) expect(seasonPremiumUnlocked(parsed.data)).toBe(false);
        expect(seasonPremiumUnlocked(parsed.data)).toBe(monetization && premium);
      }),
    );
    expect(seasonPremiumUnlocked(DEFAULT_FEATURE_FLAGS)).toBe(false);
  });

  it('has rewards on every tier so the locked track can render', () => {
    for (const t of seasonTrack.tiers) expect(t.premium.length).toBeGreaterThan(0);
  });
});

describe(`free track pacing (02-ECONOMY: ≈ 30 h over ${season.weeks} weeks)`, () => {
  it('counts quest Stars as the quest config pays them', () => {
    expect(questStarsPerSeason()).toBe(
      SEASON_DAYS * dailyQuestStars + season.weeks * weeklyQuestStars,
    );
  });

  it.each(SEEDS.map((seed, i) => ({ seed, run: withQuests[i] })))(
    'seed $seed: a quest-completing reference player finishes inside the band and the season',
    ({ run }) => {
      expect(run?.finishHours).not.toBeNull();
      expect(run?.finishHours ?? 0).toBeGreaterThanOrEqual(band.min);
      expect(run?.finishHours ?? Infinity).toBeLessThanOrEqual(band.max);
      expect(run?.finishDay ?? Infinity).toBeLessThanOrEqual(SEASON_DAYS);
    },
  );

  it.each(SEEDS.map((seed, i) => ({ seed, run: withoutQuests[i] })))(
    'seed $seed: a player who never claims a quest still finishes inside the band and the season',
    ({ run }) => {
      expect(run?.finishHours).not.toBeNull();
      expect(run?.finishHours ?? 0).toBeGreaterThanOrEqual(band.min);
      expect(run?.finishHours ?? Infinity).toBeLessThanOrEqual(band.max);
      expect(run?.finishDay ?? Infinity).toBeLessThanOrEqual(SEASON_DAYS);
    },
  );

  it('keeps quests a bonus on top of play: at most 10 % of the track’s Stars', () => {
    expect(questStarsPerSeason()).toBeLessThanOrEqual(0.1 * seasonTrack.totalStars);
    for (let i = 0; i < SEEDS.length; i++) {
      expect(withQuests[i]?.finishHours ?? Infinity).toBeLessThan(
        withoutQuests[i]?.finishHours ?? -Infinity,
      );
    }
  });
});
