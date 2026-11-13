import {
  MAX_SNAPSHOT_COINS,
  MAX_SNAPSHOT_CRATES,
  TableSnapshotRequestSchema,
  type CoinId,
  type CrateId,
  type TableSessionId,
} from '@coinposh/shared';
import {
  SIM_SNAPSHOT_VERSION,
  validateSnapshot,
  type CoinPose,
  type CratePose,
} from '@coinposh/sim/snapshot';
import { describe, expect, it } from 'vitest';
import type { SimBridgeSnapshot } from '../simWorker/index.ts';
import { createTableCapture, type CapturedRide } from './capture.ts';

const FLAT: CoinPose['q'] = [0, 0, 0, 32767];
const coinId = (n: number): CoinId => `coin_${'A'.repeat(15)}${String(n)}` as CoinId;
const crateId = (n: number): CrateId => `crate_${'B'.repeat(14)}${String(n)}` as CrateId;

/** A coin lying flat on the lower tier, `slot` coin widths along the lip. */
function resting(id: number, slot: number, rest: CoinPose['rest'] = 'asleep'): CoinPose {
  return { id, p: [-16000 + slot * 3200, 152, 4400], q: FLAT, rest };
}

function sampled(
  coins: readonly CoinPose[],
  tick = 600,
  pusherTickInCycle = 180,
): SimBridgeSnapshot {
  return { tick, table: { version: SIM_SNAPSHOT_VERSION, pusherTickInCycle, coins } };
}

function ride(
  n: number,
  pose: CratePose,
  phase: CapturedRide['phase'] = pose.phase,
): CapturedRide & {
  snapshots: number;
} {
  return {
    crate: { id: crateId(n) },
    phase,
    snapshots: 0,
    snapshot() {
      this.snapshots += 1;
      return pose;
    },
  };
}

const CRATE: CratePose = { x: 1200, z: -2000, elapsedMs: 4200, phase: 'riding' };

describe('createTableCapture', () => {
  it('has nothing to capture before the first sample lands', () => {
    const capture = createTableCapture({
      sample: () => new Promise(() => undefined),
      coinOf: () => null,
      crates: () => [],
    });
    void capture.refresh();
    expect(capture.capture()).toBeNull();
  });

  it('names each sim body by its server coin and keeps the sample tick and pusher phase', async () => {
    const coins = [resting(0, 0), resting(1, 1, 'awake'), resting(2, 2)];
    expect(validateSnapshot(sampled(coins).table).dropped).toEqual([]);
    const capture = createTableCapture({
      sample: () => Promise.resolve(sampled(coins, 612.6, 180)),
      coinOf: (simId) => coinId(simId + 100),
      crates: () => [],
    });
    await capture.refresh();
    expect(capture.capture()).toEqual({
      tick: 612,
      pusher: { tickInCycle: 180 },
      coins: [
        [coinId(100), -16000, 152, 4400, 0, 0, 0, 32767, 'asleep'],
        [coinId(101), -12800, 152, 4400, 0, 0, 0, 32767, 'awake'],
        [coinId(102), -9600, 152, 4400, 0, 0, 0, 32767, 'asleep'],
      ],
      crates: [],
    });
  });

  it('leaves out coins the server would drop, coins it never minted and coins gone since the sample', async () => {
    const coins = [
      resting(0, 0),
      { ...resting(1, 0), id: 1 },
      resting(2, 2, 'frozen'),
      { id: 3, p: [99_000, 152, 4400], q: FLAT, rest: 'asleep' } satisfies CoinPose,
      resting(4, 4),
      resting(5, 6),
    ];
    const held = new Map([
      [0, coinId(1)],
      [1, coinId(2)],
      [2, coinId(3)],
      [3, coinId(4)],
      [4, coinId(5)],
    ]);
    const capture = createTableCapture({
      sample: () => Promise.resolve(sampled(coins)),
      coinOf: (simId) => held.get(simId) ?? null,
      crates: () => [],
    });
    await capture.refresh();
    held.delete(4);
    expect(capture.capture()?.coins.map(([id]) => id)).toEqual([coinId(1)]);
  });

  it('reads crates live, skips a fallen one and never poses more than the contract allows', async () => {
    const rides = [
      ride(1, CRATE),
      ride(2, CRATE, 'fell'),
      ...Array.from({ length: MAX_SNAPSHOT_CRATES + 2 }, (_, i) => ride(10 + i, CRATE)),
    ];
    const capture = createTableCapture({
      sample: () => Promise.resolve(sampled([])),
      coinOf: () => null,
      crates: () => rides,
    });
    await capture.refresh();
    const crates = capture.capture()?.crates ?? [];
    expect(crates).toHaveLength(MAX_SNAPSHOT_CRATES);
    expect(crates[0]).toEqual([crateId(1), 1200, -2000, 4200, 'riding']);
    expect(rides[1]?.snapshots).toBe(0);
    expect(crates.map(([id]) => id)).not.toContain(crateId(2));
  });

  it('caps the coins at the snapshot contract and yields a request the contract accepts', async () => {
    const coins = Array.from({ length: MAX_SNAPSHOT_COINS + 30 }, (_, i) => ({
      id: i,
      p: [-17000 + (i % 12) * 3000, 152 + Math.floor(i / 12) * 400, 4400] as const,
      q: FLAT,
      rest: 'awake' as const,
    }));
    const capture = createTableCapture({
      sample: () => Promise.resolve(sampled(coins)),
      coinOf: (simId) => coinId(simId),
      crates: () => [ride(1, CRATE)],
    });
    await capture.refresh();
    const taken = capture.capture();
    expect(taken).not.toBeNull();
    if (taken === null) return;
    expect(taken.coins.length).toBeLessThanOrEqual(MAX_SNAPSHOT_COINS);
    const request = TableSnapshotRequestSchema.safeParse({
      session: 'session_AAAAAAAAAAAAAAAAAAAAAA' as TableSessionId,
      seq: 1,
      tick: taken.tick,
      pusher: taken.pusher,
      coins: taken.coins,
      crates: taken.crates,
    });
    expect(request.success ? null : request.error.issues).toBeNull();
  });

  it('shares one sample in flight between callers and samples again once it lands', async () => {
    let calls = 0;
    let land: (() => void) | null = null;
    const capture = createTableCapture({
      sample: () => {
        calls += 1;
        return new Promise((resolve) => {
          land = () => {
            resolve(sampled([resting(0, 0)], calls * 100));
          };
        });
      },
      coinOf: () => coinId(1),
      crates: () => [],
    });
    const first = capture.refresh();
    const second = capture.refresh();
    expect(first).toBe(second);
    expect(calls).toBe(1);
    (land as (() => void) | null)?.();
    await first;
    expect(capture.capture()?.tick).toBe(100);
    const third = capture.refresh();
    expect(calls).toBe(2);
    (land as (() => void) | null)?.();
    await third;
    expect(capture.capture()?.tick).toBe(200);
  });

  it('passes on a sample that failed and keeps the last good one', async () => {
    let fail = false;
    const capture = createTableCapture({
      sample: () =>
        fail
          ? Promise.reject(new Error('SimBridge.snapshot: the bridge has been disposed'))
          : Promise.resolve(sampled([resting(0, 0)])),
      coinOf: () => coinId(7),
      crates: () => [],
    });
    await capture.refresh();
    fail = true;
    await expect(capture.refresh()).rejects.toThrow(/disposed/);
    expect(capture.capture()?.coins).toHaveLength(1);
  });
});
