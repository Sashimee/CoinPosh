import { get, post, type Endpoint } from '../endpoint.ts';
import { BossClaimRequestSchema, BossClaimResponseSchema, BossResponseSchema } from './boss.ts';
import {
  CalendarClaimRequestSchema,
  CalendarClaimResponseSchema,
  CalendarResponseSchema,
} from './calendars.ts';
import {
  PuzzleResponseSchema,
  PuzzleStartRequestSchema,
  PuzzleStartResponseSchema,
  PuzzleSubmitRequestSchema,
  PuzzleSubmitResponseSchema,
} from './puzzle.ts';
import { ThemesResponseSchema } from './themes.ts';
import { TimeZoneSetRequestSchema, TimeZoneSetResponseSchema } from './time.ts';

// TODO(lead-architect): pass to `composeEndpoints` in `../endpoints.ts` in T-13.15, the same
// change that adds `liveEventsFixtures` to `test/fixtures.ts` and the Demo handlers; both are
// mapped over every EndpointName, so registering the group first breaks their typecheck. Boss
// damage dealt on the table rides the table answers as a `BossHit`, not this map.
/** Live events (M13): login calendars, the player's zone, the daily puzzle, the boss and themes. */
export const liveEventsEndpoints = {
  liveEventsCalendar: get('/v1/live-events/calendar', CalendarResponseSchema),
  liveEventsCalendarClaim: post(
    '/v1/live-events/calendar/claim',
    CalendarClaimRequestSchema,
    CalendarClaimResponseSchema,
  ),
  liveEventsTimeZone: post(
    '/v1/live-events/time-zone',
    TimeZoneSetRequestSchema,
    TimeZoneSetResponseSchema,
  ),
  liveEventsPuzzle: get('/v1/live-events/puzzle', PuzzleResponseSchema),
  liveEventsPuzzleStart: post(
    '/v1/live-events/puzzle/start',
    PuzzleStartRequestSchema,
    PuzzleStartResponseSchema,
  ),
  liveEventsPuzzleSubmit: post(
    '/v1/live-events/puzzle/submit',
    PuzzleSubmitRequestSchema,
    PuzzleSubmitResponseSchema,
  ),
  liveEventsBoss: get('/v1/live-events/boss', BossResponseSchema),
  liveEventsBossClaim: post(
    '/v1/live-events/boss/claim',
    BossClaimRequestSchema,
    BossClaimResponseSchema,
  ),
  liveEventsThemes: get('/v1/live-events/themes', ThemesResponseSchema),
} as const satisfies Record<string, Endpoint>;

export type LiveEventsEndpoints = typeof liveEventsEndpoints;
export type LiveEventsEndpointName = keyof LiveEventsEndpoints;
export const LIVE_EVENTS_ENDPOINT_NAMES = Object.keys(
  liveEventsEndpoints,
) as LiveEventsEndpointName[];
