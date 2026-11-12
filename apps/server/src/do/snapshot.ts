import { rateEnvelopeDerivation } from '@coinposh/economy';
import {
  CratePoseTupleSchema,
  PoseTupleSchema,
  type CratePoseTuple,
  type EpochMs,
  type PoseTuple,
  TableSessionIdSchema,
  type TableSessionId,
  type Tick,
} from '@coinposh/shared';
import {
  CRATE_RIDE,
  DEFAULT_PUSHER_MOTION,
  POSITION_UNIT,
  type CoinPose,
  type CratePose,
} from '@coinposh/sim/snapshot';
import { TICK_RATE_HZ } from '@coinposh/sim/layout';
import { z } from 'zod';

/** The client sim's fixed step, the rate of the shared `Tick`. */
export const SIM_TICKS_PER_SECOND = TICK_RATE_HZ;

/** One accepted snapshot per 2 s, with a burst of 3 (92-table-persistence 3.2 step 3). */
export const SNAPSHOT_RATE = { intervalMs: 2_000, burst: 3 } as const;

/**
 * How far a coin may move between two stored snapshots: the pusher plus a cascade carry a
 * coin at no more than `maxSpeed`, and `slack` covers a settle or a bounce. The wall-clock
 * allowance absorbs request jitter when the client's ticks run ahead of real time.
 */
export const COIN_TRAVEL = { maxSpeed: 0.5, slack: 0.02, clockAllowanceMs: 250 } as const;

/** A crate pose may run ahead of its ride by this much (3.2 step 8). */
export const CRATE_SLACK = { z: 0.01, elapsedMs: 1_000 } as const;

/** By then the pile has always pushed a crate off, so a longer ride is not one CrateRide made. */
export const CRATE_MAX_RIDE_SECONDS = rateEnvelopeDerivation.crateFallSeconds.max;

/** The block's peak forward speed: smoothstep's peak slope is 1.5 times its mean. */
const PUSHER_PEAK_SPEED =
  (1.5 * DEFAULT_PUSHER_MOTION.stroke) /
  ((DEFAULT_PUSHER_MOTION.pushFraction * DEFAULT_PUSHER_MOTION.periodTicks) / SIM_TICKS_PER_SECOND);
const CRATE_MAX_SPEED = CRATE_RIDE.carry * PUSHER_PEAK_SPEED + CRATE_RIDE.creepPerSecond;

export const SNAPSHOT_FLAG_KINDS = [
  'snapshot.foreign',
  'snapshot.teleport',
  'snapshot.implausible',
] as const;
export type SnapshotFlagKind = (typeof SNAPSHOT_FLAG_KINDS)[number];

export interface StoredTableSnapshot {
  readonly session: TableSessionId;
  readonly seq: number;
  readonly tick: Tick;
  readonly pusherTick: number;
  readonly poses: readonly PoseTuple[];
  readonly cratePoses: readonly CratePoseTuple[];
  readonly receivedAt: EpochMs;
}

interface SnapshotRow extends Record<string, SqlStorageValue> {
  session: string;
  seq: number;
  tick: number;
  pusher_tick: number;
  poses: string;
  crate_poses: string;
  received_at: number;
}

const StoredRowSchema = z.object({
  session: TableSessionIdSchema,
  seq: z.int().nonnegative(),
  tick: z.int().nonnegative(),
  pusher_tick: z.int().nonnegative(),
  poses: z.array(PoseTupleSchema),
  crate_poses: z.array(CratePoseTupleSchema),
  received_at: z.int(),
});

export function readTableSnapshot(sql: SqlStorage): StoredTableSnapshot | null {
  const row = sql
    .exec<SnapshotRow>(
      'SELECT session, seq, tick, pusher_tick, poses, crate_poses, received_at FROM table_snapshot WHERE id = 1',
    )
    .toArray()[0];
  if (row === undefined) return null;
  const parsed = StoredRowSchema.safeParse({
    ...row,
    poses: JSON.parse(row.poses) as unknown,
    crate_poses: JSON.parse(row.crate_poses) as unknown,
  });
  if (!parsed.success) {
    throw new Error(`The stored table snapshot is corrupt: ${parsed.error.message}`);
  }
  const stored = parsed.data;
  return {
    session: stored.session,
    seq: stored.seq,
    tick: stored.tick,
    pusherTick: stored.pusher_tick,
    poses: stored.poses,
    cratePoses: stored.crate_poses,
    receivedAt: stored.received_at,
  };
}

export function writeTableSnapshot(sql: SqlStorage, snapshot: StoredTableSnapshot): void {
  sql.exec(
    `INSERT INTO table_snapshot
       (id, session, seq, tick, pusher_tick, poses, crate_poses, coin_count, received_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       session = excluded.session, seq = excluded.seq, tick = excluded.tick,
       pusher_tick = excluded.pusher_tick, poses = excluded.poses,
       crate_poses = excluded.crate_poses, coin_count = excluded.coin_count,
       received_at = excluded.received_at`,
    snapshot.session,
    snapshot.seq,
    snapshot.tick,
    snapshot.pusherTick,
    JSON.stringify(snapshot.poses),
    JSON.stringify(snapshot.cratePoses),
    snapshot.poses.length,
    snapshot.receivedAt,
  );
}

/** The wire tuple as the sim's pose, under the sim id the client restores it with. */
export function toCoinPose(tuple: PoseTuple, simId: number): CoinPose {
  const [, x, y, z, qx, qy, qz, qw, rest] = tuple;
  return { id: simId, p: [x, y, z], q: [qx, qy, qz, qw], rest };
}

export function toCratePose(tuple: CratePoseTuple): CratePose {
  const [, x, z, elapsedMs, phase] = tuple;
  return { x, z, elapsedMs, phase };
}

/** Where a crate with no stored pose starts: the chute, at the start of its ride. */
export const CHUTE_POSE: CratePose = {
  x: 0,
  z: Math.round(CRATE_RIDE.spawnZ / POSITION_UNIT),
  elapsedMs: 0,
  phase: 'riding',
};

/**
 * The seconds a snapshot may claim passed since `since`: what its ticks say, but never more
 * than the server's clock saw (plus jitter), so a client cannot fast-forward its ticks to
 * buy a longer move. A clock that stepped back counts as no time.
 */
export function elapsedSeconds(ticks: number, since: EpochMs, now: EpochMs): number {
  const byTicks = Math.max(0, ticks) / SIM_TICKS_PER_SECOND;
  const byClock = (Math.max(0, now - since) + COIN_TRAVEL.clockAllowanceMs) / 1000;
  return Math.min(byTicks, byClock);
}

export function withinCoinTravel(from: PoseTuple, to: PoseTuple, seconds: number): boolean {
  const dx = (to[1] - from[1]) * POSITION_UNIT;
  const dy = (to[2] - from[2]) * POSITION_UNIT;
  const dz = (to[3] - from[3]) * POSITION_UNIT;
  return Math.hypot(dx, dy, dz) <= COIN_TRAVEL.maxSpeed * seconds + COIN_TRAVEL.slack;
}

/** A crate only rides forward, no faster than the pusher carries it, and ages with real time. */
export function withinCrateRide(from: CratePose, to: CratePose, seconds: number): boolean {
  const dz = (to.z - from.z) * POSITION_UNIT;
  const maxDz = CRATE_MAX_SPEED * seconds + CRATE_RIDE.nudgeForward + CRATE_SLACK.z;
  const dElapsed = to.elapsedMs - from.elapsedMs;
  return (
    dz >= 0 && dz <= maxDz && dElapsed >= 0 && dElapsed <= seconds * 1000 + CRATE_SLACK.elapsedMs
  );
}

export interface TokenBucket {
  readonly tokens: number;
  readonly at: EpochMs;
}

export type TokenTake =
  | { readonly ok: true; readonly bucket: TokenBucket }
  | { readonly ok: false; readonly retryAfterMs: number };

/**
 * Takes one snapshot token. The bucket refills by server time only, and `at` never moves
 * back, so stepping the clock backwards earns nothing.
 */
export function takeSnapshotToken(bucket: TokenBucket | null, now: EpochMs): TokenTake {
  const { intervalMs, burst } = SNAPSHOT_RATE;
  const at = bucket === null ? now : Math.max(bucket.at, now);
  const refill = bucket === null ? burst : Math.max(0, now - bucket.at) / intervalMs;
  const tokens = Math.min(burst, (bucket?.tokens ?? 0) + refill);
  if (tokens < 1) return { ok: false, retryAfterMs: Math.ceil((1 - tokens) * intervalMs) };
  return { ok: true, bucket: { tokens: tokens - 1, at } };
}

export function countSnapshotFlag(
  sql: SqlStorage,
  kind: SnapshotFlagKind,
  count: number,
  now: EpochMs,
): void {
  if (count === 0) return;
  sql.exec(
    `INSERT INTO snapshot_flags (kind, count, first_at, last_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (kind) DO UPDATE SET
       count = snapshot_flags.count + excluded.count,
       last_at = MAX(snapshot_flags.last_at, excluded.last_at)`,
    kind,
    count,
    now,
    now,
  );
}

export function snapshotFlags(sql: SqlStorage): Record<SnapshotFlagKind, number> {
  const counts: Record<SnapshotFlagKind, number> = {
    'snapshot.foreign': 0,
    'snapshot.teleport': 0,
    'snapshot.implausible': 0,
  };
  for (const row of sql
    .exec<{ kind: SnapshotFlagKind; count: number }>('SELECT kind, count FROM snapshot_flags')
    .toArray()) {
    counts[row.kind] = row.count;
  }
  return counts;
}
