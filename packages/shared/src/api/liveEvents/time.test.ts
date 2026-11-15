import { describe, expect, it } from 'vitest';
import { roundTrip } from '../../test/roundTrip.ts';
import { liveClock, liveEventsFixtures, liveNow } from './fixtures.ts';
import {
  DAY_MS,
  DayKeySchema,
  isoWeekOf,
  isoWeekStart,
  localDayOf,
  MAX_LOCAL_DAY_MS,
  MIN_LOCAL_DAY_MS,
  PlayerClockSchema,
  TIME_ZONE_MAX_LENGTH,
  TimeZoneSchema,
  TimeZoneSetRequestSchema,
  TimeZoneSetResponseSchema,
  utcDayOf,
  utcDayStart,
  WeekKeySchema,
} from './time.ts';

const zone = (name: string) => TimeZoneSchema.parse(name);
const issuePaths = (result: { error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => issue.path);

describe('TimeZoneSchema', () => {
  it.each([
    'UTC',
    'Europe/Paris',
    'America/New_York',
    'America/Argentina/Buenos_Aires',
    'America/Port-au-Prince',
    'Asia/Kolkata',
    'Asia/Calcutta',
    'Pacific/Chatham',
    'Etc/GMT+5',
  ])('accepts the IANA zone %s and round-trips it unchanged', (name) => {
    const { parsed, reparsed } = roundTrip(TimeZoneSchema, name);
    expect(parsed).toBe(name);
    expect(reparsed).toBe(name);
  });

  it.each([
    ['a fixed offset', '+01:00'],
    ['an offset name', 'GMT+1'],
    ['a legacy alias', 'US/Eastern'],
    ['an abbreviation', 'CET'],
    ['lowercase', 'europe/paris'],
    ['a miscased city', 'Europe/PARIS'],
    ['an unknown city', 'Europe/Atlantis'],
    ['a bare area', 'Europe'],
    ['a path trick', 'Europe/../Paris'],
    ['empty', ''],
    ['too long', `Europe/${'A'.repeat(TIME_ZONE_MAX_LENGTH)}`],
  ])('refuses %s', (_label, name) => {
    expect(TimeZoneSchema.safeParse(name).success).toBe(false);
  });

  it('tells the client the right spelling of a miscased zone', () => {
    const message = TimeZoneSchema.safeParse('Europe/PARIS').error?.issues[0]?.message;
    expect(message).toContain('Europe/Paris');
  });
});

describe('DayKeySchema', () => {
  it.each(['2026-11-15', '2028-02-29', '2026-12-31', '1970-01-01'])('accepts %s', (day) => {
    expect(DayKeySchema.safeParse(day).success).toBe(true);
  });

  it.each(['2026-02-29', '2026-13-01', '2026-00-10', '2026-04-31', '2026-11-5', '15/11/2026'])(
    'refuses %s',
    (day) => {
      expect(DayKeySchema.safeParse(day).success).toBe(false);
    },
  );

  it('orders as text the way the days order in time', () => {
    expect(DayKeySchema.parse('2026-11-09') < DayKeySchema.parse('2026-11-10')).toBe(true);
  });
});

describe('WeekKeySchema', () => {
  it.each(['2026-W01', '2026-W46', '2026-W53', '2020-W53'])('accepts %s', (week) => {
    expect(WeekKeySchema.safeParse(week).success).toBe(true);
  });

  it.each(['2025-W53', '2026-W00', '2026-W54', '2026-W7', '2026W46'])('refuses %s', (week) => {
    expect(WeekKeySchema.safeParse(week).success).toBe(false);
  });
});

describe('day and week helpers', () => {
  it('keys the UTC day and finds its midnight', () => {
    const day = utcDayOf(liveNow);
    expect(day).toBe('2026-11-15');
    expect(utcDayStart(day)).toBe(Date.UTC(2026, 10, 15));
    expect(utcDayOf(utcDayStart(day) - 1)).toBe('2026-11-14');
  });

  it('keys the local day by the player zone, not by UTC', () => {
    const lateEvening = Date.UTC(2026, 10, 15, 23, 30);
    expect(utcDayOf(lateEvening)).toBe('2026-11-15');
    expect(localDayOf(lateEvening, zone('Europe/Paris'))).toBe('2026-11-16');
    expect(localDayOf(lateEvening, zone('America/New_York'))).toBe('2026-11-15');
    expect(localDayOf(Date.UTC(2026, 10, 15, 3), zone('America/New_York'))).toBe('2026-11-14');
    expect(localDayOf(Date.UTC(2026, 10, 15, 11, 0), zone('Pacific/Chatham'))).toBe('2026-11-16');
  });

  it('agrees with the fixture clock at both edges of the Paris day', () => {
    const paris = zone(liveClock.timeZone);
    expect(localDayOf(liveClock.dayStartsAt, paris)).toBe(liveClock.day);
    expect(localDayOf(liveClock.nextDayAt - 1, paris)).toBe(liveClock.day);
    expect(localDayOf(liveClock.nextDayAt, paris)).toBe('2026-11-16');
  });

  it.each([
    [Date.UTC(2026, 10, 15, 9, 30), '2026-W46'],
    [Date.UTC(2026, 10, 9), '2026-W46'],
    [Date.UTC(2026, 10, 8, 23, 59), '2026-W45'],
    [Date.UTC(2027, 0, 1), '2026-W53'],
    [Date.UTC(2024, 11, 30), '2025-W01'],
    [Date.UTC(2021, 0, 3), '2020-W53'],
  ])('puts %i in ISO week %s', (at, week) => {
    expect(isoWeekOf(at)).toBe(week);
  });

  it('opens each ISO week on Monday midnight UTC, and that instant is in the week', () => {
    for (const week of ['2026-W01', '2026-W46', '2026-W53', '2025-W01', '2020-W53']) {
      const key = WeekKeySchema.parse(week);
      const start = isoWeekStart(key);
      expect(new Date(start).getUTCDay(), week).toBe(1);
      expect(start % DAY_MS, week).toBe(0);
      expect(isoWeekOf(start), week).toBe(week);
      expect(isoWeekOf(start - 1), week).not.toBe(week);
    }
  });
});

describe('PlayerClockSchema', () => {
  it('round-trips the fixture clock', () => {
    const { parsed, reparsed } = roundTrip(PlayerClockSchema, liveClock);
    expect(reparsed).toEqual(parsed);
  });

  it.each([MIN_LOCAL_DAY_MS, MAX_LOCAL_DAY_MS])('accepts a %i ms daylight-saving day', (length) => {
    const clock = { ...liveClock, nextDayAt: liveClock.dayStartsAt + length };
    expect(PlayerClockSchema.safeParse(clock).success).toBe(true);
  });

  it.each([MIN_LOCAL_DAY_MS - 1, MAX_LOCAL_DAY_MS + 1, 0])('refuses a %i ms day', (length) => {
    const clock = { ...liveClock, nextDayAt: liveClock.dayStartsAt + length };
    expect(issuePaths(PlayerClockSchema.safeParse(clock))).toEqual([['nextDayAt']]);
  });
});

describe('time zone change', () => {
  const answer = liveEventsFixtures.liveEventsTimeZone.response;

  it('takes the zone only, never a client timestamp', () => {
    expect(TimeZoneSetRequestSchema.safeParse({ timeZone: 'Asia/Tokyo' }).success).toBe(true);
    expect(
      TimeZoneSetRequestSchema.safeParse({ timeZone: 'Asia/Tokyo', changedAt: liveNow }).success,
    ).toBe(false);
    expect(TimeZoneSetRequestSchema.safeParse({ timeZone: '+09:00' }).success).toBe(false);
  });

  it('round-trips the answer', () => {
    const { parsed, reparsed } = roundTrip(TimeZoneSetResponseSchema, answer);
    expect(reparsed).toEqual(parsed);
  });

  it('starts the cooldown with the change', () => {
    for (const zoneChangeableAt of [null, answer.serverTime]) {
      const result = TimeZoneSetResponseSchema.safeParse({
        ...answer,
        clock: { ...answer.clock, zoneChangeableAt },
      });
      expect(issuePaths(result)).toEqual([['clock', 'zoneChangeableAt']]);
    }
  });

  it('reports the local day the server time is in', () => {
    const result = TimeZoneSetResponseSchema.safeParse({
      ...answer,
      serverTime: answer.clock.nextDayAt,
    });
    expect(issuePaths(result)).toEqual([['clock']]);
  });
});
