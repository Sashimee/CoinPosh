import { z } from 'zod';
import { VENUE_IDS, VenueIdSchema, type VenueId } from '../../ids.ts';
import { EpochMsSchema, FractionSchema, type EpochMs } from '../../primitives.ts';
import { TimeZoneSchema } from '../liveEvents/time.ts';
import { checkNotAfter } from './refine.ts';

/**
 * The city clock each venue keeps (00-VISION: each venue follows its city's local time). The
 * orbital casino keeps station time and has no sun to rise or set.
 */
export const VENUE_TIME_ZONES = {
  rivieraYacht: 'Europe/Monaco',
  salonDeParis: 'Europe/Paris',
  tokyoPenthouse: 'Asia/Tokyo',
  alpineChalet: 'Europe/Zurich',
  orbitalCasino: 'UTC',
} as const satisfies Record<VenueId, string>;

/** UTC offsets in the IANA data run from -12:00 to +14:00, always on a quarter hour. */
export const MIN_UTC_OFFSET_MINUTES = -12 * 60;
export const MAX_UTC_OFFSET_MINUTES = 14 * 60;
/** Wire bounds for a reported air temperature, wider than any city has recorded. */
export const MIN_TEMPERATURE_C = -90;
export const MAX_TEMPERATURE_C = 60;

/** What the sky layers draw: rain, mist and snow are particle layers, storm adds lightning. */
export const WEATHER_KINDS = ['clear', 'cloudy', 'rain', 'storm', 'mist', 'snow'] as const;
export const WeatherKindSchema = z.enum(WEATHER_KINDS);
export type WeatherKind = z.infer<typeof WeatherKindSchema>;

/** `feed`: the server's cached weather feed. `fallback`: the feed was unavailable, so clear sky. */
export const WEATHER_SOURCES = ['feed', 'fallback'] as const;
export const WeatherSourceSchema = z.enum(WEATHER_SOURCES);
export type WeatherSource = z.infer<typeof WeatherSourceSchema>;

/**
 * The weather over a venue's city. `intensity` drives the particle layer (0 for a clear sky) and
 * `cloudCover` the sky dome. It is cosmetic only: no economy number ever reads it.
 */
export const WeatherSchema = z
  .object({
    kind: WeatherKindSchema,
    intensity: FractionSchema,
    cloudCover: FractionSchema,
    temperatureC: z.int().min(MIN_TEMPERATURE_C).max(MAX_TEMPERATURE_C).nullable(),
  })
  .refine((weather) => (weather.kind === 'clear') === (weather.intensity === 0), {
    path: ['intensity'],
    message: 'A clear sky has no intensity, and every other sky has some.',
  });
export type Weather = z.infer<typeof WeatherSchema>;

/** The clear sky a venue shows when the feed has nothing for it. */
export const CLEAR_SKY = {
  kind: 'clear',
  intensity: 0,
  cloudCover: 0,
  temperatureC: null,
} as const satisfies z.input<typeof WeatherSchema>;

/** Sunrise and sunset of the venue's local day, which the sky and key light follow (T-14.11). */
export const SunSchema = z
  .object({ riseAt: EpochMsSchema, setAt: EpochMsSchema })
  .refine((sun) => sun.setAt > sun.riseAt, {
    path: ['setAt'],
    message: 'The sun sets after it rises.',
  });
export type Sun = z.infer<typeof SunSchema>;

/**
 * One venue's conditions as the server's cron last cached them. `utcOffsetMinutes` is the venue's
 * offset at the answer's server time, so the client reads the local time without trusting its own
 * clock or zone data. `sun` is `null` where the venue has no sun cycle. `observedAt` is when the
 * feed observed the weather, `null` on the clear-sky fallback.
 */
export const VenueConditionsSchema = z
  .object({
    venue: VenueIdSchema,
    timeZone: TimeZoneSchema,
    utcOffsetMinutes: z
      .int()
      .min(MIN_UTC_OFFSET_MINUTES)
      .max(MAX_UTC_OFFSET_MINUTES)
      .multipleOf(15),
    sun: SunSchema.nullable(),
    weather: WeatherSchema,
    source: WeatherSourceSchema,
    observedAt: EpochMsSchema.nullable(),
  })
  .superRefine((conditions, ctx) => {
    const issue = (path: string, message: string) => {
      ctx.addIssue({ code: 'custom', path: [path], message });
    };
    const zone = VENUE_TIME_ZONES[conditions.venue];
    if (conditions.timeZone !== zone) {
      issue('timeZone', `${conditions.venue} keeps ${zone} time.`);
    }
    if (zone === 'UTC') {
      if (conditions.utcOffsetMinutes !== 0) issue('utcOffsetMinutes', 'Station time is UTC.');
      if (conditions.sun !== null) issue('sun', `${conditions.venue} has no sun to rise or set.`);
    } else if (conditions.sun === null) {
      issue('sun', `${conditions.venue} follows the sun over ${zone}.`);
    }
    if ((conditions.source === 'feed') !== (conditions.observedAt !== null)) {
      issue('observedAt', 'Feed weather has an observation time and the fallback has none.');
    }
    if (
      conditions.source === 'fallback' &&
      JSON.stringify(conditions.weather) !== JSON.stringify(CLEAR_SKY)
    ) {
      issue('weather', 'The fallback is a clear sky.');
    }
  });
export type VenueConditions = z.infer<typeof VenueConditionsSchema>;

/** The offset from UTC, in minutes, that `timeZone` keeps at the instant `at`. */
export function utcOffsetMinutesAt(timeZone: string, at: EpochMs): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(at)
    .find((part) => part.type === 'timeZoneName')?.value;
  const match = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(name ?? '');
  if (match === null) throw new Error(`Cannot read the UTC offset of ${timeZone} from "${name}".`);
  if (match[1] === undefined) return 0;
  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
}

/**
 * Every venue's local time and weather, in unlock order. The request carries nothing, so no
 * player location is ever sent; `refreshAt` is when the server's cron next refreshes the feed.
 */
export const ConditionsResponseSchema = z
  .object({
    serverTime: EpochMsSchema,
    refreshAt: EpochMsSchema,
    venues: z.array(VenueConditionsSchema).length(VENUE_IDS.length),
  })
  .superRefine((answer, ctx) => {
    if (answer.refreshAt <= answer.serverTime) {
      ctx.addIssue({
        code: 'custom',
        path: ['refreshAt'],
        message: 'The next refresh is after the server time.',
      });
    }
    answer.venues.forEach((conditions, i) => {
      if (conditions.venue !== VENUE_IDS[i]) {
        ctx.addIssue({
          code: 'custom',
          path: ['venues', i, 'venue'],
          message: `Venues are listed once each, as ${VENUE_IDS.join(', ')}.`,
        });
      }
      const offset = utcOffsetMinutesAt(conditions.timeZone, answer.serverTime);
      if (conditions.utcOffsetMinutes !== offset) {
        ctx.addIssue({
          code: 'custom',
          path: ['venues', i, 'utcOffsetMinutes'],
          message: `${conditions.timeZone} is ${offset} minutes from UTC at the server time.`,
        });
      }
      checkNotAfter(
        conditions.observedAt,
        answer.serverTime,
        ctx,
        ['venues', i, 'observedAt'],
        'Weather is observed before it is served.',
      );
    });
  });
export type ConditionsResponse = z.infer<typeof ConditionsResponseSchema>;
