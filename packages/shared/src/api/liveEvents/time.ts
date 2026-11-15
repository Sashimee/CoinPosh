import { z } from 'zod';
import { EpochMsSchema, type EpochMs } from '../../primitives.ts';
import { checkClockAt } from './refine.ts';

export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;
/** A local day lasts 24 h, give or take the largest daylight-saving shift in the IANA data. */
export const MIN_LOCAL_DAY_MS = 23 * 3_600_000;
export const MAX_LOCAL_DAY_MS = 25 * 3_600_000;
export const TIME_ZONE_MAX_LENGTH = 64;

const IANA_ZONE =
  /^(?:UTC|(?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc)(?:\/[A-Za-z0-9_+-]+){1,2})$/;

function resolvedZone(timeZone: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/**
 * The player's IANA time zone, such as `Europe/Paris`, which the server uses for calendar day
 * boundaries. Fixed offsets (`+01:00`), legacy names (`US/Eastern`) and miscased names are
 * refused, so one zone has one spelling; links such as `Asia/Calcutta` stay valid because
 * runtimes canonicalise them differently.
 */
export const TimeZoneSchema = z
  .string()
  .max(TIME_ZONE_MAX_LENGTH)
  .regex(IANA_ZONE, 'Expected an IANA time zone such as "Europe/Paris" or "UTC".')
  .superRefine((timeZone, ctx) => {
    const resolved = resolvedZone(timeZone);
    if (resolved === null) {
      ctx.addIssue({
        code: 'custom',
        message: `"${timeZone}" is not a time zone this runtime knows; send an IANA name.`,
      });
    } else if (resolved !== timeZone && resolved.toLowerCase() === timeZone.toLowerCase()) {
      ctx.addIssue({ code: 'custom', message: `Spell the time zone "${resolved}".` });
    }
  })
  .brand<'TimeZone'>();
export type TimeZone = z.infer<typeof TimeZoneSchema>;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** A calendar day as `YYYY-MM-DD`, in UTC or in a player's zone depending on who keys it. */
export const DayKeySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a day as YYYY-MM-DD.')
  .refine((day) => {
    const [year, month, date] = day.split('-').map(Number) as [number, number, number];
    return month >= 1 && month <= 12 && date >= 1 && date <= daysInMonth(year, month);
  }, 'Expected a real calendar day.')
  .brand<'DayKey'>();
export type DayKey = z.infer<typeof DayKeySchema>;

function weeksInIsoYear(year: number): 52 | 53 {
  const jan1 = new Date(Date.UTC(year, 0, 1)).getUTCDay();
  const leap = daysInMonth(year, 2) === 29;
  return jan1 === 4 || (leap && jan1 === 3) ? 53 : 52;
}

/** An ISO 8601 week as `YYYY-Www`, always in UTC: the boss week is shared by every player. */
export const WeekKeySchema = z
  .string()
  .regex(/^\d{4}-W\d{2}$/, 'Expected an ISO week as YYYY-Www.')
  .refine((week) => {
    const year = Number(week.slice(0, 4));
    const number = Number(week.slice(6));
    return number >= 1 && number <= weeksInIsoYear(year);
  }, 'Expected a week that exists in its ISO year.')
  .brand<'WeekKey'>();
export type WeekKey = z.infer<typeof WeekKeySchema>;

const pad = (value: number, width: number) => String(value).padStart(width, '0');

/** The UTC day `at` falls in: the daily puzzle's day, the same for every player. */
export function utcDayOf(at: EpochMs): DayKey {
  const date = new Date(at);
  return DayKeySchema.parse(
    `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}`,
  );
}

/** Midnight UTC that opens `day`. */
export function utcDayStart(day: DayKey): EpochMs {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return Date.UTC(year, month - 1, date);
}

/** The day `at` falls in on the player's wall clock, for their login calendar. */
export function localDayOf(at: EpochMs, timeZone: TimeZone): DayKey {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const part = (type: 'year' | 'month' | 'day') => {
    const found = parts.find((p) => p.type === type);
    if (found === undefined) throw new Error(`localDayOf: Intl gave no ${type} for ${timeZone}.`);
    return found.value;
  };
  return DayKeySchema.parse(`${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`);
}

/** The ISO week `at` falls in, in UTC. */
export function isoWeekOf(at: EpochMs): WeekKey {
  const date = new Date(at);
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const weekday = (date.getUTCDay() + 6) % 7;
  const thursday = new Date(midnight + (3 - weekday) * DAY_MS);
  const year = thursday.getUTCFullYear();
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / WEEK_MS) + 1;
  return WeekKeySchema.parse(`${pad(year, 4)}-W${pad(week, 2)}`);
}

/** Monday 00:00 UTC that opens `week`. */
export function isoWeekStart(week: WeekKey): EpochMs {
  const year = Number(week.slice(0, 4));
  const number = Number(week.slice(6));
  const jan4 = Date.UTC(year, 0, 4);
  const jan4Weekday = (new Date(jan4).getUTCDay() + 6) % 7;
  return jan4 - jan4Weekday * DAY_MS + (number - 1) * WEEK_MS;
}

/**
 * Where the player's day stands, all stamped by the server. `day` is local to `timeZone`, opened
 * at `dayStartsAt`, and the next one opens at `nextDayAt`. `zoneChangeableAt` is when the zone
 * may next be changed, `null` when it may be changed now; the cooldown is economy config.
 */
export const PlayerClockSchema = z
  .object({
    timeZone: TimeZoneSchema,
    day: DayKeySchema,
    dayStartsAt: EpochMsSchema,
    nextDayAt: EpochMsSchema,
    zoneChangeableAt: EpochMsSchema.nullable(),
  })
  .superRefine((clock, ctx) => {
    const length = clock.nextDayAt - clock.dayStartsAt;
    if (length < MIN_LOCAL_DAY_MS || length > MAX_LOCAL_DAY_MS) {
      ctx.addIssue({
        code: 'custom',
        path: ['nextDayAt'],
        message: `A local day lasts 23 to 25 hours, not ${length} ms.`,
      });
    }
  });
export type PlayerClock = z.infer<typeof PlayerClockSchema>;

/** The new zone only: the server decides whether the cooldown allows it and stamps the change. */
export const TimeZoneSetRequestSchema = z.strictObject({
  timeZone: TimeZoneSchema,
});
export type TimeZoneSetRequest = z.infer<typeof TimeZoneSetRequestSchema>;

export const TimeZoneSetResponseSchema = z
  .object({
    serverTime: EpochMsSchema,
    clock: PlayerClockSchema,
  })
  .superRefine((answer, ctx) => {
    const { clock, serverTime } = answer;
    checkClockAt(clock, serverTime, ctx, ['clock']);
    if (clock.zoneChangeableAt === null || clock.zoneChangeableAt <= serverTime) {
      ctx.addIssue({
        code: 'custom',
        path: ['clock', 'zoneChangeableAt'],
        message: 'A zone just changed cannot change again until its cooldown ends.',
      });
    }
  });
export type TimeZoneSetResponse = z.infer<typeof TimeZoneSetResponseSchema>;
