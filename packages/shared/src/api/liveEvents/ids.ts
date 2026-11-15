import { z } from 'zod';
import { CATALOG_KEY, CATALOG_KEY_MAX_LENGTH } from '../../ids.ts';

/**
 * Live event keys are config keys from `packages/economy` (T-13.02) and the remote-config
 * calendar (T-13.10). They live here so the live events theme owns its whole contract; the brand
 * still keeps a theme id from passing where a collection id is expected.
 */
function liveEventKey<const Brand extends string>(brand: Brand, example: string) {
  return z
    .string()
    .max(CATALOG_KEY_MAX_LENGTH)
    .regex(CATALOG_KEY, `Expected a ${brand}: a config key such as "${example}".`)
    .brand<Brand>();
}

/** A holiday or tie-in window; the render, VFX and audio layers key their dressing by it. */
export const LiveThemeIdSchema = liveEventKey('LiveThemeId', 'winterGala');
export type LiveThemeId = z.infer<typeof LiveThemeIdSchema>;

/** A limited collection a theme opens; its items are collectibles with their own pity. */
export const LimitedCollectionIdSchema = liveEventKey('LimitedCollectionId', 'winterGala-baubles');
export type LimitedCollectionId = z.infer<typeof LimitedCollectionIdSchema>;

/** A themed coin face the render layer stamps on minted coins while its theme runs. */
export const ThemedCoinFaceIdSchema = liveEventKey('ThemedCoinFaceId', 'grandPrix-chequered');
export type ThemedCoinFaceId = z.infer<typeof ThemedCoinFaceIdSchema>;
