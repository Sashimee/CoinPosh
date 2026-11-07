import { describe, expect, it } from 'vitest';
import { DEFAULT_FEATURE_FLAGS, FeatureFlagsSchema } from './flags.ts';
import { roundTrip } from './test/roundTrip.ts';

describe('FeatureFlags', () => {
  it('ships with monetization and every monetization surface off', () => {
    expect(DEFAULT_FEATURE_FLAGS).toEqual({
      monetization: false,
      premiumSeasonTrack: false,
      rewardedAds: false,
    });
    expect(Object.isFrozen(DEFAULT_FEATURE_FLAGS)).toBe(true);
  });

  it('round-trips the defaults', () => {
    const { parsed, reparsed } = roundTrip(FeatureFlagsSchema, DEFAULT_FEATURE_FLAGS);
    expect(parsed).toEqual(DEFAULT_FEATURE_FLAGS);
    expect(reparsed).toEqual(parsed);
  });

  it('allows sub-flags only while monetization is on', () => {
    const on = { monetization: true, premiumSeasonTrack: true, rewardedAds: true };
    expect(FeatureFlagsSchema.safeParse(on).success).toBe(true);
    expect(FeatureFlagsSchema.safeParse({ ...on, monetization: false }).success).toBe(false);
    expect(
      FeatureFlagsSchema.safeParse({ ...DEFAULT_FEATURE_FLAGS, rewardedAds: true }).success,
    ).toBe(false);
  });

  it('fails loudly on a missing or non-boolean flag', () => {
    expect(
      FeatureFlagsSchema.safeParse({ premiumSeasonTrack: false, rewardedAds: false }).success,
    ).toBe(false);
    expect(
      FeatureFlagsSchema.safeParse({ ...DEFAULT_FEATURE_FLAGS, monetization: 'false' }).success,
    ).toBe(false);
  });

  it('drops flags this client does not know yet', () => {
    expect(FeatureFlagsSchema.parse({ ...DEFAULT_FEATURE_FLAGS, soireeNights: true })).toEqual(
      DEFAULT_FEATURE_FLAGS,
    );
  });
});
