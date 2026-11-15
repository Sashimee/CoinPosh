import { describe, expect, it } from 'vitest';
import { MAX_CHECKPOINTS_PER_SEGMENT, MAX_INPUT_EVENTS_PER_SEGMENT } from '../table.ts';
import { roundTrip } from '../../test/roundTrip.ts';
import { liveEventsFixtures, livePuzzle } from './fixtures.ts';
import {
  DailyPuzzleSchema,
  MAX_PUZZLE_TICKS,
  PUZZLE_REJECTIONS,
  PuzzleAttemptsSchema,
  PuzzleBudgetSchema,
  PuzzleGoalSchema,
  PuzzleResponseSchema,
  PuzzleSeedSchema,
  PuzzleStartRequestSchema,
  PuzzleStartResponseSchema,
  PuzzleSubmitRequestSchema,
  PuzzleSubmitResponseSchema,
} from './puzzle.ts';
import { DAY_MS } from './time.ts';

const today = liveEventsFixtures.liveEventsPuzzle.response;
const start = liveEventsFixtures.liveEventsPuzzleStart.response;
const log = liveEventsFixtures.liveEventsPuzzleSubmit.body;
const submitted = liveEventsFixtures.liveEventsPuzzleSubmit.response;
if (submitted.verdict !== 'solved') throw new Error('The puzzle submit fixture must be solved.');
const solved = submitted;
const issuePaths = (result: { error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => issue.path);

describe('puzzle seed, goal and budget', () => {
  it.each([0, 1, 0xffff_ffff])('accepts the uint32 seed %i', (seed) => {
    expect(PuzzleSeedSchema.safeParse(seed).success).toBe(true);
  });

  it.each([-1, 0x1_0000_0000, 1.5, '42'])('refuses the seed %s', (seed) => {
    expect(PuzzleSeedSchema.safeParse(seed).success).toBe(false);
  });

  it.each([
    { kind: 'bankTier', tier: 'platinum', count: 3 },
    { kind: 'fuse', tier: 'gold', count: 2 },
    { kind: 'cascade', tier: 'opulent' },
    { kind: 'bankValue', amount: 25_000 },
  ])('round-trips a $kind goal', (goal) => {
    const { parsed, reparsed } = roundTrip(PuzzleGoalSchema, goal);
    expect(reparsed).toEqual(parsed);
  });

  it.each([
    ['a goal of nothing', { kind: 'bankTier', tier: 'gold', count: 0 }],
    ['a fusion into copper, which nothing fuses into', { kind: 'fuse', tier: 'copper', count: 1 }],
    ['an unknown Cascade tier', { kind: 'cascade', tier: 'tremendous' }],
    ['a client-chosen score target', { kind: 'score', amount: 10 }],
  ])('refuses %s', (_label, goal) => {
    expect(PuzzleGoalSchema.safeParse(goal).success).toBe(false);
  });

  it('bounds a budget to the transport limit', () => {
    expect(PuzzleBudgetSchema.safeParse({ drops: 1, ticks: MAX_PUZZLE_TICKS }).success).toBe(true);
    expect(PuzzleBudgetSchema.safeParse({ drops: 1, ticks: MAX_PUZZLE_TICKS + 1 }).success).toBe(
      false,
    );
    expect(PuzzleBudgetSchema.safeParse({ drops: 0, ticks: 600 }).success).toBe(false);
  });
});

describe('DailyPuzzleSchema', () => {
  it('round-trips the fixture', () => {
    const { parsed, reparsed } = roundTrip(DailyPuzzleSchema, livePuzzle);
    expect(reparsed).toEqual(parsed);
  });

  it('runs for exactly its own UTC day', () => {
    expect(issuePaths(DailyPuzzleSchema.safeParse({ ...livePuzzle, day: '2026-11-14' }))).toEqual([
      ['startsAt'],
      ['endsAt'],
    ]);
    expect(
      issuePaths(DailyPuzzleSchema.safeParse({ ...livePuzzle, endsAt: livePuzzle.endsAt + 1 })),
    ).toEqual([['endsAt']]);
    expect(
      issuePaths(
        DailyPuzzleSchema.safeParse({
          ...livePuzzle,
          startsAt: livePuzzle.startsAt - 3_600_000,
          endsAt: livePuzzle.startsAt - 3_600_000 + DAY_MS,
        }),
      ),
    ).toEqual([['startsAt'], ['endsAt']]);
  });
});

describe('PuzzleResponseSchema', () => {
  it('round-trips the fixture', () => {
    const { parsed, reparsed } = roundTrip(PuzzleResponseSchema, today);
    expect(reparsed).toEqual(parsed);
  });

  it('accepts a first visit with no attempts and a capped day', () => {
    const fresh = { ...today, attempts: { used: 0, limit: 3 }, best: null };
    expect(PuzzleResponseSchema.safeParse(fresh).success).toBe(true);
  });

  it.each([
    ['yesterday’s puzzle', { serverTime: today.puzzle.endsAt }, ['puzzle']],
    ['no finishing reward', { rewards: today.rewards.slice(1) }, ['rewards']],
    ['two finishing rewards', { rewards: [today.rewards[0], ...today.rewards] }, ['rewards']],
    [
      'an open attempt that is not the latest',
      { open: { attempt: 2, startedAt: 0 } },
      ['open', 'attempt'],
    ],
    [
      'a best result over the drop budget',
      { best: { ...today.best, dropsUsed: 41 } },
      ['best', 'dropsUsed'],
    ],
    [
      'a best result past the tick budget',
      { best: { ...today.best, ticksUsed: 18_001 } },
      ['best', 'ticksUsed'],
    ],
    [
      'a best result from an attempt not started',
      { best: { ...today.best, attempt: 2 } },
      ['best', 'attempt'],
    ],
  ])('refuses %s', (_label, change, path) => {
    expect(issuePaths(PuzzleResponseSchema.safeParse({ ...today, ...change }))).toContainEqual(
      path,
    );
  });

  it('keeps attempts used within the limit', () => {
    expect(PuzzleAttemptsSchema.safeParse({ used: 3, limit: 3 }).success).toBe(true);
    expect(PuzzleAttemptsSchema.safeParse({ used: 4, limit: 3 }).success).toBe(false);
    expect(PuzzleAttemptsSchema.safeParse({ used: 99, limit: null }).success).toBe(true);
  });
});

describe('puzzle start', () => {
  it('takes no body fields, so the client cannot pick the day or the seed', () => {
    expect(PuzzleStartRequestSchema.safeParse({}).success).toBe(true);
    expect(PuzzleStartRequestSchema.safeParse({ seed: 7 }).success).toBe(false);
  });

  it('round-trips the fixture and counts the attempt as used', () => {
    const { parsed, reparsed } = roundTrip(PuzzleStartResponseSchema, start);
    expect(reparsed).toEqual(parsed);
    const uncounted = { ...start, attempts: { used: 1, limit: null } };
    expect(issuePaths(PuzzleStartResponseSchema.safeParse(uncounted))).toEqual([
      ['open', 'attempt'],
    ]);
  });

  it('starts inside the puzzle day', () => {
    const late = { ...start, open: { ...start.open, startedAt: start.puzzle.endsAt } };
    expect(issuePaths(PuzzleStartResponseSchema.safeParse(late))).toEqual([['open', 'startedAt']]);
  });
});

describe('PuzzleSubmitRequestSchema', () => {
  it('round-trips the input log', () => {
    const { parsed, reparsed } = roundTrip(PuzzleSubmitRequestSchema, log);
    expect(reparsed).toEqual(parsed);
  });

  it('accepts an empty log that only hashes the end', () => {
    const idle = { ...log, endTick: 0, events: [], checkpoints: [{ tick: 0, hash: 'a1b2c3d4' }] };
    expect(PuzzleSubmitRequestSchema.safeParse(idle).success).toBe(true);
  });

  it('accepts inputs on the same tick and at endTick', () => {
    const tight = {
      ...log,
      events: [
        { kind: 'drop', tick: 30, x: -1 },
        { kind: 'drop', tick: 30, x: 1 },
        { kind: 'nudge', tick: log.endTick, direction: 'right' },
      ],
    };
    expect(PuzzleSubmitRequestSchema.safeParse(tight).success).toBe(true);
  });

  it.each([
    ['a client-claimed score', { score: 99_999 }],
    ['a client-claimed outcome', { solved: true }],
    ['a client-counted drop total', { dropsUsed: 3 }],
    ['a client timestamp', { finishedAt: 1 }],
    ['the seed', { seed: 7 }],
  ])('refuses %s', (_label, forged) => {
    expect(PuzzleSubmitRequestSchema.safeParse({ ...log, ...forged }).success).toBe(false);
  });

  it.each([
    [
      'inputs out of order',
      { events: [log.events[1], log.events[0], ...log.events.slice(2)] },
      ['events', 1, 'tick'],
    ],
    [
      'an input after endTick',
      { events: [...log.events, { kind: 'drop', tick: log.endTick + 1, x: 0 }] },
      ['events', log.events.length, 'tick'],
    ],
    [
      'checkpoints out of order',
      { checkpoints: [log.checkpoints[1], log.checkpoints[0]] },
      ['checkpoints', 1, 'tick'],
    ],
    [
      'two checkpoints on one tick',
      { checkpoints: [log.checkpoints[1], log.checkpoints[1]] },
      ['checkpoints', 1, 'tick'],
    ],
    ['no hash at endTick', { checkpoints: log.checkpoints.slice(0, 1) }, ['checkpoints']],
  ])('refuses %s', (_label, change, path) => {
    expect(issuePaths(PuzzleSubmitRequestSchema.safeParse({ ...log, ...change }))).toContainEqual(
      path,
    );
  });

  it.each([
    ['no checkpoints', { checkpoints: [] }],
    [
      'a drop carrying a coin id',
      { events: [{ kind: 'drop', tick: 1, x: 0, coinId: 'coin_7Hq2LmX9pA' }] },
    ],
    ['a drop off the rail', { events: [{ kind: 'drop', tick: 1, x: 1.01 }] }],
    ['an attempt past the tick limit', { endTick: MAX_PUZZLE_TICKS + 1 }],
    [
      'too many inputs',
      { events: Array.from({ length: MAX_INPUT_EVENTS_PER_SEGMENT + 1 }, () => log.events[0]) },
    ],
    [
      'too many checkpoints',
      {
        checkpoints: Array.from({ length: MAX_CHECKPOINTS_PER_SEGMENT + 1 }, (_, i) => ({
          tick: i,
          hash: 'a1b2c3d4',
        })),
      },
    ],
  ])('refuses %s', (_label, change) => {
    expect(PuzzleSubmitRequestSchema.safeParse({ ...log, ...change }).success).toBe(false);
  });
});

describe('PuzzleSubmitResponseSchema', () => {
  const missed = {
    verdict: 'missed',
    day: solved.day,
    attempt: solved.attempt,
    result: { ...solved.result, solved: false, score: 0 },
    attempts: { used: 2, limit: null },
  };

  it.each<[string, unknown]>([
    ['solved', solved],
    ['missed', missed],
    ...PUZZLE_REJECTIONS.map((reason): [string, unknown] => [
      `rejected for ${reason}`,
      { verdict: 'rejected', day: solved.day, attempt: solved.attempt, reason },
    ]),
  ])('round-trips a %s verdict', (_label, answer) => {
    const { parsed, reparsed } = roundTrip(PuzzleSubmitResponseSchema, answer);
    expect(reparsed).toEqual(parsed);
  });

  it('posts a verified personal best with its rank, and keeps other solves off the board', () => {
    const posted = { ...solved, board: { status: 'posted', rank: 14 } };
    expect(PuzzleSubmitResponseSchema.safeParse(posted).success).toBe(true);
    const worse = { ...solved, personalBest: false, board: { status: 'notBest' } };
    expect(PuzzleSubmitResponseSchema.safeParse(worse).success).toBe(true);
  });

  it.each([
    [
      'a solved verdict with an unsolved result',
      { result: { ...solved.result, solved: false } },
      ['result', 'solved'],
    ],
    [
      'a result for another attempt',
      { result: { ...solved.result, attempt: 1 } },
      ['result', 'attempt'],
    ],
    ['a worse solve on the board', { personalBest: false }, ['board']],
    ['a personal best kept off the board', { board: { status: 'notBest' } }, ['board']],
  ])('refuses %s', (_label, change, path) => {
    expect(
      issuePaths(PuzzleSubmitResponseSchema.safeParse({ ...solved, ...change })),
    ).toContainEqual(path);
  });

  it('refuses a missed verdict with a solved result', () => {
    const lie = { ...missed, result: { ...missed.result, solved: true } };
    expect(issuePaths(PuzzleSubmitResponseSchema.safeParse(lie))).toEqual([['result', 'solved']]);
  });

  it('refuses an unknown verdict or rejection', () => {
    expect(PuzzleSubmitResponseSchema.safeParse({ ...solved, verdict: 'perfect' }).success).toBe(
      false,
    );
    const reason = { verdict: 'rejected', day: solved.day, attempt: 2, reason: 'tooGood' };
    expect(PuzzleSubmitResponseSchema.safeParse(reason).success).toBe(false);
  });
});
