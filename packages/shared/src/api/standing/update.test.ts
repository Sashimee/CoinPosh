import { describe, expect, it } from 'vitest';
import { roundTrip } from '../../test/roundTrip.ts';
import { standingNow, standingPerks } from './fixtures.ts';
import { REPUTE_SOURCES, ReputeGainSchema } from './repute.ts';
import { StandingUpdateSchema } from './update.ts';

const [crest, autoDrop] = standingPerks;
const baron1 = { title: 'baron', grade: 1 } as const;
const update = {
  gains: [
    { source: 'coinPushed', amount: 84 },
    { source: 'fusion', amount: 12 },
    { source: 'crateOpened', amount: 20 },
  ],
  progress: { rank: baron1, repute: 5_046, reputeIntoRank: 46, reputeToNext: 3_075 },
  rankUps: [{ rank: baron1, perks: [crest, autoDrop] }],
  achievements: [
    { id: 'firstCascade', category: 'pushing', grade: 'bronze', unlockedAt: standingNow },
  ],
  mastery: [{ track: { kind: 'coinTier', tier: 'silver' }, level: 2, bonusBp: 200 }],
};
const quiet = { ...update, rankUps: [], achievements: [], mastery: [] };
const issuePaths = (result: { error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => issue.path);

describe('ReputeGainSchema', () => {
  it.each(REPUTE_SOURCES)('round-trips Repute from %s', (source) => {
    const { parsed, reparsed } = roundTrip(ReputeGainSchema, { source, amount: 1 });
    expect(reparsed).toEqual(parsed);
  });

  it('rejects a gain of nothing and an unknown source', () => {
    expect(ReputeGainSchema.safeParse({ source: 'fusion', amount: 0 }).success).toBe(false);
    expect(ReputeGainSchema.safeParse({ source: 'clientSaysSo', amount: 1 }).success).toBe(false);
  });
});

describe('StandingUpdateSchema', () => {
  it('round-trips a step that ranked up, unlocked a badge and levelled a track', () => {
    const { parsed, reparsed } = roundTrip(StandingUpdateSchema, update);
    expect(reparsed).toEqual(parsed);
  });

  it('accepts a quiet step and one that gained nothing', () => {
    expect(StandingUpdateSchema.safeParse(quiet).success).toBe(true);
    expect(StandingUpdateSchema.safeParse({ ...quiet, gains: [] }).success).toBe(true);
  });

  it('accepts several rank-ups in one step, lowest first', () => {
    const progress = { ...update.progress, rank: { title: 'baron', grade: 3 } };
    const climb = {
      ...update,
      progress,
      rankUps: [
        { rank: baron1, perks: [crest] },
        { rank: { title: 'baron', grade: 2 }, perks: [] },
        { rank: { title: 'baron', grade: 3 }, perks: [] },
      ],
    };
    expect(StandingUpdateSchema.safeParse(climb).success).toBe(true);
  });

  it('rejects rank-ups out of order', () => {
    const progress = { ...update.progress, rank: { title: 'baron', grade: 2 } };
    const shuffled = {
      ...update,
      progress,
      rankUps: [
        { rank: { title: 'baron', grade: 2 }, perks: [] },
        { rank: baron1, perks: [] },
        { rank: { title: 'baron', grade: 2 }, perks: [] },
      ],
    };
    expect(issuePaths(StandingUpdateSchema.safeParse(shuffled))).toEqual([['rankUps', 1, 'rank']]);
  });

  it('rejects a rank-up that does not end at the rank reached', () => {
    const behind = {
      ...update,
      progress: { ...update.progress, rank: { title: 'commoner', grade: 5 } },
    };
    expect(issuePaths(StandingUpdateSchema.safeParse(behind))).toEqual([['rankUps', 0, 'rank']]);
  });

  it('rejects a rank-up without any Repute gained', () => {
    expect(issuePaths(StandingUpdateSchema.safeParse({ ...update, gains: [] }))).toEqual([
      ['rankUps'],
    ]);
  });

  it('rejects more Repute gained than the lifetime total', () => {
    const inflated = { ...quiet, progress: { ...quiet.progress, repute: 100, reputeIntoRank: 46 } };
    expect(issuePaths(StandingUpdateSchema.safeParse(inflated))).toEqual([['gains']]);
  });

  it('rejects a source listed twice, a badge unlocked twice and a track levelled twice', () => {
    const doubled = {
      ...update,
      gains: [...update.gains, { source: 'fusion', amount: 3 }],
      achievements: [...update.achievements, ...update.achievements],
      mastery: [...update.mastery, { ...update.mastery[0], level: 3 }],
    };
    expect(issuePaths(StandingUpdateSchema.safeParse(doubled))).toEqual([
      ['gains', 3, 'source'],
      ['achievements', 1, 'id'],
      ['mastery', 1, 'track'],
    ]);
  });
});
