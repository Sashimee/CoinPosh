import { z } from 'zod';
import { RaritySchema } from '../../domain.ts';
import { CollectibleIdSchema, VenueIdSchema } from '../../ids.ts';
import { AmountSchema, EpochMsSchema } from '../../primitives.ts';
import { LimitedCollectionIdSchema, LiveThemeIdSchema, ThemedCoinFaceIdSchema } from './ids.ts';
import { checkUnique, checkWindow } from './refine.ts';
import { LiveOddsSchema, LivePitySchema, LiveRewardSchema } from './rewards.ts';

/**
 * `holiday`: a festive window such as a winter gala. `tieIn`: a luxury-calendar moment such as
 * grand prix week, fashion week or regatta season, never a brand or trademark.
 */
export const LIVE_THEME_KINDS = ['holiday', 'tieIn'] as const;
export const LiveThemeKindSchema = z.enum(LIVE_THEME_KINDS);
export type LiveThemeKind = z.infer<typeof LiveThemeKindSchema>;

/**
 * A themed window from the server's remote-config calendar (T-13.10). The client dresses the
 * listed venues' tables by `id`, stamps `coinFace` on minted coins and opens `collection`; all
 * three switch with the window, without a deploy.
 */
export const LiveThemeSchema = z
  .object({
    id: LiveThemeIdSchema,
    kind: LiveThemeKindSchema,
    startsAt: EpochMsSchema,
    endsAt: EpochMsSchema,
    venues: z.array(VenueIdSchema).min(1),
    coinFace: ThemedCoinFaceIdSchema.nullable(),
    collection: LimitedCollectionIdSchema.nullable(),
  })
  .superRefine((theme, ctx) => {
    checkWindow(theme, ctx, []);
    checkUnique(
      theme.venues,
      (venue) => venue,
      ctx,
      (i) => ['venues', i],
      'A theme dresses each venue once.',
    );
  });
export type LiveTheme = z.infer<typeof LiveThemeSchema>;

export const LimitedCollectionItemSchema = z.object({
  collectibleId: CollectibleIdSchema,
  rarity: RaritySchema,
  owned: AmountSchema,
});
export type LimitedCollectionItem = z.infer<typeof LimitedCollectionItemSchema>;

/**
 * A theme's limited collection. Items drop from play with the odds and pity shown here (the pity
 * counts drops since the last new item); `completion` pays once every item is owned, and
 * `completedAt` stamps that moment.
 */
export const LimitedCollectionSchema = z
  .object({
    id: LimitedCollectionIdSchema,
    theme: LiveThemeIdSchema,
    items: z.array(LimitedCollectionItemSchema).min(1),
    odds: LiveOddsSchema,
    pity: LivePitySchema,
    completion: z.array(LiveRewardSchema).min(1),
    completedAt: EpochMsSchema.nullable(),
  })
  .superRefine((collection, ctx) => {
    checkUnique(
      collection.items,
      (item) => item.collectibleId,
      ctx,
      (i) => ['items', i, 'collectibleId'],
      'Each item is listed once, with its count.',
    );
    const complete = collection.items.every((item) => item.owned > 0);
    if (complete !== (collection.completedAt !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['completedAt'],
        message: 'A collection has a completion time exactly when every item is owned.',
      });
    }
    const rarities = new Set(collection.odds.map((row) => row.rarity));
    collection.items.forEach((item, i) => {
      if (!rarities.has(item.rarity)) {
        ctx.addIssue({
          code: 'custom',
          path: ['items', i, 'rarity'],
          message: `The odds sheet has no ${item.rarity} row for this item.`,
        });
      }
    });
  });
export type LimitedCollection = z.infer<typeof LimitedCollectionSchema>;

/**
 * The themes running now and those announced next, soonest first, with the limited collection
 * of every running theme that has one.
 */
export const ThemesResponseSchema = z
  .object({
    serverTime: EpochMsSchema,
    active: z.array(LiveThemeSchema),
    upcoming: z.array(LiveThemeSchema),
    collections: z.array(LimitedCollectionSchema),
  })
  .superRefine((answer, ctx) => {
    const issue = (path: PropertyKey[], message: string) => {
      ctx.addIssue({ code: 'custom', path, message });
    };
    const { serverTime } = answer;
    answer.active.forEach((theme, i) => {
      if (serverTime < theme.startsAt || serverTime >= theme.endsAt) {
        issue(['active', i], 'An active theme is open at the server time.');
      }
    });
    answer.upcoming.forEach((theme, i) => {
      if (theme.startsAt <= serverTime) issue(['upcoming', i], 'An upcoming theme opens later.');
      const previous = answer.upcoming[i - 1];
      if (previous !== undefined && previous.startsAt > theme.startsAt) {
        issue(['upcoming', i, 'startsAt'], 'Upcoming themes are listed soonest first.');
      }
    });
    checkUnique(
      [...answer.active, ...answer.upcoming],
      (theme) => theme.id,
      ctx,
      (i) =>
        i < answer.active.length
          ? ['active', i, 'id']
          : ['upcoming', i - answer.active.length, 'id'],
      'Each theme is listed once.',
    );
    checkUnique(
      answer.collections,
      (collection) => collection.id,
      ctx,
      (i) => ['collections', i, 'id'],
      'Each collection is listed once.',
    );
    const listed = new Set(answer.collections.map((collection) => collection.id));
    answer.active.forEach((theme, i) => {
      if (theme.collection !== null && !listed.has(theme.collection)) {
        issue(['active', i, 'collection'], `Collection ${theme.collection} is not listed.`);
      }
    });
    answer.collections.forEach((collection, i) => {
      const owner = answer.active.find((theme) => theme.id === collection.theme);
      if (owner?.collection !== collection.id) {
        issue(['collections', i, 'theme'], 'A collection belongs to the active theme naming it.');
      }
    });
  });
export type ThemesResponse = z.infer<typeof ThemesResponseSchema>;
