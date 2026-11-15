import { describe, expect, it } from 'vitest';
import { VENUE_IDS } from '../../ids.ts';
import { roundTrip } from '../../test/roundTrip.ts';
import {
  CLEAR_SKY,
  ConditionsResponseSchema,
  SunSchema,
  VENUE_TIME_ZONES,
  VenueConditionsSchema,
  WEATHER_KINDS,
  WeatherSchema,
} from './conditions.ts';
import { worldFixtures, worldNow, worldVenueConditions } from './fixtures.ts';

const answer = worldFixtures.worldConditions.response;
const [riviera, paris, , alpine, orbital] = worldVenueConditions;
const issuePaths = (result: { error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => issue.path);

describe('venue clocks', () => {
  it('gives every venue a city clock the runtime knows', () => {
    expect(Object.keys(VENUE_TIME_ZONES)).toEqual([...VENUE_IDS]);
    for (const zone of Object.values(VENUE_TIME_ZONES)) {
      expect(() => new Intl.DateTimeFormat('en-US', { timeZone: zone })).not.toThrow();
    }
  });

  it('reports offsets that match each city at the fixture time', () => {
    for (const conditions of worldVenueConditions) {
      const name = new Intl.DateTimeFormat('en-US', {
        timeZone: conditions.timeZone,
        timeZoneName: 'longOffset',
      })
        .formatToParts(worldNow)
        .find((part) => part.type === 'timeZoneName')?.value;
      const match = /GMT(?:([+-])(\d{2}):(\d{2}))?/.exec(name ?? '');
      const sign = match?.[1] === '-' ? -1 : 1;
      const offset =
        match?.[1] === undefined ? 0 : sign * (Number(match[2]) * 60 + Number(match[3]));
      expect(offset, conditions.venue).toBe(conditions.utcOffsetMinutes);
    }
  });
});

describe('WeatherSchema', () => {
  it('draws rain, mist and snow among its skies', () => {
    expect(WEATHER_KINDS).toEqual(expect.arrayContaining(['clear', 'rain', 'mist', 'snow']));
  });

  it.each(worldVenueConditions.map((conditions) => conditions.weather))(
    'round-trips a $kind sky',
    (weather) => {
      const { parsed, reparsed } = roundTrip(WeatherSchema, weather);
      expect(reparsed).toEqual(parsed);
    },
  );

  it.each([
    ['a clear sky with rain falling', { ...CLEAR_SKY, intensity: 0.3 }],
    ['rain with no intensity', { kind: 'rain', intensity: 0, cloudCover: 1, temperatureC: 8 }],
    ['an intensity past 1', { kind: 'snow', intensity: 1.5, cloudCover: 1, temperatureC: -4 }],
    [
      'an implausible temperature',
      { kind: 'cloudy', intensity: 0.2, cloudCover: 0.5, temperatureC: 75 },
    ],
    ['an unknown sky', { kind: 'hail', intensity: 0.5, cloudCover: 1, temperatureC: 2 }],
  ])('refuses %s', (_label, weather) => {
    expect(WeatherSchema.safeParse(weather).success).toBe(false);
  });

  it('refuses a sun that sets before it rises', () => {
    expect(SunSchema.safeParse({ riseAt: worldNow, setAt: worldNow }).success).toBe(false);
  });
});

describe('VenueConditionsSchema', () => {
  it.each(worldVenueConditions)('round-trips $venue', (conditions) => {
    const { parsed, reparsed } = roundTrip(VenueConditionsSchema, conditions);
    expect(reparsed).toEqual(parsed);
  });

  it('falls back to a clear sky with no observation', () => {
    expect(VenueConditionsSchema.parse(orbital).weather).toEqual(CLEAR_SKY);
  });

  it.each([
    ['a venue on another city clock', riviera, { timeZone: 'Europe/Paris' }, ['timeZone']],
    ['feed weather with no observation', paris, { observedAt: null }, ['observedAt']],
    ['a fallback with an observation', orbital, { observedAt: worldNow }, ['observedAt']],
    [
      'a fallback that is not clear',
      { ...alpine, source: 'fallback', observedAt: null },
      {},
      ['weather'],
    ],
  ])('refuses %s', (_label, conditions, change, path) => {
    expect(
      issuePaths(VenueConditionsSchema.safeParse({ ...conditions, ...change })),
    ).toContainEqual(path);
  });

  it.each([
    ['an offset off the quarter hour', { utcOffsetMinutes: 61 }],
    ['an offset past +14:00', { utcOffsetMinutes: 15 * 60 }],
    ['an unknown venue', { venue: 'moonBase' }],
    ['a fixed-offset zone', { timeZone: '+01:00' }],
  ])('refuses %s', (_label, change) => {
    expect(VenueConditionsSchema.safeParse({ ...riviera, ...change }).success).toBe(false);
  });
});

describe('ConditionsResponseSchema', () => {
  it('round-trips the fixture, every venue in unlock order', () => {
    const { parsed, reparsed } = roundTrip(ConditionsResponseSchema, answer);
    expect(reparsed).toEqual(parsed);
    expect(parsed.venues.map((conditions) => conditions.venue)).toEqual([...VENUE_IDS]);
  });

  it('serves every venue the clear-sky fallback when the feed is down', () => {
    const down = {
      ...answer,
      venues: answer.venues.map((conditions) => ({
        ...conditions,
        weather: CLEAR_SKY,
        source: 'fallback',
        observedAt: null,
      })),
    };
    expect(ConditionsResponseSchema.safeParse(down).error).toBeUndefined();
  });

  it.each([
    ['a refresh already due', { refreshAt: worldNow }, ['refreshAt']],
    [
      'venues out of order',
      { venues: [paris, riviera, ...answer.venues.slice(2)] },
      ['venues', 0, 'venue'],
    ],
    [
      'an observation after the server time',
      { serverTime: worldNow - 11 * 60_000, refreshAt: worldNow },
      ['venues', 0, 'observedAt'],
    ],
  ])('refuses %s', (_label, change, path) => {
    expect(issuePaths(ConditionsResponseSchema.safeParse({ ...answer, ...change }))).toContainEqual(
      path,
    );
  });

  it('refuses an answer missing a venue', () => {
    expect(
      ConditionsResponseSchema.safeParse({ ...answer, venues: answer.venues.slice(1) }).success,
    ).toBe(false);
  });
});
