import type { z } from 'zod';
import { compareRanks, rankKey, type Rank } from './ranks.ts';

/** Flags every repeat of a key; kept out of the barrel because it is a schema-building helper. */
export function checkUnique<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  ctx: z.RefinementCtx,
  path: (index: number) => PropertyKey[],
  message: string,
): void {
  const seen = new Set<string>();
  items.forEach((item, i) => {
    const key = keyOf(item);
    if (seen.has(key)) ctx.addIssue({ code: 'custom', path: path(i), message });
    seen.add(key);
  });
}

/** Rank-ups in the order they happened, each above the last, ending at the rank reached. */
export function checkRankUps(
  rankUps: readonly { rank: Rank }[],
  reached: Rank,
  ctx: z.RefinementCtx,
  path: PropertyKey[],
): void {
  rankUps.forEach(({ rank }, i) => {
    const previous = rankUps[i - 1];
    if (previous !== undefined && compareRanks(previous.rank, rank) >= 0) {
      ctx.addIssue({
        code: 'custom',
        path: [...path, i, 'rank'],
        message: 'Rank-ups are listed once each, lowest first.',
      });
    }
  });
  const last = rankUps.at(-1);
  if (last !== undefined && compareRanks(last.rank, reached) !== 0) {
    ctx.addIssue({
      code: 'custom',
      path: [...path, rankUps.length - 1, 'rank'],
      message: `The last rank-up (${rankKey(last.rank)}) is the rank reached (${rankKey(reached)}).`,
    });
  }
}
