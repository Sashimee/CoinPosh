import { z } from 'zod';
import { WalletSchema } from '../../domain.ts';
import { FairProofSchema } from '../../fair.ts';
import { AmountSchema, EpochMsSchema, PositiveAmountSchema } from '../../primitives.ts';
import { checkClockAt, checkUnique } from './refine.ts';
import { LiveGrantSchema, LiveOddsSchema, LivePitySchema, LiveRewardSchema } from './rewards.ts';
import { DayKeySchema, PlayerClockSchema } from './time.ts';

/** The two login calendars, shortest first. Their lengths are fixed by 00-VISION. */
export const CALENDAR_TRACKS = ['week', 'month'] as const;
export const CalendarTrackSchema = z.enum(CALENDAR_TRACKS);
export type CalendarTrack = z.infer<typeof CalendarTrackSchema>;

export const CALENDAR_TRACK_LENGTHS = { week: 7, month: 28 } as const satisfies Record<
  CalendarTrack,
  number
>;

/** A slot rolled on the server with fair RNG; the odds and pity are shown before the claim. */
export const CalendarRollSchema = z.object({
  kind: z.literal('roll'),
  odds: LiveOddsSchema,
  pity: LivePitySchema,
});
export type CalendarRoll = z.infer<typeof CalendarRollSchema>;

/** What one calendar day pays: fixed rewards, or one roll beside them. */
export const CalendarSlotRewardSchema = z.discriminatedUnion('kind', [
  ...LiveRewardSchema.options,
  CalendarRollSchema,
]);
export type CalendarSlotReward = z.infer<typeof CalendarSlotRewardSchema>;

export const CalendarSlotSchema = z
  .object({
    day: PositiveAmountSchema,
    rewards: z.array(CalendarSlotRewardSchema).min(1),
  })
  .refine((slot) => slot.rewards.filter((reward) => reward.kind === 'roll').length <= 1, {
    path: ['rewards'],
    message: 'A calendar day rolls at most once.',
  });
export type CalendarSlot = z.infer<typeof CalendarSlotSchema>;

/**
 * One track as the server keeps it. A track only moves when a day is claimed and never resets:
 * a missed day pays nothing and costs nothing. `nextDay` is the slot the next claim pays; after
 * the last slot the track starts its next `cycle` at day 1. `claims` counts every claim ever made.
 */
export const CalendarTrackStateSchema = z
  .object({
    track: CalendarTrackSchema,
    cycle: PositiveAmountSchema,
    nextDay: PositiveAmountSchema,
    claims: AmountSchema,
    slots: z.array(CalendarSlotSchema),
  })
  .superRefine((state, ctx) => {
    const length = CALENDAR_TRACK_LENGTHS[state.track];
    const issue = (path: PropertyKey[], message: string) => {
      ctx.addIssue({ code: 'custom', path, message });
    };
    if (state.slots.length !== length) {
      issue(['slots'], `The ${state.track} calendar lists all ${length} days.`);
    }
    state.slots.forEach((slot, i) => {
      if (slot.day !== i + 1) issue(['slots', i, 'day'], 'Slots are listed in day order from 1.');
    });
    if (state.nextDay > length) {
      issue(['nextDay'], `The ${state.track} calendar has ${length} days.`);
      return;
    }
    if (state.claims !== (state.cycle - 1) * length + state.nextDay - 1) {
      issue(['claims'], 'Every claim moves the track one day, so claims, cycle and day agree.');
    }
  });
export type CalendarTrackState = z.infer<typeof CalendarTrackStateSchema>;

function checkTracks(
  tracks: readonly { track: CalendarTrack; claims: number }[],
  ctx: z.RefinementCtx,
): void {
  tracks.forEach(({ track }, i) => {
    if (track !== CALENDAR_TRACKS[i]) {
      ctx.addIssue({
        code: 'custom',
        path: ['tracks', i, 'track'],
        message: `Tracks are listed once each, as ${CALENDAR_TRACKS.join(' then ')}.`,
      });
    }
  });
  if (new Set(tracks.map(({ claims }) => claims)).size > 1) {
    ctx.addIssue({
      code: 'custom',
      path: ['tracks'],
      message: 'One claimed day advances both calendars, so both count the same claims.',
    });
  }
}

const CalendarTracksSchema = z.array(CalendarTrackStateSchema).length(CALENDAR_TRACKS.length);

/**
 * Both calendars and the player's day. `claimable` is false once today is claimed; the server
 * decides it from its own clock and the player's zone, never from the client's clock.
 */
export const CalendarResponseSchema = z
  .object({
    serverTime: EpochMsSchema,
    clock: PlayerClockSchema,
    claimable: z.boolean(),
    lastClaimDay: DayKeySchema.nullable(),
    tracks: CalendarTracksSchema,
  })
  .superRefine((calendar, ctx) => {
    checkClockAt(calendar.clock, calendar.serverTime, ctx, ['clock']);
    checkTracks(calendar.tracks, ctx);
    const issue = (path: string, message: string) => {
      ctx.addIssue({ code: 'custom', path: [path], message });
    };
    const claimedToday = calendar.lastClaimDay === calendar.clock.day;
    if (claimedToday === calendar.claimable) {
      issue('claimable', 'A day is claimable exactly when it is not yet claimed.');
    }
    if (calendar.lastClaimDay !== null && calendar.lastClaimDay > calendar.clock.day) {
      issue('lastClaimDay', 'The last claim cannot be on a day after today.');
    }
    const claims = calendar.tracks[0]?.claims ?? 0;
    if ((calendar.lastClaimDay === null) !== (claims === 0)) {
      issue('lastClaimDay', 'A last claim day is set exactly when a day has been claimed.');
    }
  });
export type CalendarResponse = z.infer<typeof CalendarResponseSchema>;

/** Claims today on both calendars. Empty: the server picks the day from its clock and the zone. */
export const CalendarClaimRequestSchema = z.strictObject({});
export type CalendarClaimRequest = z.infer<typeof CalendarClaimRequestSchema>;

/** What one track paid for the day; `proof` is set exactly when the slot rolled. */
export const CalendarPayoutSchema = z.object({
  track: CalendarTrackSchema,
  day: PositiveAmountSchema,
  granted: z.array(LiveGrantSchema).min(1),
  proof: FairProofSchema.nullable(),
});
export type CalendarPayout = z.infer<typeof CalendarPayoutSchema>;

/** Idempotent per day: a repeat on the same day returns the same payout without paying it twice. */
export const CalendarClaimResponseSchema = z
  .object({
    day: DayKeySchema,
    claimedAt: EpochMsSchema,
    nextDayAt: EpochMsSchema,
    payouts: z.array(CalendarPayoutSchema).length(CALENDAR_TRACKS.length),
    wallet: WalletSchema,
    tracks: CalendarTracksSchema,
  })
  .superRefine((claim, ctx) => {
    checkTracks(claim.tracks, ctx);
    checkUnique(
      claim.payouts,
      (payout) => payout.track,
      ctx,
      (i) => ['payouts', i, 'track'],
      'Each calendar pays once per claim.',
    );
    if (claim.tracks.some(({ claims }) => claims === 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['tracks'],
        message: 'A track that just paid counts that claim.',
      });
    }
    if (claim.nextDayAt <= claim.claimedAt) {
      ctx.addIssue({
        code: 'custom',
        path: ['nextDayAt'],
        message: 'The next day opens after the claim.',
      });
    }
    claim.payouts.forEach((payout, i) => {
      const state = claim.tracks.find(({ track }) => track === payout.track);
      if (state === undefined) return;
      const length = CALENDAR_TRACK_LENGTHS[payout.track];
      const paidDay = state.nextDay === 1 ? length : state.nextDay - 1;
      if (payout.day !== paidDay) {
        ctx.addIssue({
          code: 'custom',
          path: ['payouts', i, 'day'],
          message: `The ${payout.track} payout is for the day just before the track's next day.`,
        });
      }
      const slot = state.slots[payout.day - 1];
      const rolled = slot?.rewards.some((reward) => reward.kind === 'roll') ?? false;
      if (rolled !== (payout.proof !== null)) {
        ctx.addIssue({
          code: 'custom',
          path: ['payouts', i, 'proof'],
          message: 'A payout carries a fairness proof exactly when its slot rolled.',
        });
      }
    });
  });
export type CalendarClaimResponse = z.infer<typeof CalendarClaimResponseSchema>;
