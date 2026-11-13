import { safeTypeDef } from '@coinposh/economy';
import type { Safe, SafeOpenMethod } from '@coinposh/shared';
import { safeCountdown, type SafeCountdown } from './countdown.ts';

export interface SafeActionInput {
  readonly safe: Pick<Safe, 'type' | 'unlocksAt'>;
  readonly serverNow: number | null;
  /** Keys to count against, as the server last reported them; null when there is no figure. */
  readonly keys: number | null;
  /** The open in flight for this safe, if any. */
  readonly pending: SafeOpenMethod | null;
  /** Another safe is opening or playing; one safe opens at a time. */
  readonly busy?: boolean;
}

export interface SafeKeyAction {
  readonly visible: boolean;
  readonly enabled: boolean;
  /** Keys this type costs, from packages/economy. */
  readonly cost: number;
  /** Why it is disabled; null while enabled or hidden. */
  readonly blocked: 'noKeys' | 'pending' | null;
}

export interface SafeTimerAction {
  readonly visible: boolean;
  readonly enabled: boolean;
}

export interface SafeActions {
  readonly countdown: SafeCountdown;
  readonly key: SafeKeyAction;
  readonly timer: SafeTimerAction;
}

/**
 * Which buttons a safe's row shows. A locked (or not yet synced) safe offers "Open with N Keys";
 * once its timer has run out on the server clock it offers a free "Open" instead. Both wait
 * while any open is in flight. The server checks the Keys and the timer again either way.
 */
export function safeActions(input: SafeActionInput): SafeActions {
  const countdown = safeCountdown(input.safe, input.serverNow);
  const cost = safeTypeDef(input.safe.type).keysPerSafe;
  const ready = countdown.state === 'ready';
  const pending = input.pending !== null || input.busy === true;
  const short = input.keys !== null && input.keys < cost;
  const blocked = ready ? null : pending ? 'pending' : short ? 'noKeys' : null;
  return {
    countdown,
    key: { visible: !ready, enabled: !ready && blocked === null, cost, blocked },
    timer: { visible: ready, enabled: ready && !pending },
  };
}

/** Keys to show while Key opens wait on the server: provisional until the wallet comes back. */
export function provisionalKeys(
  keys: number | null,
  pending: readonly { readonly type: string; readonly method: SafeOpenMethod }[],
): number | null {
  if (keys === null) return null;
  const spent = pending.reduce(
    (sum, open) => sum + (open.method === 'key' ? safeTypeDef(open.type).keysPerSafe : 0),
    0,
  );
  return Math.max(0, keys - spent);
}
