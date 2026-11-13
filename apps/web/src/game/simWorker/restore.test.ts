import { COIN, PUSHER } from '@coinposh/sim/layout';
import { checkPose, POSITION_UNIT, ROTATION_UNIT, type CoinPose } from '@coinposh/sim/snapshot';
import { describe, expect, it } from 'vitest';
import { assertRestore, type RestoreLimits } from './restore.ts';
import type { RestoreEntry } from './sim-api.ts';

const LIMITS: RestoreLimits = { heapCapacity: 12, capacity: 8 };

/** A flat coin resting on the floor of the lower tier, `xMm` across. */
function flat(id: number, xMm: number): CoinPose {
  return {
    id,
    p: [Math.round(xMm / 1000 / POSITION_UNIT), Math.round(COIN.halfThickness / POSITION_UNIT), 0],
    q: [0, 0, 0, ROTATION_UNIT],
    rest: 'asleep',
  };
}

function restore(coins: readonly unknown[], pusherTickInCycle: unknown = 0): unknown {
  return { pusherTickInCycle, coins };
}

describe('assertRestore', () => {
  it('accepts poses validateSnapshot keeps mixed with free heap slots, with or without tiers', () => {
    const pose = flat(40, 0);
    expect(checkPose(pose, 17)).toEqual({ ok: true });
    const coins: RestoreEntry[] = [
      { kind: 'pose', pose, tier: 'gold' },
      { kind: 'heapSlot', slot: 0 },
      { kind: 'pose', pose: flat(7, 60) },
      { kind: 'heapSlot', slot: LIMITS.heapCapacity - 1, tier: 'copper' },
    ];
    expect(() => {
      assertRestore(restore(coins, 17), LIMITS);
    }).not.toThrow();
    expect(() => {
      assertRestore(restore([], PUSHER.periodTicks - 1), LIMITS);
    }).not.toThrow();
  });

  it('refuses every malformed table, naming the field and the entry at fault', () => {
    const slots = (n: number): RestoreEntry[] =>
      Array.from({ length: n }, (_, slot) => ({ kind: 'heapSlot', slot }));
    const cases: [unknown, RegExp][] = [
      [null, /init\.restore must be an object, got null/],
      [restore([], -1), /pusherTickInCycle must be an integer in \[0, \d+\), got -1/],
      [restore([], PUSHER.periodTicks), /pusherTickInCycle must be an integer/],
      [restore([], 1.5), /pusherTickInCycle must be an integer/],
      [{ pusherTickInCycle: 0 }, /init\.restore\.coins must be an array/],
      [restore(slots(9)), /holds 9 coins but a frame carries 8; raise SimBridgeOptions\.capacity/],
      [restore([7]), /coins\[0\] must be an object, got 7/],
      [restore([{ kind: 'crate' }]), /coins\[0\]\.kind must be "pose" or "heapSlot", got "crate"/],
      [
        restore([{ kind: 'heapSlot', slot: 12 }]),
        /coins\[0\]\.slot must be an integer in \[0, 12\), got 12/,
      ],
      [restore([{ kind: 'heapSlot', slot: -1 }]), /coins\[0\]\.slot must be an integer/],
      [restore([{ kind: 'heapSlot' }]), /coins\[0\]\.slot must be an integer.*got undefined/],
      [
        restore([
          { kind: 'heapSlot', slot: 3 },
          { kind: 'heapSlot', slot: 3 },
        ]),
        /coins\[1\] repeats heap slot 3/,
      ],
      [
        restore([{ kind: 'heapSlot', slot: 0, tier: 'tin' }]),
        /coins\[0\]\.tier must be one of copper, .*got "tin"/,
      ],
      [
        restore([
          { kind: 'pose', pose: flat(4, 0) },
          { kind: 'pose', pose: flat(4, 60) },
        ]),
        /coins\[1\] repeats the pose id 4 of entry 0/,
      ],
      [
        restore([
          { kind: 'heapSlot', slot: 0 },
          { kind: 'pose', pose: { ...flat(9, 0), p: [0, 0, 999_999] } },
        ]),
        /drops \(coins\[1\] \(id 9\): out_of_bounds\); filter them with validateSnapshot/,
      ],
      [
        restore([{ kind: 'pose', pose: { ...flat(2, 0), q: [0, 0, 0, 30000] } }]),
        /coins\[0\] \(id 2\): bad_rotation/,
      ],
      [
        restore([{ kind: 'pose', pose: { ...flat(3, 0), rest: 'frozen' } }]),
        /coins\[0\] \(id 3\): frozen_unsupported/,
      ],
      [
        restore([
          { kind: 'pose', pose: flat(1, 0) },
          { kind: 'pose', pose: flat(2, 1) },
        ]),
        /coins\[1\] \(id 2\): overlap/,
      ],
      [restore([{ kind: 'pose', pose: { id: 'x' } }]), /a malformed pose: non_finite/],
    ];
    for (const [table, error] of cases) {
      expect(() => {
        assertRestore(table, LIMITS);
      }, JSON.stringify(table)).toThrow(error);
    }
  });
});
