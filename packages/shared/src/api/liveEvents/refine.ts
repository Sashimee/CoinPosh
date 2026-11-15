import type { z } from 'zod';
import type { EpochMs } from '../../primitives.ts';

/** Schema-building helpers for this folder; kept out of the barrel like `../standing/refine.ts`. */
export { checkUnique } from '../standing/refine.ts';

/** Flags a clock whose local day does not hold `serverTime`. */
export function checkClockAt(
  clock: { dayStartsAt: EpochMs; nextDayAt: EpochMs },
  serverTime: EpochMs,
  ctx: z.RefinementCtx,
  path: PropertyKey[],
): void {
  if (serverTime < clock.dayStartsAt || serverTime >= clock.nextDayAt) {
    ctx.addIssue({
      code: 'custom',
      path,
      message: 'The clock reports the local day the server time falls in.',
    });
  }
}

/** Flags a window that closes before it opens. */
export function checkWindow(
  window: { startsAt: EpochMs; endsAt: EpochMs },
  ctx: z.RefinementCtx,
  path: PropertyKey[],
): void {
  if (window.endsAt <= window.startsAt) {
    ctx.addIssue({
      code: 'custom',
      path: [...path, 'endsAt'],
      message: 'A window closes after it opens.',
    });
  }
}
