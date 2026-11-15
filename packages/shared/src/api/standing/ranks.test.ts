import { describe, expect, it } from 'vitest';
import { roundTrip } from '../../test/roundTrip.ts';
import {
  compareRanks,
  FIRST_RANK,
  MONARCH_STEP,
  nextRank,
  RANK_ROAD,
  rankFromStep,
  rankKey,
  RankProgressSchema,
  RankSchema,
  rankStep,
  type Rank,
} from './ranks.ts';

const issuePaths = (result: { error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => issue.path);

describe('RankSchema', () => {
  it.each<Rank>([
    { title: 'commoner', grade: 1 },
    { title: 'baron', grade: 3 },
    { title: 'duke', grade: 5 },
    { title: 'monarch', stars: 0 },
    { title: 'monarch', stars: 27 },
  ])('round-trips $title', (rank) => {
    const { parsed, reparsed } = roundTrip(RankSchema, rank);
    expect(reparsed).toEqual(parsed);
  });

  it.each([
    ['grade 0', { title: 'baron', grade: 0 }],
    ['grade VI', { title: 'baron', grade: 6 }],
    ['a fractional grade', { title: 'duke', grade: 2.5 }],
    ['a graded Monarch', { title: 'monarch', grade: 1 }],
    ['negative stars', { title: 'monarch', stars: -1 }],
    ['stars on a Duke', { title: 'duke', stars: 3 }],
    ['an unknown title', { title: 'emperor', grade: 1 }],
  ])('rejects %s', (_label, rank) => {
    expect(RankSchema.safeParse(rank).success).toBe(false);
  });
});

describe('rank steps', () => {
  it('walks Commoner I to Duke V, then Monarch, then its stars', () => {
    expect(rankStep(FIRST_RANK)).toBe(0);
    expect(rankStep({ title: 'commoner', grade: 5 })).toBe(4);
    expect(rankStep({ title: 'baron', grade: 1 })).toBe(5);
    expect(rankStep({ title: 'duke', grade: 5 })).toBe(14);
    expect(rankStep({ title: 'monarch', stars: 0 })).toBe(MONARCH_STEP);
    expect(rankStep({ title: 'monarch', stars: 4 })).toBe(MONARCH_STEP + 4);
  });

  it('inverts every step it produces', () => {
    for (let step = 0; step < MONARCH_STEP + 10; step++) {
      expect(rankStep(rankFromStep(step))).toBe(step);
    }
  });

  it('refuses a step that is negative or not an integer', () => {
    expect(() => rankFromStep(-1)).toThrow(RangeError);
    expect(() => rankFromStep(1.5)).toThrow(RangeError);
    expect(() => rankFromStep(Number.NaN)).toThrow(RangeError);
  });

  it('crosses titles and enters Monarch on the next rank', () => {
    expect(nextRank({ title: 'commoner', grade: 5 })).toEqual({ title: 'baron', grade: 1 });
    expect(nextRank({ title: 'duke', grade: 5 })).toEqual({ title: 'monarch', stars: 0 });
    expect(nextRank({ title: 'monarch', stars: 2 })).toEqual({ title: 'monarch', stars: 3 });
  });

  it('orders ranks by step', () => {
    expect(
      compareRanks({ title: 'baron', grade: 1 }, { title: 'commoner', grade: 5 }),
    ).toBeGreaterThan(0);
    expect(compareRanks({ title: 'duke', grade: 2 }, { title: 'duke', grade: 2 })).toBe(0);
    expect(compareRanks({ title: 'duke', grade: 5 }, { title: 'monarch', stars: 0 })).toBeLessThan(
      0,
    );
  });

  it('keys every rank distinctly for i18n and crests', () => {
    const keys = RANK_ROAD.map(rankKey);
    expect(keys[0]).toBe('commoner-1');
    expect(keys.at(-1)).toBe('monarch-0');
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('lays out a sixteen-rank road that parses and climbs', () => {
    expect(RANK_ROAD).toHaveLength(16);
    expect(RANK_ROAD.every((rank) => RankSchema.safeParse(rank).success)).toBe(true);
    expect(RANK_ROAD.map(rankStep)).toEqual(Array.from({ length: 16 }, (_, step) => step));
  });
});

describe('RankProgressSchema', () => {
  const progress = {
    rank: { title: 'commoner', grade: 2 },
    repute: 700,
    reputeIntoRank: 300,
    reputeToNext: 600,
  };

  it('round-trips the bar toward the next rank', () => {
    const { parsed, reparsed } = roundTrip(RankProgressSchema, progress);
    expect(reparsed).toEqual(parsed);
  });

  it('accepts a bar that has just started', () => {
    expect(RankProgressSchema.safeParse({ ...progress, reputeIntoRank: 0 }).success).toBe(true);
  });

  it('rejects a full bar, since the server ranks up first', () => {
    const full = { ...progress, reputeIntoRank: 600 };
    expect(issuePaths(RankProgressSchema.safeParse(full))).toEqual([['reputeIntoRank']]);
  });

  it('rejects more Repute into the rank than in the lifetime total', () => {
    const over = { ...progress, repute: 200 };
    expect(issuePaths(RankProgressSchema.safeParse(over))).toEqual([['reputeIntoRank']]);
  });

  it('rejects a rank with nothing to the next one', () => {
    expect(RankProgressSchema.safeParse({ ...progress, reputeToNext: 0 }).success).toBe(false);
  });
});
