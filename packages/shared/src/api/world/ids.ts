import { z } from 'zod';
import { CATALOG_KEY, CATALOG_KEY_MAX_LENGTH } from '../../ids.ts';

/**
 * World keys are config keys from `packages/economy` (T-14.05) and the letters catalogue
 * (T-14.07). They live here so the world theme owns its whole contract; the brand still keeps a
 * letter id from passing where an arc id is expected.
 */
function worldKey<const Brand extends string>(brand: Brand, example: string) {
  return z
    .string()
    .max(CATALOG_KEY_MAX_LENGTH)
    .regex(CATALOG_KEY, `Expected a ${brand}: a config key such as "${example}".`)
    .brand<Brand>();
}

/** A recurring guest who writes to the player; apart from the Soirée's one-night guests. */
export const WorldGuestIdSchema = worldKey('WorldGuestId', 'countessVane');
export type WorldGuestId = z.infer<typeof WorldGuestIdSchema>;

/** One story a guest tells in letters, keyed under its guest: `<guest>.<story>`. */
export const GuestArcIdSchema = worldKey('GuestArcId', 'countessVane.inheritance');
export type GuestArcId = z.infer<typeof GuestArcIdSchema>;

/**
 * One letter, keyed under its arc: `<guest>.<story>.<n>`. It is also the template id the letters
 * UI resolves to localised text, so no letter ever carries free text on the wire.
 */
export const LetterIdSchema = worldKey('LetterId', 'countessVane.inheritance.1');
export type LetterId = z.infer<typeof LetterIdSchema>;

/** The wax seal pressed on a guest's letters, which the reveal cracks open. */
export const WaxSealIdSchema = worldKey('WaxSealId', 'crimsonCrest');
export type WaxSealId = z.infer<typeof WaxSealIdSchema>;

/** A server condition a sealed letter waits on, and the template the UI words its hint with. */
export const LetterConditionKeySchema = worldKey('LetterConditionKey', 'ascensions');
export type LetterConditionKey = z.infer<typeof LetterConditionKeySchema>;

/** A breed of one pet species, keyed under it: `<species>.<breed>`. */
export const PetBreedIdSchema = worldKey('PetBreedId', 'poodle.apricot');
export type PetBreedId = z.infer<typeof PetBreedIdSchema>;

/** Whether `child` is keyed directly under `parent`, as `<parent>.<one more segment>`. */
export function isKeyedUnder(child: string, parent: string): boolean {
  if (!child.startsWith(`${parent}.`)) return false;
  const rest = child.slice(parent.length + 1);
  return rest.length > 0 && !rest.includes('.');
}
