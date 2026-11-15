import { z } from 'zod';
import { CATALOG_KEY, CATALOG_KEY_MAX_LENGTH } from '../../ids.ts';

/**
 * Standing keys are config keys from `packages/economy` (T-12.02). They live here rather than in
 * `../../ids.ts` so the standing theme owns its whole contract; the brand still keeps an
 * achievement id from passing where a perk id is expected.
 */
function standingKey<const Brand extends string>(brand: Brand, example: string) {
  return z
    .string()
    .max(CATALOG_KEY_MAX_LENGTH)
    .regex(CATALOG_KEY, `Expected a ${brand}: a config key such as "${example}".`)
    .brand<Brand>();
}

export const AchievementIdSchema = standingKey('AchievementId', 'firstCascade');
export type AchievementId = z.infer<typeof AchievementIdSchema>;

export const PerkIdSchema = standingKey('PerkId', 'baron1-autoDrop');
export type PerkId = z.infer<typeof PerkIdSchema>;

/** A feature a perk switches on server-side, such as `autoDrop` (T-18.04). */
export const StandingFeatureIdSchema = standingKey('StandingFeatureId', 'autoDrop');
export type StandingFeatureId = z.infer<typeof StandingFeatureIdSchema>;

/**
 * A cosmetic a rank or achievement awards (a crest, lounge decor). T-25.01 owns the cosmetics
 * catalogue; until it lands the key is checked as a config key only.
 */
export const StandingCosmeticIdSchema = standingKey('StandingCosmeticId', 'baronsCrest');
export type StandingCosmeticId = z.infer<typeof StandingCosmeticIdSchema>;

/** A stat a boost perk raises, named as `packages/economy` names it. */
export const StandingStatIdSchema = standingKey('StandingStatId', 'offlineRate');
export type StandingStatId = z.infer<typeof StandingStatIdSchema>;
