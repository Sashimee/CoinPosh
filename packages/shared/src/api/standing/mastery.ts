import { z } from 'zod';
import { CoinTierSchema } from '../../domain.ts';
import { CharmTypeIdSchema } from '../../ids.ts';
import { AmountSchema, PositiveAmountSchema } from '../../primitives.ts';
import { checkUnique } from './refine.ts';

/**
 * A mastery track: coins of one tier banked, or activations of one charm catalog id (an edition
 * masters apart from its base kind, as it levels apart). Both count only server-accepted events.
 */
export const MasteryTrackSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('coinTier'), tier: CoinTierSchema }),
  z.object({ kind: z.literal('charm'), charm: CharmTypeIdSchema }),
]);
export type MasteryTrack = z.infer<typeof MasteryTrackSchema>;
export type MasteryTrackKind = MasteryTrack['kind'];

/** A stable key per track for dedup, i18n and UI lists: `coinTier:gold`, `charm:butler`. */
export function masteryTrackKey(track: MasteryTrack): string {
  return track.kind === 'coinTier' ? `coinTier:${track.tier}` : `charm:${track.charm}`;
}

/**
 * One track as the server counted it. Points per level and the bonus per level come from
 * `packages/economy`; `bonusBp` is what the server applies, already inside its cap.
 * `pointsToNext` is `null` once `level` reaches `maxLevel`.
 */
export const MasteryProgressSchema = z
  .object({
    track: MasteryTrackSchema,
    level: AmountSchema,
    maxLevel: PositiveAmountSchema,
    points: AmountSchema,
    pointsIntoLevel: AmountSchema,
    pointsToNext: PositiveAmountSchema.nullable(),
    bonusBp: AmountSchema,
  })
  .superRefine((mastery, ctx) => {
    const issue = (path: string, message: string) => {
      ctx.addIssue({ code: 'custom', path: [path], message });
    };
    if (mastery.level > mastery.maxLevel) {
      issue('level', `Level ${mastery.level} is past the track's maximum of ${mastery.maxLevel}.`);
    }
    if (mastery.level === mastery.maxLevel && mastery.pointsToNext !== null) {
      issue('pointsToNext', 'A mastered track has no next level.');
    }
    if (mastery.level < mastery.maxLevel && mastery.pointsToNext === null) {
      issue('pointsToNext', 'A track below its maximum names the points to its next level.');
    }
    if (mastery.pointsToNext !== null && mastery.pointsIntoLevel >= mastery.pointsToNext) {
      issue(
        'pointsIntoLevel',
        'Points into a level stay below the next level; the server levels up first.',
      );
    }
    if (mastery.pointsIntoLevel > mastery.points) {
      issue('pointsIntoLevel', 'Points into a level cannot exceed the lifetime points.');
    }
    if (mastery.level === 0 && mastery.bonusBp !== 0) {
      issue('bonusBp', 'A track at level 0 grants no bonus.');
    }
  });
export type MasteryProgress = z.infer<typeof MasteryProgressSchema>;

/** Every track the player has started: all coin tiers, and each charm they have activated. */
export const MasteryResponseSchema = z
  .object({
    tracks: z.array(MasteryProgressSchema),
  })
  .superRefine((mastery, ctx) => {
    checkUnique(
      mastery.tracks,
      ({ track }) => masteryTrackKey(track),
      ctx,
      (i) => ['tracks', i, 'track'],
      'Each mastery track is listed once.',
    );
  });
export type MasteryResponse = z.infer<typeof MasteryResponseSchema>;

/** A track that just gained a level, for the toast and the level chime. */
export const MasteryLevelUpSchema = z.object({
  track: MasteryTrackSchema,
  level: PositiveAmountSchema,
  bonusBp: AmountSchema,
});
export type MasteryLevelUp = z.infer<typeof MasteryLevelUpSchema>;
