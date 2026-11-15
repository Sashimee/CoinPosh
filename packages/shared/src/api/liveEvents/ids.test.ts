import { describe, expect, expectTypeOf, it } from 'vitest';
import { CATALOG_KEY_MAX_LENGTH, CollectibleIdSchema } from '../../ids.ts';
import { roundTrip } from '../../test/roundTrip.ts';
import {
  LimitedCollectionIdSchema,
  LiveThemeIdSchema,
  ThemedCoinFaceIdSchema,
  type LimitedCollectionId,
  type LiveThemeId,
} from './ids.ts';

const keySchemas = {
  theme: LiveThemeIdSchema,
  collection: LimitedCollectionIdSchema,
  coinFace: ThemedCoinFaceIdSchema,
};

describe('live event ids', () => {
  it.each(Object.entries(keySchemas))('%s ids accept config keys and round-trip', (_, schema) => {
    for (const key of ['winterGala', 'grandPrix-chequered', 'regatta.2026', 'a']) {
      const { parsed, reparsed } = roundTrip(schema, key);
      expect(reparsed).toBe(parsed);
    }
  });

  it.each(Object.entries(keySchemas))('%s ids refuse what is not a config key', (_, schema) => {
    for (const bad of [
      '',
      'WinterGala',
      '2026gala',
      'winter gala',
      'winter--gala',
      'gala-',
      'a'.repeat(CATALOG_KEY_MAX_LENGTH + 1),
      7,
      null,
    ]) {
      expect(schema.safeParse(bad).success, String(bad)).toBe(false);
    }
  });

  it('accepts a key at the length limit', () => {
    expect(LiveThemeIdSchema.safeParse('a'.repeat(CATALOG_KEY_MAX_LENGTH)).success).toBe(true);
  });

  it('names the expected kind in the error, so a bad config row is easy to find', () => {
    expect(LiveThemeIdSchema.safeParse('Winter Gala').error?.issues[0]?.message).toContain(
      'LiveThemeId',
    );
  });

  it('brands each kind apart from the others and from collectibles', () => {
    expectTypeOf<LiveThemeId>().not.toEqualTypeOf<LimitedCollectionId>();
    expectTypeOf(LimitedCollectionIdSchema.parse('baubles')).not.toEqualTypeOf(
      CollectibleIdSchema.parse('baubles'),
    );
  });
});
