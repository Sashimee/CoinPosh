import { z } from 'zod';
import { BoardIdSchema, EventIdSchema } from '../ids.ts';
import {
  AmountSchema,
  DisplayNameSchema,
  EpochMsSchema,
  PositiveAmountSchema,
} from '../primitives.ts';

export const LeaderboardParamsSchema = z.strictObject({
  board: BoardIdSchema,
});
export type LeaderboardParams = z.infer<typeof LeaderboardParamsSchema>;

/** Other players appear by display name only; their IDs are never exposed. */
export const LeaderboardEntrySchema = z.object({
  rank: PositiveAmountSchema,
  displayName: DisplayNameSchema,
  score: AmountSchema,
  isMe: z.boolean(),
});
export type LeaderboardEntry = z.infer<typeof LeaderboardEntrySchema>;

export const LeaderboardResponseSchema = z.object({
  board: BoardIdSchema,
  startsAt: EpochMsSchema,
  endsAt: EpochMsSchema,
  entries: z.array(LeaderboardEntrySchema),
  me: LeaderboardEntrySchema.nullable(),
});
export type LeaderboardResponse = z.infer<typeof LeaderboardResponseSchema>;

export const TimeWindowSchema = z.object({
  startsAt: EpochMsSchema,
  endsAt: EpochMsSchema,
});
export type TimeWindow = z.infer<typeof TimeWindowSchema>;

export const HeistEventSchema = z.object({
  id: EventIdSchema,
  startsAt: EpochMsSchema,
  endsAt: EpochMsSchema,
  progress: AmountSchema,
  goal: PositiveAmountSchema,
});
export type HeistEvent = z.infer<typeof HeistEventSchema>;

/** `goldenHour` is the active window, or else the next scheduled one. */
export const EventsCurrentResponseSchema = z.object({
  serverTime: EpochMsSchema,
  goldenHour: TimeWindowSchema.nullable(),
  heist: HeistEventSchema.nullable(),
});
export type EventsCurrentResponse = z.infer<typeof EventsCurrentResponseSchema>;
