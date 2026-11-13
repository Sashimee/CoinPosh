import {
  MAX_SNAPSHOT_COINS,
  MAX_SNAPSHOT_CRATES,
  type CoinId,
  type CratePoseTuple,
  type CrateId,
  type PoseTuple,
} from '@coinposh/shared';
import { validateSnapshot, type CratePose } from '@coinposh/sim/snapshot';
import type { SnapshotCapture } from '../../net/index.ts';
import type { SimBridgeSnapshot } from '../simWorker/index.ts';

/** A crate ride as the capture reads it: `CrateRide` satisfies it. */
export interface CapturedRide {
  readonly crate: { readonly id: CrateId };
  readonly phase: 'riding' | 'teeter' | 'fell';
  snapshot(): CratePose;
}

export interface TableCaptureDeps {
  /** One sample of where the sim's bodies rest (`SimBridge.snapshot`). */
  readonly sample: () => Promise<SimBridgeSnapshot>;
  /** The server coin a sim body is, or null when the table no longer holds it. */
  readonly coinOf: (simId: number) => CoinId | null;
  readonly crates: () => readonly CapturedRide[];
}

export interface TableCapture {
  /** Takes a fresh sample; one is in flight at a time, so a second call shares the first. */
  refresh(): Promise<void>;
  /** The latest sample as the server takes it, or null before the first one landed. */
  capture(): SnapshotCapture | null;
}

type PoseTail = PoseTuple extends readonly [CoinId, ...infer Tail] ? Tail : never;

interface Sample {
  readonly tick: number;
  readonly tickInCycle: number;
  /** Poses the server can accept, by sim id, in ascending id order. */
  readonly poses: readonly { readonly simId: number; readonly pose: PoseTail }[];
}

/**
 * Reads the table for a snapshot upload. The cadence asks for a capture synchronously, while the
 * sim lives in a worker, so the coins come from the latest sample; each is named at capture time,
 * which leaves out a coin that fell or fused since the sample was taken. Poses `validateSnapshot`
 * would drop are left out here, since the server drops them anyway. Crates are read live, as
 * their rides run on the main thread.
 */
export function createTableCapture(deps: TableCaptureDeps): TableCapture {
  let latest: Sample | null = null;
  let inFlight: Promise<void> | null = null;

  const take = async (): Promise<void> => {
    const { tick, table } = await deps.sample();
    const { ok } = validateSnapshot(table);
    const poses: { simId: number; pose: PoseTail }[] = [];
    for (const pose of ok) {
      if (pose.rest === 'frozen') continue;
      const [x, y, z] = pose.p;
      const [qx, qy, qz, qw] = pose.q;
      poses.push({ simId: pose.id, pose: [x, y, z, qx, qy, qz, qw, pose.rest] });
    }
    latest = { tick: Math.max(0, Math.floor(tick)), tickInCycle: table.pusherTickInCycle, poses };
  };

  const crateTuples = (): CratePoseTuple[] => {
    const tuples: CratePoseTuple[] = [];
    for (const ride of deps.crates()) {
      if (tuples.length >= MAX_SNAPSHOT_CRATES) break;
      if (ride.phase === 'fell') continue;
      const { x, z, elapsedMs, phase } = ride.snapshot();
      tuples.push([ride.crate.id, x, z, elapsedMs, phase]);
    }
    return tuples;
  };

  return {
    refresh() {
      inFlight ??= take().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    capture() {
      if (latest === null) return null;
      const coins: PoseTuple[] = [];
      for (const { simId, pose } of latest.poses) {
        if (coins.length >= MAX_SNAPSHOT_COINS) break;
        const id = deps.coinOf(simId);
        if (id === null) continue;
        coins.push([id, ...pose]);
      }
      return {
        tick: latest.tick,
        pusher: { tickInCycle: latest.tickInCycle },
        coins,
        crates: crateTuples(),
      };
    },
  };
}
