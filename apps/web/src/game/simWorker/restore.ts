import { COIN_TIERS } from '@coinposh/shared';
import {
  type CoinPose,
  DEFAULT_PUSHER_MOTION,
  SIM_SNAPSHOT_VERSION,
  validateSnapshot,
} from '@coinposh/sim/snapshot';
import type { SimRestore } from './sim-api.ts';

export interface RestoreLimits {
  /** The most heap slots the worker's Sim lays (Sim.heapCapacity). */
  readonly heapCapacity: number;
  /** The most coins one frame carries (init.capacity). */
  readonly capacity: number;
}

/**
 * Checks an init's `restore` as data of any shape, so a table the page assembled from the
 * server's `layout` is refused with the entry at fault named, before the worker builds a
 * Sim: the pusher phase lies in its cycle, every entry is a `pose` that validateSnapshot
 * keeps or a `heapSlot` the heap has and no other entry took, every tier is on the ladder,
 * and every coin fits in a frame. The server filters poses before it hands them out, so
 * any failure here is a bug upstream and must be loud.
 */
export function assertRestore(
  restore: unknown,
  { heapCapacity, capacity }: RestoreLimits,
): asserts restore is SimRestore {
  if (typeof restore !== 'object' || restore === null) {
    throw new TypeError(`init.restore must be an object, got ${JSON.stringify(restore)}`);
  }
  const { pusherTickInCycle, coins } = restore as Partial<Record<keyof SimRestore, unknown>>;
  const { periodTicks } = DEFAULT_PUSHER_MOTION;
  if (
    typeof pusherTickInCycle !== 'number' ||
    !Number.isInteger(pusherTickInCycle) ||
    pusherTickInCycle < 0 ||
    pusherTickInCycle >= periodTicks
  ) {
    throw new RangeError(
      `init.restore.pusherTickInCycle must be an integer in [0, ${periodTicks}), got ${JSON.stringify(pusherTickInCycle)}`,
    );
  }
  if (!Array.isArray(coins)) {
    throw new TypeError('init.restore.coins must be an array of pose and heapSlot entries');
  }
  if (coins.length > capacity) {
    throw new RangeError(
      `init.restore.coins holds ${coins.length} coins but a frame carries ${capacity}; raise SimBridgeOptions.capacity`,
    );
  }
  const poses: unknown[] = [];
  const entryOfId = new Map<unknown, number>();
  const slots = new Set<number>();
  (coins as unknown[]).forEach((entry, i) => {
    const where = `init.restore.coins[${i}]`;
    if (typeof entry !== 'object' || entry === null) {
      throw new TypeError(`${where} must be an object, got ${JSON.stringify(entry)}`);
    }
    const { kind, tier, slot, pose } = entry as Partial<Record<string, unknown>>;
    if (tier !== undefined && !(COIN_TIERS as readonly unknown[]).includes(tier)) {
      throw new RangeError(
        `${where}.tier must be one of ${COIN_TIERS.join(', ')}, got ${JSON.stringify(tier)}`,
      );
    }
    if (kind === 'pose') {
      const id = typeof pose === 'object' && pose !== null ? (pose as { id?: unknown }).id : null;
      if (entryOfId.has(id)) {
        throw new RangeError(
          `${where} repeats the pose id ${JSON.stringify(id)} of entry ${entryOfId.get(id)}`,
        );
      }
      entryOfId.set(id, i);
      poses.push(pose);
      return;
    }
    if (kind !== 'heapSlot') {
      throw new TypeError(
        `${where}.kind must be "pose" or "heapSlot", got ${JSON.stringify(kind)}`,
      );
    }
    if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 0 || slot >= heapCapacity) {
      throw new RangeError(
        `${where}.slot must be an integer in [0, ${heapCapacity}), got ${JSON.stringify(slot)}`,
      );
    }
    if (slots.has(slot)) throw new RangeError(`${where} repeats heap slot ${slot}`);
    slots.add(slot);
  });
  const { dropped } = validateSnapshot({
    version: SIM_SNAPSHOT_VERSION,
    pusherTickInCycle,
    coins: poses as CoinPose[],
  });
  if (dropped.length > 0) {
    const reasons = dropped.map(({ id, reason }) => {
      const entry = Number.isNaN(id) ? undefined : entryOfId.get(id);
      const at = entry === undefined ? 'a malformed pose' : `coins[${entry}] (id ${id})`;
      return `${at}: ${reason}`;
    });
    throw new RangeError(
      `init.restore has poses validateSnapshot drops (${reasons.join(', ')}); filter them with validateSnapshot before restoring`,
    );
  }
}
