import { z } from 'zod';
import {
  CascadeTierSchema,
  CoinTierSchema,
  NudgeDirectionSchema,
  WalletSchema,
} from '../../domain.ts';
import { BoardIdSchema, VenueIdSchema } from '../../ids.ts';
import { AmountSchema, EpochMsSchema, PositiveAmountSchema, TickSchema } from '../../primitives.ts';
import {
  AimSchema,
  MAX_CHECKPOINTS_PER_SEGMENT,
  MAX_INPUT_EVENTS_PER_SEGMENT,
  SimCheckpointSchema,
} from '../table.ts';
import { BASIS_POINTS, LiveGrantSchema, LiveRewardSchema } from './rewards.ts';
import { DAY_MS, DayKeySchema, utcDayStart } from './time.ts';

/** Transport bound on one attempt: ten minutes of the 60 Hz sim. */
export const MAX_PUZZLE_TICKS = 36_000;

/** The 32-bit seed `packages/sim` lays the puzzle's opening table from, the same for everyone. */
export const PuzzleSeedSchema = z.int().min(0).max(0xffff_ffff);
export type PuzzleSeed = z.infer<typeof PuzzleSeedSchema>;

/**
 * What the day asks for; `packages/sim` (T-13.05) evaluates it inside the replay, so a goal is
 * met or not by the server's run, never by the client's say-so.
 * - `bankTier`: `count` coins of `tier` or above over the front edge.
 * - `fuse`: `count` fusions that make a coin of `tier`.
 * - `cascade`: a Cascade that reaches `tier`.
 * - `bankValue`: `amount` coin value over the front edge.
 */
export const PuzzleGoalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bankTier'), tier: CoinTierSchema, count: PositiveAmountSchema }),
  z.object({
    kind: z.literal('fuse'),
    tier: CoinTierSchema.exclude(['copper']),
    count: PositiveAmountSchema,
  }),
  z.object({ kind: z.literal('cascade'), tier: CascadeTierSchema }),
  z.object({ kind: z.literal('bankValue'), amount: PositiveAmountSchema }),
]);
export type PuzzleGoal = z.infer<typeof PuzzleGoalSchema>;
export type PuzzleGoalKind = PuzzleGoal['kind'];

/** The attempt's limits: at most `drops` coins, and it ends at `ticks` whatever is on the table. */
export const PuzzleBudgetSchema = z.object({
  drops: PositiveAmountSchema,
  ticks: PositiveAmountSchema.max(MAX_PUZZLE_TICKS),
});
export type PuzzleBudget = z.infer<typeof PuzzleBudgetSchema>;

/** One puzzle per UTC day, identical for every player; `board` is its leaderboard. */
export const DailyPuzzleSchema = z
  .object({
    day: DayKeySchema,
    seed: PuzzleSeedSchema,
    venue: VenueIdSchema,
    goal: PuzzleGoalSchema,
    budget: PuzzleBudgetSchema,
    board: BoardIdSchema,
    startsAt: EpochMsSchema,
    endsAt: EpochMsSchema,
  })
  .superRefine((puzzle, ctx) => {
    const opens = utcDayStart(puzzle.day);
    if (puzzle.startsAt !== opens) {
      ctx.addIssue({
        code: 'custom',
        path: ['startsAt'],
        message: `The ${puzzle.day} puzzle opens at that day's midnight UTC (${opens}).`,
      });
    }
    if (puzzle.endsAt !== opens + DAY_MS) {
      ctx.addIssue({
        code: 'custom',
        path: ['endsAt'],
        message: 'A daily puzzle runs for exactly one UTC day.',
      });
    }
  });
export type DailyPuzzle = z.infer<typeof DailyPuzzleSchema>;

/** `finish` pays once a day for the first solve; `topShare` pays the best `shareBp` of the board. */
export const PuzzleRewardTierSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('finish'), rewards: z.array(LiveRewardSchema).min(1) }),
  z.object({
    kind: z.literal('topShare'),
    shareBp: PositiveAmountSchema.max(BASIS_POINTS),
    rewards: z.array(LiveRewardSchema).min(1),
  }),
]);
export type PuzzleRewardTier = z.infer<typeof PuzzleRewardTierSchema>;

/** `limit` is `null` when the day allows unlimited attempts; the number is economy config. */
export const PuzzleAttemptsSchema = z
  .object({
    used: AmountSchema,
    limit: PositiveAmountSchema.nullable(),
  })
  .refine((attempts) => attempts.limit === null || attempts.used <= attempts.limit, {
    path: ['used'],
    message: 'Attempts used cannot exceed the limit.',
  });
export type PuzzleAttempts = z.infer<typeof PuzzleAttemptsSchema>;

/**
 * One attempt as the server's replay scored it. `score` ranks the board, higher first, and is
 * derived by the server from the replay; no request carries it.
 */
export const PuzzleResultSchema = z.object({
  attempt: PositiveAmountSchema,
  solved: z.boolean(),
  dropsUsed: AmountSchema,
  ticksUsed: TickSchema.max(MAX_PUZZLE_TICKS),
  score: AmountSchema,
  verifiedAt: EpochMsSchema,
});
export type PuzzleResult = z.infer<typeof PuzzleResultSchema>;

function checkWithinBudget(
  result: { dropsUsed: number; ticksUsed: number },
  budget: PuzzleBudget,
  ctx: z.RefinementCtx,
  path: PropertyKey[],
): void {
  if (result.dropsUsed > budget.drops) {
    ctx.addIssue({
      code: 'custom',
      path: [...path, 'dropsUsed'],
      message: `A replayed attempt drops at most the ${budget.drops} coins its budget allows.`,
    });
  }
  if (result.ticksUsed > budget.ticks) {
    ctx.addIssue({
      code: 'custom',
      path: [...path, 'ticksUsed'],
      message: `A replayed attempt ends by tick ${budget.ticks}.`,
    });
  }
}

/** An attempt the server opened and is waiting on; it holds the attempt number to submit. */
export const PuzzleOpenAttemptSchema = z.object({
  attempt: PositiveAmountSchema,
  startedAt: EpochMsSchema,
});
export type PuzzleOpenAttempt = z.infer<typeof PuzzleOpenAttemptSchema>;

export const PuzzleResponseSchema = z
  .object({
    serverTime: EpochMsSchema,
    puzzle: DailyPuzzleSchema,
    rewards: z.array(PuzzleRewardTierSchema).min(1),
    attempts: PuzzleAttemptsSchema,
    open: PuzzleOpenAttemptSchema.nullable(),
    best: PuzzleResultSchema.nullable(),
  })
  .superRefine((today, ctx) => {
    const { puzzle, serverTime, attempts, open, best } = today;
    if (serverTime < puzzle.startsAt || serverTime >= puzzle.endsAt) {
      ctx.addIssue({
        code: 'custom',
        path: ['puzzle'],
        message: 'The server serves the puzzle of the UTC day it is reporting from.',
      });
    }
    if (today.rewards.filter((tier) => tier.kind === 'finish').length !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['rewards'],
        message: 'The puzzle names exactly one finishing reward.',
      });
    }
    if (open !== null && open.attempt !== attempts.used) {
      ctx.addIssue({
        code: 'custom',
        path: ['open', 'attempt'],
        message: 'The open attempt is the latest one started.',
      });
    }
    if (best !== null) {
      checkWithinBudget(best, puzzle.budget, ctx, ['best']);
      if (best.attempt > attempts.used) {
        ctx.addIssue({
          code: 'custom',
          path: ['best', 'attempt'],
          message: 'The best result comes from an attempt already started.',
        });
      }
    }
  });
export type PuzzleResponse = z.infer<typeof PuzzleResponseSchema>;

/** Opens the next attempt of today's puzzle. Empty: the server picks the day and the number. */
export const PuzzleStartRequestSchema = z.strictObject({});
export type PuzzleStartRequest = z.infer<typeof PuzzleStartRequestSchema>;

export const PuzzleStartResponseSchema = z
  .object({
    puzzle: DailyPuzzleSchema,
    open: PuzzleOpenAttemptSchema,
    attempts: PuzzleAttemptsSchema,
  })
  .superRefine((start, ctx) => {
    if (start.open.attempt !== start.attempts.used) {
      ctx.addIssue({
        code: 'custom',
        path: ['open', 'attempt'],
        message: 'Starting an attempt counts it as used.',
      });
    }
    if (
      start.open.startedAt < start.puzzle.startsAt ||
      start.open.startedAt >= start.puzzle.endsAt
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['open', 'startedAt'],
        message: "An attempt starts during its puzzle's day.",
      });
    }
  });
export type PuzzleStartResponse = z.infer<typeof PuzzleStartResponseSchema>;

/** A player input on the puzzle table. Drops carry no coin id: the sim mints them from the seed. */
export const PuzzleInputEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('drop'), tick: TickSchema, x: AimSchema }),
  z.strictObject({ kind: z.literal('nudge'), tick: TickSchema, direction: NudgeDirectionSchema }),
]);
export type PuzzleInputEvent = z.infer<typeof PuzzleInputEventSchema>;

/**
 * An attempt's whole input log, replayed by the server from the day's seed. It carries inputs
 * and the client's sim hashes only (so a desync is caught at the first diverging checkpoint);
 * the outcome, drops counted and score are what the replay finds. The last checkpoint is the
 * hash at `endTick`.
 */
export const PuzzleSubmitRequestSchema = z
  .strictObject({
    day: DayKeySchema,
    attempt: PositiveAmountSchema,
    endTick: TickSchema.max(MAX_PUZZLE_TICKS),
    events: z.array(PuzzleInputEventSchema).max(MAX_INPUT_EVENTS_PER_SEGMENT),
    checkpoints: z.array(SimCheckpointSchema).min(1).max(MAX_CHECKPOINTS_PER_SEGMENT),
  })
  .superRefine((log, ctx) => {
    const issue = (path: PropertyKey[], message: string) => {
      ctx.addIssue({ code: 'custom', path, message });
    };
    log.events.forEach((event, i) => {
      const previous = log.events[i - 1];
      if (event.tick > log.endTick) issue(['events', i, 'tick'], 'Inputs stop at endTick.');
      if (previous !== undefined && previous.tick > event.tick) {
        issue(['events', i, 'tick'], 'Inputs are in tick order.');
      }
    });
    log.checkpoints.forEach((checkpoint, i) => {
      const previous = log.checkpoints[i - 1];
      if (checkpoint.tick > log.endTick) {
        issue(['checkpoints', i, 'tick'], 'Checkpoints stop at endTick.');
      }
      if (previous !== undefined && previous.tick >= checkpoint.tick) {
        issue(['checkpoints', i, 'tick'], 'Checkpoints are in strictly rising tick order.');
      }
    });
    if (log.checkpoints.at(-1)?.tick !== log.endTick) {
      issue(['checkpoints'], 'The last checkpoint is the sim hash at endTick.');
    }
  });
export type PuzzleSubmitRequest = z.infer<typeof PuzzleSubmitRequestSchema>;

/** Where a solved attempt stands on the board; ranked results post only after the verifier. */
export const PuzzleBoardStatusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('posted'), rank: PositiveAmountSchema }),
  z.object({ status: z.literal('verifying') }),
  z.object({ status: z.literal('notBest') }),
]);
export type PuzzleBoardStatus = z.infer<typeof PuzzleBoardStatusSchema>;

/**
 * Why a log was refused. `replayMismatch`: a checkpoint hash differs from the server's replay.
 * `overBudget`: more drops or ticks than the budget. `dayClosed`: the puzzle's day ended.
 * `unknownAttempt`: no such attempt was started today.
 */
export const PUZZLE_REJECTIONS = [
  'replayMismatch',
  'overBudget',
  'dayClosed',
  'unknownAttempt',
] as const;
export const PuzzleRejectionSchema = z.enum(PUZZLE_REJECTIONS);
export type PuzzleRejection = z.infer<typeof PuzzleRejectionSchema>;

const submitted = { day: DayKeySchema, attempt: PositiveAmountSchema };

/** Idempotent per attempt: a repeat returns the same verdict without paying twice. */
export const PuzzleSubmitResponseSchema = z.discriminatedUnion('verdict', [
  z
    .object({
      verdict: z.literal('solved'),
      ...submitted,
      result: PuzzleResultSchema,
      personalBest: z.boolean(),
      board: PuzzleBoardStatusSchema,
      granted: z.array(LiveGrantSchema),
      wallet: WalletSchema,
    })
    .superRefine((answer, ctx) => {
      if (!answer.result.solved) {
        ctx.addIssue({
          code: 'custom',
          path: ['result', 'solved'],
          message: 'A solved verdict carries a solved result.',
        });
      }
      if (answer.result.attempt !== answer.attempt) {
        ctx.addIssue({
          code: 'custom',
          path: ['result', 'attempt'],
          message: 'The result is for the attempt submitted.',
        });
      }
      if (!answer.personalBest && answer.board.status !== 'notBest') {
        ctx.addIssue({
          code: 'custom',
          path: ['board'],
          message: 'Only a personal best goes to the board.',
        });
      }
      if (answer.personalBest && answer.board.status === 'notBest') {
        ctx.addIssue({
          code: 'custom',
          path: ['board'],
          message: 'A personal best is posted or being verified.',
        });
      }
    }),
  z
    .object({
      verdict: z.literal('missed'),
      ...submitted,
      result: PuzzleResultSchema,
      attempts: PuzzleAttemptsSchema,
    })
    .superRefine((answer, ctx) => {
      if (answer.result.solved) {
        ctx.addIssue({
          code: 'custom',
          path: ['result', 'solved'],
          message: 'A missed verdict carries an unsolved result.',
        });
      }
      if (answer.result.attempt !== answer.attempt) {
        ctx.addIssue({
          code: 'custom',
          path: ['result', 'attempt'],
          message: 'The result is for the attempt submitted.',
        });
      }
    }),
  z.object({
    verdict: z.literal('rejected'),
    ...submitted,
    reason: PuzzleRejectionSchema,
  }),
]);
export type PuzzleSubmitResponse = z.infer<typeof PuzzleSubmitResponseSchema>;
export type PuzzleVerdict = PuzzleSubmitResponse['verdict'];
