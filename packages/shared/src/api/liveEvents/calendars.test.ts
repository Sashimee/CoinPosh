import { describe, expect, it } from 'vitest';
import { roundTrip } from '../../test/roundTrip.ts';
import {
  CALENDAR_TRACK_LENGTHS,
  CALENDAR_TRACKS,
  CalendarClaimRequestSchema,
  CalendarClaimResponseSchema,
  CalendarResponseSchema,
  CalendarSlotSchema,
  CalendarTrackStateSchema,
} from './calendars.ts';
import { liveEventsFixtures, liveProof, liveTracks } from './fixtures.ts';

const calendar = liveEventsFixtures.liveEventsCalendar.response;
const claim = liveEventsFixtures.liveEventsCalendarClaim.response;
const issuePaths = (result: { error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => issue.path);

describe('calendar tracks', () => {
  it('runs a 7-day and a 28-day calendar, as 00-VISION sets them', () => {
    expect(CALENDAR_TRACKS).toEqual(['week', 'month']);
    expect(CALENDAR_TRACK_LENGTHS).toEqual({ week: 7, month: 28 });
  });

  it.each(Object.values(liveTracks))('round-trips the $track track', (track) => {
    const { parsed, reparsed } = roundTrip(CalendarTrackStateSchema, track);
    expect(reparsed).toEqual(parsed);
  });

  it.each([
    ['a fresh track', { cycle: 1, nextDay: 1, claims: 0 }],
    ['the last day of the first week', { cycle: 1, nextDay: 7, claims: 6 }],
    ['the first day of the third week', { cycle: 3, nextDay: 1, claims: 14 }],
  ])('accepts %s', (_label, position) => {
    expect(CalendarTrackStateSchema.safeParse({ ...liveTracks.week, ...position }).success).toBe(
      true,
    );
  });

  it.each([
    ['a day past the end', { nextDay: 8, claims: 13 }, ['nextDay']],
    ['claims a missed day reset', { nextDay: 1, claims: 11 }, ['claims']],
    ['claims that skip ahead', { nextDay: 5, claims: 12 }, ['claims']],
    ['a slot missing', { slots: liveTracks.week.slots.slice(0, 6) }, ['slots']],
    [
      'slots out of order',
      {
        slots: [
          liveTracks.week.slots[1],
          liveTracks.week.slots[0],
          ...liveTracks.week.slots.slice(2),
        ],
      },
      ['slots', 0, 'day'],
    ],
  ])('refuses %s', (_label, change, path) => {
    const result = CalendarTrackStateSchema.safeParse({ ...liveTracks.week, ...change });
    expect(issuePaths(result)).toContainEqual(path);
  });

  it('refuses a cycle 0 or a day 0', () => {
    for (const change of [{ cycle: 0 }, { nextDay: 0 }]) {
      expect(CalendarTrackStateSchema.safeParse({ ...liveTracks.week, ...change }).success).toBe(
        false,
      );
    }
  });

  it('lets a slot roll once, beside fixed rewards', () => {
    const roll = liveTracks.week.slots[6]?.rewards[1];
    expect(roll?.kind).toBe('roll');
    expect(CalendarSlotSchema.safeParse({ day: 7, rewards: [roll] }).success).toBe(true);
    expect(CalendarSlotSchema.safeParse({ day: 7, rewards: [roll, roll] }).success).toBe(false);
    expect(CalendarSlotSchema.safeParse({ day: 7, rewards: [] }).success).toBe(false);
  });
});

describe('CalendarResponseSchema', () => {
  it('round-trips the fixture', () => {
    const { parsed, reparsed } = roundTrip(CalendarResponseSchema, calendar);
    expect(reparsed).toEqual(parsed);
  });

  it('accepts a player who has never claimed', () => {
    const fresh = {
      ...calendar,
      lastClaimDay: null,
      tracks: [
        { ...liveTracks.week, cycle: 1, nextDay: 1, claims: 0 },
        { ...liveTracks.month, nextDay: 1, claims: 0 },
      ],
    };
    expect(CalendarResponseSchema.safeParse(fresh).success).toBe(true);
  });

  it('closes the day once it is claimed', () => {
    const claimed = { ...calendar, lastClaimDay: calendar.clock.day, claimable: false };
    expect(CalendarResponseSchema.safeParse(claimed).success).toBe(true);
    expect(issuePaths(CalendarResponseSchema.safeParse({ ...claimed, claimable: true }))).toEqual([
      ['claimable'],
    ]);
    expect(issuePaths(CalendarResponseSchema.safeParse({ ...calendar, claimable: false }))).toEqual(
      [['claimable']],
    );
  });

  it.each([
    ['a claim dated tomorrow', { lastClaimDay: '2026-11-16', claimable: true }, ['lastClaimDay']],
    ['claims without a claim day', { lastClaimDay: null }, ['lastClaimDay']],
    ['a server time outside the day', { serverTime: calendar.clock.nextDayAt }, ['clock']],
    [
      'tracks swapped',
      { tracks: [calendar.tracks[1], calendar.tracks[0]] },
      ['tracks', 0, 'track'],
    ],
    [
      'tracks that disagree on claims',
      { tracks: [calendar.tracks[0], { ...liveTracks.month, nextDay: 13, claims: 12 }] },
      ['tracks'],
    ],
  ])('refuses %s', (_label, change, path) => {
    expect(issuePaths(CalendarResponseSchema.safeParse({ ...calendar, ...change }))).toContainEqual(
      path,
    );
  });

  it('refuses one track alone', () => {
    expect(
      CalendarResponseSchema.safeParse({ ...calendar, tracks: [calendar.tracks[0]] }).success,
    ).toBe(false);
  });
});

describe('calendar claim', () => {
  it('takes no body fields, so the client cannot pick the day or forge a clock', () => {
    expect(CalendarClaimRequestSchema.safeParse({}).success).toBe(true);
    for (const forged of [{ day: '2026-11-16' }, { claimedAt: 0 }, { track: 'week' }]) {
      expect(CalendarClaimRequestSchema.safeParse(forged).success).toBe(false);
    }
  });

  it('round-trips the fixture', () => {
    const { parsed, reparsed } = roundTrip(CalendarClaimResponseSchema, claim);
    expect(reparsed).toEqual(parsed);
  });

  it('pays the last slot of a cycle as the track wraps to day 1', () => {
    const wrap = {
      ...claim,
      payouts: [
        {
          track: 'week',
          day: 7,
          granted: [{ kind: 'crate', crateId: 'crate_7Hq2LmX9pA', rarity: 'rare' }],
          proof: liveProof,
        },
        {
          track: 'month',
          day: 14,
          granted: [{ kind: 'crate', crateId: 'crate_Lm4Np8Qr2s', rarity: 'exquisite' }],
          proof: null,
        },
      ],
      tracks: [
        { ...liveTracks.week, cycle: 3, nextDay: 1, claims: 14 },
        { ...liveTracks.month, nextDay: 15, claims: 14 },
      ],
    };
    expect(CalendarClaimResponseSchema.safeParse(wrap).error).toBeUndefined();
    const unproven = { ...wrap, payouts: [{ ...wrap.payouts[0], proof: null }, wrap.payouts[1]] };
    expect(issuePaths(CalendarClaimResponseSchema.safeParse(unproven))).toEqual([
      ['payouts', 0, 'proof'],
    ]);
  });

  it.each([
    [
      'a payout for the wrong day',
      { payouts: [{ ...claim.payouts[0], day: 6 }, claim.payouts[1]] },
      ['payouts', 0, 'day'],
    ],
    [
      'a proof on a fixed slot',
      { payouts: [{ ...claim.payouts[0], proof: liveProof }, claim.payouts[1]] },
      ['payouts', 0, 'proof'],
    ],
    [
      'one track paid twice',
      { payouts: [claim.payouts[0], claim.payouts[0]] },
      ['payouts', 1, 'track'],
    ],
    ['the next day opening before the claim', { nextDayAt: claim.claimedAt }, ['nextDayAt']],
  ])('refuses %s', (_label, change, path) => {
    expect(
      issuePaths(CalendarClaimResponseSchema.safeParse({ ...claim, ...change })),
    ).toContainEqual(path);
  });

  it('refuses a payout that grants nothing', () => {
    const empty = { ...claim, payouts: [{ ...claim.payouts[0], granted: [] }, claim.payouts[1]] };
    expect(CalendarClaimResponseSchema.safeParse(empty).success).toBe(false);
  });
});
