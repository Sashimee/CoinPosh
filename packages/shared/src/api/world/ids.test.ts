import { describe, expect, expectTypeOf, it } from 'vitest';
import { CATALOG_KEY_MAX_LENGTH, SoireeGuestIdSchema } from '../../ids.ts';
import { roundTrip } from '../../test/roundTrip.ts';
import {
  GuestArcIdSchema,
  LetterConditionKeySchema,
  LetterIdSchema,
  PetBreedIdSchema,
  WaxSealIdSchema,
  WorldGuestIdSchema,
  isKeyedUnder,
  type GuestArcId,
  type LetterId,
  type WorldGuestId,
} from './ids.ts';

const keySchemas = {
  guest: WorldGuestIdSchema,
  arc: GuestArcIdSchema,
  letter: LetterIdSchema,
  seal: WaxSealIdSchema,
  condition: LetterConditionKeySchema,
  breed: PetBreedIdSchema,
};

describe('world ids', () => {
  it.each(Object.entries(keySchemas))('%s ids accept config keys and round-trip', (_, schema) => {
    for (const key of ['countessVane', 'countessVane.inheritance.1', 'poodle.apricot', 'a']) {
      const { parsed, reparsed } = roundTrip(schema, key);
      expect(reparsed).toBe(parsed);
    }
  });

  it.each(Object.entries(keySchemas))('%s ids refuse what is not a config key', (_, schema) => {
    for (const bad of [
      '',
      'CountessVane',
      '1poodle',
      'countess vane',
      'poodle..apricot',
      'poodle.',
      'a'.repeat(CATALOG_KEY_MAX_LENGTH + 1),
      5,
      null,
    ]) {
      expect(schema.safeParse(bad).success, String(bad)).toBe(false);
    }
  });

  it('accepts a key at the length limit', () => {
    expect(LetterIdSchema.safeParse('a'.repeat(CATALOG_KEY_MAX_LENGTH)).success).toBe(true);
  });

  it('names the expected kind in the error, so a bad catalogue row is easy to find', () => {
    expect(LetterIdSchema.safeParse('Letter One').error?.issues[0]?.message).toContain('LetterId');
  });

  it('brands each kind apart from the others and from Soirée guests', () => {
    expectTypeOf<LetterId>().not.toEqualTypeOf<GuestArcId>();
    expectTypeOf<WorldGuestId>().not.toEqualTypeOf<GuestArcId>();
    expectTypeOf(WorldGuestIdSchema.parse('countessVane')).not.toEqualTypeOf(
      SoireeGuestIdSchema.parse('countessVane'),
    );
  });
});

describe('isKeyedUnder', () => {
  it('accepts a key one segment under its parent', () => {
    expect(isKeyedUnder('countessVane.inheritance', 'countessVane')).toBe(true);
    expect(isKeyedUnder('countessVane.inheritance.5', 'countessVane.inheritance')).toBe(true);
    expect(isKeyedUnder('poodle.apricot', 'poodle')).toBe(true);
  });

  it.each([
    ['another parent', 'cat.siamese', 'poodle'],
    ['a parent that is only a prefix', 'poodleMini.apricot', 'poodle'],
    ['a key two segments down', 'countessVane.inheritance.1', 'countessVane'],
    ['the parent itself', 'poodle', 'poodle'],
    ['an empty segment', 'poodle.', 'poodle'],
  ])('refuses %s', (_label, child, parent) => {
    expect(isKeyedUnder(child, parent)).toBe(false);
  });
});
