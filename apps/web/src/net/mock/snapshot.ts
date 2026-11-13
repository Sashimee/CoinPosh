import { rateEnvelopeDerivation } from '@coinposh/economy';
import type { CoinId, CratePoseTuple, PoseTuple } from '@coinposh/shared';
import { TICK_RATE_HZ } from '@coinposh/sim/layout';
import {
  CRATE_RIDE,
  DEFAULT_PUSHER_MOTION,
  POSITION_UNIT,
  SIM_SNAPSHOT_VERSION,
  validateSnapshot,
  type CoinPose,
  type CratePose,
} from '@coinposh/sim/snapshot';

// TODO(backend-engineer): move these bounds, mirrored from apps/server/src/do/snapshot.ts since
// Demo Mode cannot import the server, into packages/shared so both sides share them.
export const SNAPSHOT_RATE = { intervalMs: 2_000, burst: 3 } as const;
const COIN_TRAVEL = { maxSpeed: 0.5, slack: 0.02, clockAllowanceMs: 250 } as const;
const CRATE_SLACK = { z: 0.01, elapsedMs: 1_000 } as const;
export const CRATE_MAX_RIDE_SECONDS = rateEnvelopeDerivation.crateFallSeconds.max;

const PUSHER_PEAK_SPEED =
  (1.5 * DEFAULT_PUSHER_MOTION.stroke) /
  ((DEFAULT_PUSHER_MOTION.pushFraction * DEFAULT_PUSHER_MOTION.periodTicks) / TICK_RATE_HZ);
const CRATE_MAX_SPEED = CRATE_RIDE.carry * PUSHER_PEAK_SPEED + CRATE_RIDE.creepPerSecond;

export const SNAPSHOT_FLAG_KINDS = [
  'snapshot.foreign',
  'snapshot.teleport',
  'snapshot.implausible',
] as const;
export type SnapshotFlagKind = (typeof SNAPSHOT_FLAG_KINDS)[number];

export interface StoredSnapshot {
  readonly session: string;
  readonly seq: number;
  readonly tick: number;
  readonly pusherTick: number;
  readonly poses: readonly PoseTuple[];
  readonly cratePoses: readonly CratePoseTuple[];
  readonly receivedAt: number;
}

export interface TokenBucket {
  readonly tokens: number;
  readonly at: number;
}

export type TokenTake =
  | { readonly ok: true; readonly bucket: TokenBucket }
  | { readonly ok: false; readonly retryAfterMs: number };

/** Refills by server time only; `at` never moves back, so a clock stepped back earns nothing. */
export function takeSnapshotToken(bucket: TokenBucket | null, now: number): TokenTake {
  const { intervalMs, burst } = SNAPSHOT_RATE;
  const at = bucket === null ? now : Math.max(bucket.at, now);
  const refill = bucket === null ? burst : Math.max(0, now - bucket.at) / intervalMs;
  const tokens = Math.min(burst, (bucket?.tokens ?? 0) + refill);
  if (tokens < 1) return { ok: false, retryAfterMs: Math.ceil((1 - tokens) * intervalMs) };
  return { ok: true, bucket: { tokens: tokens - 1, at } };
}

export function toCoinPose(tuple: PoseTuple, simId: number): CoinPose {
  const [, x, y, z, qx, qy, qz, qw, rest] = tuple;
  return { id: simId, p: [x, y, z], q: [qx, qy, qz, qw], rest };
}

export function toCratePose(tuple: CratePoseTuple): CratePose {
  const [, x, z, elapsedMs, phase] = tuple;
  return { x, z, elapsedMs, phase };
}

export const CHUTE_POSE: CratePose = {
  x: 0,
  z: Math.round(CRATE_RIDE.spawnZ / POSITION_UNIT),
  elapsedMs: 0,
  phase: 'riding',
};

/** What the ticks say passed, but never more than the server's clock saw, plus jitter. */
export function elapsedSeconds(ticks: number, since: number, now: number): number {
  const byTicks = Math.max(0, ticks) / TICK_RATE_HZ;
  const byClock = (Math.max(0, now - since) + COIN_TRAVEL.clockAllowanceMs) / 1000;
  return Math.min(byTicks, byClock);
}

export function withinCoinTravel(from: PoseTuple, to: PoseTuple, seconds: number): boolean {
  const dx = (to[1] - from[1]) * POSITION_UNIT;
  const dy = (to[2] - from[2]) * POSITION_UNIT;
  const dz = (to[3] - from[3]) * POSITION_UNIT;
  return Math.hypot(dx, dy, dz) <= COIN_TRAVEL.maxSpeed * seconds + COIN_TRAVEL.slack;
}

export function withinCrateRide(from: CratePose, to: CratePose, seconds: number): boolean {
  const dz = (to.z - from.z) * POSITION_UNIT;
  const maxDz = CRATE_MAX_SPEED * seconds + CRATE_RIDE.nudgeForward + CRATE_SLACK.z;
  const dElapsed = to.elapsedMs - from.elapsedMs;
  return (
    dz >= 0 && dz <= maxDz && dElapsed >= 0 && dElapsed <= seconds * 1000 + CRATE_SLACK.elapsedMs
  );
}

/**
 * The poses a restore can take, through the sim's own checks: each table coin goes by its
 * place in `table.coins`, the sim id a client laying them in order gives it.
 */
export function judgePoses(
  tableCoins: readonly CoinId[],
  tuples: readonly PoseTuple[],
  pusherTick: number,
): { ok: Map<CoinId, PoseTuple>; dropped: number } {
  const simIds = new Map(tableCoins.map((id, simId) => [id, simId]));
  const posed = tuples.flatMap((pose) => {
    const simId = simIds.get(pose[0]);
    return simId === undefined ? [] : [{ simId, pose }];
  });
  const verdict = validateSnapshot({
    version: SIM_SNAPSHOT_VERSION,
    pusherTickInCycle: pusherTick,
    coins: posed.map(({ simId, pose }) => toCoinPose(pose, simId)),
  });
  const kept = new Set(verdict.ok.map((pose) => pose.id));
  return {
    ok: new Map(posed.filter(({ simId }) => kept.has(simId)).map(({ pose }) => [pose[0], pose])),
    dropped: verdict.dropped.length,
  };
}

export function present<T>(items: readonly (T | undefined)[]): T[] {
  return items.filter((item): item is T => item !== undefined);
}
