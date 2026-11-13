import { describe, expect, it } from 'vitest';
import { endpointFixtures } from '../test/fixtures.ts';
import { roundTrip } from '../test/roundTrip.ts';
import { StateResponseSchema, VenueStateSchema } from './state.ts';

const base = endpointFixtures.state.response;
const ascending = {
  ...base,
  venue: { ...base.venue, lifetimeBullion: 1_840 },
  familyOffice: { 'pusher-speed': 2, 'coin-value': 0 },
};

describe('VenueStateSchema.lifetimeBullion', () => {
  it('round-trips Bullion earned since the last ascension', () => {
    const { parsed, reparsed } = roundTrip(VenueStateSchema, ascending.venue);
    expect(parsed.lifetimeBullion).toBe(1_840);
    expect(reparsed).toEqual(parsed);
  });

  it('accepts zero, right after an ascension', () => {
    const venue = { ...base.venue, lifetimeBullion: 0 };
    expect(VenueStateSchema.parse(venue).lifetimeBullion).toBe(0);
  });

  it('stays optional while the server and Demo mock catch up', () => {
    const { parsed, reparsed } = roundTrip(VenueStateSchema, base.venue);
    expect('lifetimeBullion' in parsed).toBe(false);
    expect(reparsed).toEqual(parsed);
  });

  it.each([
    ['negative', -1],
    ['fractional', 2.5],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1],
    ['string', '1840'],
    ['null', null],
  ])('rejects a %s figure', (_label, lifetimeBullion) => {
    const venue = { ...base.venue, lifetimeBullion };
    expect(VenueStateSchema.safeParse(venue).success).toBe(false);
  });

  it('keeps the current venue and the unlocked list as they were', () => {
    const parsed = VenueStateSchema.parse(ascending.venue);
    expect(parsed.id).toBe(base.venue.id);
    expect(parsed.unlocked).toEqual(base.venue.unlocked);
  });
});

describe('StateResponseSchema.familyOffice', () => {
  it('round-trips global Family Office levels alongside lifetimeBullion', () => {
    const { parsed, reparsed } = roundTrip(StateResponseSchema, ascending);
    expect(parsed.familyOffice).toEqual({ 'pusher-speed': 2, 'coin-value': 0 });
    expect(parsed.venue.lifetimeBullion).toBe(1_840);
    expect(reparsed).toEqual(parsed);
  });

  it('accepts an empty Family Office for a player who has never ascended', () => {
    expect(StateResponseSchema.parse({ ...base, familyOffice: {} }).familyOffice).toEqual({});
  });

  it('stays optional while the server and Demo mock catch up', () => {
    const { parsed, reparsed } = roundTrip(StateResponseSchema, base);
    expect('familyOffice' in parsed).toBe(false);
    expect(reparsed).toEqual(parsed);
  });

  it.each([
    ['a negative level', { 'pusher-speed': -1 }],
    ['a fractional level', { 'pusher-speed': 1.5 }],
    ['a malformed line id', { 'Pusher Speed!': 1 }],
    ['an array', [1, 2]],
    ['null', null],
  ])('rejects %s', (_label, familyOffice) => {
    expect(StateResponseSchema.safeParse({ ...base, familyOffice }).success).toBe(false);
  });

  it('rejects a negative lifetimeBullion nested in the response', () => {
    const state = { ...ascending, venue: { ...ascending.venue, lifetimeBullion: -5 } };
    expect(StateResponseSchema.safeParse(state).success).toBe(false);
  });
});

describe('extra keys', () => {
  it('strips unknown keys beside both new fields instead of passing them through', () => {
    const parsed = StateResponseSchema.parse({
      ...ascending,
      venue: { ...ascending.venue, bullionMultiplier: 9 },
      goldBarsPending: 99,
    });
    expect(parsed.venue).not.toHaveProperty('bullionMultiplier');
    expect(parsed).not.toHaveProperty('goldBarsPending');
    expect(parsed.venue.lifetimeBullion).toBe(1_840);
    expect(parsed.familyOffice).toEqual(ascending.familyOffice);
  });
});
