import { z } from 'zod';

/**
 * Server-driven feature flags. Every monetization surface is gated by `monetization`,
 * and its sub-flags may only be on while the master switch is on.
 */
export const FeatureFlagsSchema = z
  .object({
    monetization: z.boolean(),
    premiumSeasonTrack: z.boolean(),
    rewardedAds: z.boolean(),
  })
  .refine((flags) => flags.monetization || (!flags.premiumSeasonTrack && !flags.rewardedAds), {
    message: 'premiumSeasonTrack and rewardedAds require monetization to be on.',
    path: ['monetization'],
  });
export type FeatureFlags = z.infer<typeof FeatureFlagsSchema>;

export const DEFAULT_FEATURE_FLAGS: Readonly<FeatureFlags> = Object.freeze({
  monetization: false,
  premiumSeasonTrack: false,
  rewardedAds: false,
});
