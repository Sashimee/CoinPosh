import type { z } from 'zod';
import type { EpochMs } from '../../primitives.ts';

/** Schema-building helpers for this folder; kept out of the barrel like `../standing/refine.ts`. */
export { checkUnique } from '../standing/refine.ts';

/** Flags a server stamp later than the answer's own `serverTime`; `null` stamps pass. */
export function checkNotAfter(
  at: EpochMs | null,
  serverTime: EpochMs,
  ctx: z.RefinementCtx,
  path: PropertyKey[],
  message: string,
): void {
  if (at !== null && at > serverTime) ctx.addIssue({ code: 'custom', path, message });
}
