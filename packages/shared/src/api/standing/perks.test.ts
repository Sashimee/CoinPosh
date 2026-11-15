import { describe, expect, it } from 'vitest';
import { roundTrip } from '../../test/roundTrip.ts';
import { standingFixtures, standingPerks, standingProgress } from './fixtures.ts';
import {
  isPerkUnlocked,
  PerkRoadSchema,
  PerkSchema,
  RankUpSchema,
  RanksResponseSchema,
} from './perks.ts';

const [crest, autoDrop, offlineCap, throne] = standingPerks;
const issuePaths = (result: { error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => issue.path);

describe('PerkSchema', () => {
  it.each(standingPerks.map((perk) => [perk.effect.kind, perk] as const))(
    'round-trips a %s perk',
    (_kind, perk) => {
      const { parsed, reparsed } = roundTrip(PerkSchema, perk);
      expect(reparsed).toEqual(parsed);
    },
  );

  it('round-trips a boost perk in basis points', () => {
    const boost = {
      id: 'duke3-offlineRate',
      rank: { title: 'duke', grade: 3 },
      effect: { kind: 'boost', stat: 'offlineRate', bp: 500 },
    };
    const { parsed, reparsed } = roundTrip(PerkSchema, boost);
    expect(reparsed).toEqual(parsed);
  });

  it.each([
    ['an unknown effect', { ...crest, effect: { kind: 'teleport' } }],
    ['a boost of nothing', { ...crest, effect: { kind: 'boost', stat: 'offlineRate', bp: 0 } }],
    [
      'an offline cap that adds no time',
      { ...offlineCap, effect: { kind: 'offlineCap', durationMs: 0 } },
    ],
    [
      'a feature that is not a config key',
      { ...autoDrop, effect: { kind: 'unlock', feature: 'Auto Drop' } },
    ],
    ['a rank that does not exist', { ...crest, rank: { title: 'baron', grade: 6 } }],
  ])('rejects %s', (_label, perk) => {
    expect(PerkSchema.safeParse(perk).success).toBe(false);
  });

  it('is unlocked from its own rank upward', () => {
    const perk = PerkSchema.parse(autoDrop);
    expect(isPerkUnlocked(perk, { title: 'commoner', grade: 5 })).toBe(false);
    expect(isPerkUnlocked(perk, { title: 'baron', grade: 1 })).toBe(true);
    expect(isPerkUnlocked(perk, { title: 'monarch', stars: 9 })).toBe(true);
  });
});

describe('PerkRoadSchema', () => {
  it('accepts an empty road and perks sharing a rank', () => {
    expect(PerkRoadSchema.safeParse([]).success).toBe(true);
    expect(PerkRoadSchema.safeParse([crest, autoDrop]).success).toBe(true);
  });

  it('rejects a perk listed twice', () => {
    expect(issuePaths(PerkRoadSchema.safeParse([crest, crest]))).toEqual([[1, 'id']]);
  });

  it('rejects a road out of rank order', () => {
    expect(issuePaths(PerkRoadSchema.safeParse([throne, crest]))).toEqual([[1, 'rank']]);
  });
});

describe('RanksResponseSchema', () => {
  it('round-trips the HUD crest, the bar and the rank road', () => {
    const { parsed, reparsed } = roundTrip(
      RanksResponseSchema,
      standingFixtures.standingRanks.response,
    );
    expect(reparsed).toEqual(parsed);
    expect(parsed.progress).toEqual(standingProgress);
  });
});

describe('RankUpSchema', () => {
  it('round-trips a rank-up carrying the perks it unlocked', () => {
    const rankUp = { rank: { title: 'baron', grade: 1 }, perks: [crest, autoDrop] };
    const { parsed, reparsed } = roundTrip(RankUpSchema, rankUp);
    expect(reparsed).toEqual(parsed);
  });

  it('accepts a rank-up with no perk on it', () => {
    expect(RankUpSchema.safeParse({ rank: { title: 'baron', grade: 2 }, perks: [] }).success).toBe(
      true,
    );
  });

  it('rejects a perk from another rank', () => {
    const wrong = { rank: { title: 'baron', grade: 1 }, perks: [crest, offlineCap] };
    expect(issuePaths(RankUpSchema.safeParse(wrong))).toEqual([['perks', 1, 'rank']]);
  });
});
