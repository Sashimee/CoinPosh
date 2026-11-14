import { safeTimerReady, safeTypeDef } from '@coinposh/economy';
import type { Safe } from '@coinposh/shared';

export type SafeTimerState = 'syncing' | 'locked' | 'ready';

export interface SafeCountdown {
  /** `syncing` until the session has a server-clock offset: the client clock is never used. */
  readonly state: SafeTimerState;
  /** ms left on the server clock; null while syncing. */
  readonly remainingMs: number | null;
  /** 0 just granted .. 1 ready, against the type's unlock time; null while syncing. */
  readonly fraction: number | null;
}

/**
 * Where a safe's timer stands, read from the server's `unlocksAt` against the server-clock
 * estimate (`ServerClock.now()`). The server still decides: a timer open it refuses is shown
 * as refused, whatever this says.
 */
export function safeCountdown(
  safe: Pick<Safe, 'type' | 'unlocksAt'>,
  serverNow: number | null,
): SafeCountdown {
  const totalMs = safeTypeDef(safe.type).unlockSeconds * 1_000;
  if (serverNow === null) return { state: 'syncing', remainingMs: null, fraction: null };
  if (safeTimerReady(safe.unlocksAt, serverNow)) {
    return { state: 'ready', remainingMs: 0, fraction: 1 };
  }
  const remainingMs = safe.unlocksAt - serverNow;
  const fraction = Math.min(1, Math.max(0, 1 - remainingMs / totalMs));
  return { state: 'locked', remainingMs, fraction };
}

const pad = (value: number) => String(value).padStart(2, '0');

/**
 * `H:MM:SS`, or `M:SS` under an hour. Seconds round up, so a locked safe reads 0:01 until the
 * moment it is ready and never shows 0:00.
 */
export function formatCountdown(remainingMs: number): string {
  if (!Number.isFinite(remainingMs)) {
    throw new RangeError(`formatCountdown needs a finite ms count, got ${remainingMs}`);
  }
  const total = Math.max(0, Math.ceil(remainingMs / 1_000));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** ms until the shown countdown next changes, so the panel repaints on the second. */
export function msToNextSecond(remainingMs: number): number {
  const rest = remainingMs % 1_000;
  return rest <= 0 ? 1_000 : rest;
}

/** ms until the first of `safes` is ready on the server clock; null if none is waiting or unsynced. */
export function msToFirstReady(
  safes: readonly Pick<Safe, 'type' | 'unlocksAt'>[],
  serverNow: number | null,
): number | null {
  let soonest: number | null = null;
  for (const safe of safes) {
    const countdown = safeCountdown(safe, serverNow);
    if (countdown.state !== 'locked' || countdown.remainingMs === null) continue;
    soonest = soonest === null ? countdown.remainingMs : Math.min(soonest, countdown.remainingMs);
  }
  return soonest;
}

/** How many of `safes` open on their timer right now; 0 before the first sync. */
export function readyCount(
  safes: readonly Pick<Safe, 'type' | 'unlocksAt'>[],
  serverNow: number | null,
): number {
  return safes.filter((safe) => safeCountdown(safe, serverNow).state === 'ready').length;
}
