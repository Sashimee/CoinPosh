import { describe, expect, it } from 'vitest';
import { COIN_TIERS } from '../../domain.ts';
import { roundTrip } from '../../test/roundTrip.ts';
import { standingFixtures } from './fixtures.ts';
import {
  MasteryLevelUpSchema,
  MasteryProgressSchema,
  MasteryResponseSchema,
  MasteryTrackSchema,
  masteryTrackKey,
} from './mastery.ts';

const tracks = standingFixtures.standingMastery.response.tracks;
const [copper, heirloom, butler] = tracks;
const issuePaths = (result: { error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => issue.path);

describe('MasteryTrackSchema', () => {
  it.each(COIN_TIERS)('round-trips the %s coin track', (tier) => {
    const { parsed, reparsed } = roundTrip(MasteryTrackSchema, { kind: 'coinTier', tier });
    expect(reparsed).toEqual(parsed);
  });

  it('round-trips a charm track keyed by catalog id, editions included', () => {
    for (const charm of ['butler', 'captainsBellCharm']) {
      const { parsed, reparsed } = roundTrip(MasteryTrackSchema, { kind: 'charm', charm });
      expect(reparsed).toEqual(parsed);
    }
  });

  it.each([
    ['an unknown tier', { kind: 'coinTier', tier: 'bronze' }],
    ['a charm name with spaces', { kind: 'charm', charm: 'The Butler' }],
    ['an unknown kind', { kind: 'venue', venue: 'rivieraYacht' }],
  ])('rejects %s', (_label, track) => {
    expect(MasteryTrackSchema.safeParse(track).success).toBe(false);
  });

  it('keys coin and charm tracks apart even when the names match', () => {
    expect(masteryTrackKey({ kind: 'coinTier', tier: 'gold' })).toBe('coinTier:gold');
    expect(masteryTrackKey(MasteryTrackSchema.parse({ kind: 'charm', charm: 'gold' }))).toBe(
      'charm:gold',
    );
  });
});

describe('MasteryProgressSchema', () => {
  it.each(tracks.map((track) => [masteryTrackKey(MasteryTrackSchema.parse(track.track)), track]))(
    'round-trips %s',
    (_key, track) => {
      const { parsed, reparsed } = roundTrip(MasteryProgressSchema, track);
      expect(reparsed).toEqual(parsed);
    },
  );

  it.each([
    ['a level past the maximum', butler, { level: 11 }, ['level']],
    ['a mastered track with a next level', butler, { pointsToNext: 1_000 }, ['pointsToNext']],
    ['an open track with no next level', copper, { pointsToNext: null }, ['pointsToNext']],
    ['a full level bar', copper, { pointsIntoLevel: 800 }, ['pointsIntoLevel']],
    ['more points into the level than ever earned', copper, { points: 100 }, ['pointsIntoLevel']],
    ['a bonus before the first level', heirloom, { bonusBp: 100 }, ['bonusBp']],
  ] as const)('rejects %s', (_label, track, change, path) => {
    expect(issuePaths(MasteryProgressSchema.safeParse({ ...track, ...change }))).toEqual([path]);
  });
});

describe('MasteryResponseSchema', () => {
  it('round-trips every track, and none at all for a new player', () => {
    for (const body of [standingFixtures.standingMastery.response, { tracks: [] }]) {
      const { parsed, reparsed } = roundTrip(MasteryResponseSchema, body);
      expect(reparsed).toEqual(parsed);
    }
  });

  it('rejects a track listed twice', () => {
    const twice = MasteryResponseSchema.safeParse({ tracks: [copper, butler, copper] });
    expect(issuePaths(twice)).toEqual([['tracks', 2, 'track']]);
  });
});

describe('MasteryLevelUpSchema', () => {
  it('round-trips a level-up and refuses level 0', () => {
    const levelUp = { track: { kind: 'coinTier', tier: 'gold' }, level: 3, bonusBp: 300 };
    const { parsed, reparsed } = roundTrip(MasteryLevelUpSchema, levelUp);
    expect(reparsed).toEqual(parsed);
    expect(MasteryLevelUpSchema.safeParse({ ...levelUp, level: 0 }).success).toBe(false);
  });
});
