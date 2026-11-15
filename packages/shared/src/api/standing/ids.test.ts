import { describe, expect, expectTypeOf, it } from 'vitest';
import { CATALOG_KEY_MAX_LENGTH, TrophyIdSchema } from '../../ids.ts';
import { roundTrip } from '../../test/roundTrip.ts';
import {
  AchievementIdSchema,
  PerkIdSchema,
  StandingCosmeticIdSchema,
  StandingFeatureIdSchema,
  StandingStatIdSchema,
  type AchievementId,
  type PerkId,
} from './ids.ts';

const keySchemas = {
  achievement: AchievementIdSchema,
  perk: PerkIdSchema,
  feature: StandingFeatureIdSchema,
  cosmetic: StandingCosmeticIdSchema,
  stat: StandingStatIdSchema,
};

describe('standing ids', () => {
  it.each(Object.entries(keySchemas))('%s ids accept config keys and round-trip', (_, schema) => {
    for (const key of ['firstCascade', 'baron1-autoDrop', 'duke.offline_cap', 'a']) {
      const { parsed, reparsed } = roundTrip(schema, key);
      expect(reparsed).toBe(parsed);
    }
  });

  it.each(Object.entries(keySchemas))('%s ids refuse what is not a config key', (_, schema) => {
    for (const bad of [
      '',
      'FirstCascade',
      '1stCascade',
      'first cascade',
      'first--cascade',
      'cascade-',
      'coin 7Hq2LmX9pA',
      'a'.repeat(CATALOG_KEY_MAX_LENGTH + 1),
      42,
      null,
    ]) {
      expect(schema.safeParse(bad).success, String(bad)).toBe(false);
    }
  });

  it('names the expected kind in the error, so a bad config row is easy to find', () => {
    const result = AchievementIdSchema.safeParse('Not A Key');
    expect(result.error?.issues[0]?.message).toContain('AchievementId');
  });

  it('brands each kind apart from the others and from trophies', () => {
    expectTypeOf<AchievementId>().not.toEqualTypeOf<PerkId>();
    expectTypeOf(AchievementIdSchema.parse('firstTrophy')).not.toEqualTypeOf(
      TrophyIdSchema.parse('firstTrophy'),
    );
  });
});
