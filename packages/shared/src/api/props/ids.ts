import { z } from 'zod';
import { CATALOG_KEY, CATALOG_KEY_MAX_LENGTH } from '../../ids.ts';

function propKey<const Brand extends string>(brand: Brand, example: string) {
  return z
    .string()
    .max(CATALOG_KEY_MAX_LENGTH)
    .regex(CATALOG_KEY, `Expected a ${brand}: a config key such as "${example}".`)
    .brand<Brand>();
}

/**
 * A table layout: which pegs, targets, turntables, conveyors and gates stand where. Layouts are
 * data the server knows (T-16.05), so the rate envelope and the verifier replay key by this id.
 */
export const VenueLayoutIdSchema = propKey('VenueLayoutId', 'rivieraYacht.classic');
export type VenueLayoutId = z.infer<typeof VenueLayoutIdSchema>;

/** One hole or chute in a layout's back wall; unique within its layout only. */
export const TargetIdSchema = propKey('TargetId', 'backWall.leftChute');
export type TargetId = z.infer<typeof TargetIdSchema>;

export const PROP_KINDS = [
  'target',
  'pegField',
  'turntable',
  'conveyor',
  'gate',
  'jackpotBall',
] as const;
export const PropKindSchema = z.enum(PROP_KINDS);
export type PropKind = z.infer<typeof PropKindSchema>;

export const JACKPOT_BALL_ID_PREFIX = 'jackpot';

// Mirrors `entityId` in ../../ids.ts, which is module-private; keep the body pattern in step.
/** One jackpot ball riding the table, spawned and valued by the server. */
export const JackpotBallIdSchema = z
  .string()
  .regex(
    new RegExp(`^${JACKPOT_BALL_ID_PREFIX}_[0-9A-Za-z]{8,32}$`),
    `Expected a JackpotBallId like "${JACKPOT_BALL_ID_PREFIX}_" followed by 8 to 32 letters or digits.`,
  )
  .brand<'JackpotBallId'>();
export type JackpotBallId = z.infer<typeof JackpotBallIdSchema>;
