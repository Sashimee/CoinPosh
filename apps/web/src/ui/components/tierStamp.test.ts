import { cascade } from '@coinposh/economy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAnnouncementHold, type AnnouncementHold } from './announcementHold.ts';
import { createAnnouncementSlot, type AnnouncementSlot } from './announcementSlot.ts';
import {
  scheduleTierStamp,
  STAMP_HOLD_MS,
  STAMP_LEAVE_MS,
  type StampSchedule,
} from './tierStamp.ts';

interface Rig {
  readonly hold: AnnouncementHold;
  readonly slot: AnnouncementSlot;
  readonly stamp: StampSchedule;
  /** Every view call, in order; a show names its tier. */
  readonly log: string[];
  /** Whether the upgrade nudge would have to wait right now. */
  nudgeHeld(): boolean;
}

function rig(initialRank = 0): Rig {
  const hold = createAnnouncementHold();
  const slot = createAnnouncementSlot(hold);
  const log: string[] = [];
  const stamp = scheduleTierStamp(
    slot,
    {
      show: (tier) => log.push(`show ${tier.id}`),
      leave: () => log.push('leave'),
      hide: () => log.push('hide'),
      cut: () => log.push('cut'),
    },
    initialRank,
  );
  const nudge = slot.quietFor('upgrade-nudge');
  return { hold, slot, stamp, log, nudgeHeld: () => nudge.held };
}

const tierId = (rank: number): string => {
  const tier = cascade.tiers[rank - 1];
  if (!tier) throw new Error(`The cascade has no tier at rank ${rank}`);
  return tier.id;
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('scheduleTierStamp', () => {
  it('claims the slot when it stamps, so the upgrade nudge waits under it', () => {
    const r = rig();
    const nudge = r.slot.quietFor('upgrade-nudge');
    const heard: boolean[] = [];
    nudge.onChange((held) => heard.push(held));
    expect(r.nudgeHeld()).toBe(false);
    r.stamp.update(1);
    expect(r.log).toEqual([`show ${tierId(1)}`]);
    expect(r.stamp.showing).toBe(true);
    expect(r.nudgeHeld()).toBe(true);
    expect(heard).toEqual([true]);
    r.stamp.dispose();
  });

  it('frees the slot only once its hold and leave animation have both ended', () => {
    const r = rig();
    r.stamp.update(1);
    vi.advanceTimersByTime(STAMP_HOLD_MS - 1);
    expect(r.log).toEqual([`show ${tierId(1)}`]);
    vi.advanceTimersByTime(1);
    expect(r.log).toEqual([`show ${tierId(1)}`, 'leave']);
    expect(r.nudgeHeld()).toBe(true);
    vi.advanceTimersByTime(STAMP_LEAVE_MS - 1);
    expect(r.nudgeHeld()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(r.log).toEqual([`show ${tierId(1)}`, 'leave', 'hide']);
    expect(r.stamp.showing).toBe(false);
    expect(r.nudgeHeld()).toBe(false);
    r.stamp.dispose();
  });

  it('leaves early when its cascade ends and still gives the slot back', () => {
    const r = rig();
    r.stamp.update(2);
    vi.advanceTimersByTime(100);
    r.stamp.update(0);
    expect(r.log).toEqual([`show ${tierId(2)}`, 'leave']);
    vi.advanceTimersByTime(STAMP_LEAVE_MS);
    expect(r.nudgeHeld()).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(r.log).toEqual([`show ${tierId(2)}`, 'leave', 'hide']);
    r.stamp.dispose();
  });

  it('keeps one claim across a re-stamp during its leave, and lets it go after the last', () => {
    const r = rig();
    r.stamp.update(1);
    vi.advanceTimersByTime(STAMP_HOLD_MS + STAMP_LEAVE_MS / 2);
    r.stamp.update(2);
    expect(r.log).toEqual([`show ${tierId(1)}`, 'leave', `show ${tierId(2)}`]);
    vi.advanceTimersByTime(STAMP_LEAVE_MS);
    expect(r.log).not.toContain('hide');
    expect(r.nudgeHeld()).toBe(true);
    vi.advanceTimersByTime(STAMP_HOLD_MS + STAMP_LEAVE_MS);
    expect(r.log.at(-1)).toBe('hide');
    expect(r.nudgeHeld()).toBe(false);
    r.stamp.dispose();
  });

  it('cuts away the moment the crate hint claims the slot, and releases its claim', () => {
    const r = rig();
    r.stamp.update(1);
    const releaseHint = r.slot.claim('crate-hint');
    expect(r.log).toEqual([`show ${tierId(1)}`, 'cut']);
    expect(r.stamp.showing).toBe(false);
    releaseHint();
    expect(r.nudgeHeld()).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(r.log).toEqual([`show ${tierId(1)}`, 'cut']);
    r.stamp.dispose();
  });

  it('stays down under the crate hint and stamps the peak once the hint lets go', () => {
    const r = rig();
    const releaseHint = r.slot.claim('crate-hint');
    r.stamp.update(1);
    r.stamp.update(2);
    r.stamp.update(3);
    expect(r.log).toEqual([]);
    releaseHint();
    expect(r.log).toEqual([`show ${tierId(3)}`]);
    expect(r.nudgeHeld()).toBe(true);
    vi.advanceTimersByTime(STAMP_HOLD_MS + STAMP_LEAVE_MS);
    expect(r.nudgeHeld()).toBe(false);
    r.stamp.dispose();
  });

  it('does not stamp a peak the cascade has already fallen from under the hint', () => {
    const r = rig();
    const releaseHint = r.slot.claim('crate-hint');
    r.stamp.update(3);
    r.stamp.update(1);
    releaseHint();
    expect(r.log).toEqual([]);
    expect(r.nudgeHeld()).toBe(false);
    r.stamp.dispose();
  });

  it('cuts away under a crate cinematic hold and replays after it', () => {
    const r = rig();
    r.stamp.update(1);
    const release = r.hold.hold();
    expect(r.log).toEqual([`show ${tierId(1)}`, 'cut']);
    r.stamp.update(2);
    release();
    expect(r.log).toEqual([`show ${tierId(1)}`, 'cut', `show ${tierId(2)}`]);
    r.stamp.dispose();
  });

  it('is not pushed off by a crate still on the table', () => {
    const r = rig();
    const releaseTable = r.slot.claim('crate-on-table');
    r.stamp.update(1);
    expect(r.log).toEqual([`show ${tierId(1)}`]);
    vi.advanceTimersByTime(STAMP_HOLD_MS + STAMP_LEAVE_MS);
    expect(r.nudgeHeld()).toBe(true);
    releaseTable();
    expect(r.nudgeHeld()).toBe(false);
    r.stamp.dispose();
  });

  it('releases its claim when disposed mid-stamp and mid-leave', () => {
    const mid = rig();
    mid.stamp.update(1);
    vi.advanceTimersByTime(STAMP_HOLD_MS / 2);
    mid.stamp.dispose();
    expect(mid.nudgeHeld()).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(mid.log).toEqual([`show ${tierId(1)}`]);

    const leaving = rig();
    leaving.stamp.update(1);
    vi.advanceTimersByTime(STAMP_HOLD_MS + 1);
    leaving.stamp.dispose();
    expect(leaving.nudgeHeld()).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(leaving.log).toEqual([`show ${tierId(1)}`, 'leave']);
  });

  it('stops hearing the slot once disposed', () => {
    const r = rig();
    r.stamp.dispose();
    const releaseHint = r.slot.claim('crate-hint');
    r.stamp.update(2);
    releaseHint();
    expect(r.log).toEqual([]);
    expect(r.nudgeHeld()).toBe(false);
  });

  it('does not announce the rank the cascade already stood at when it mounted', () => {
    const r = rig(2);
    r.stamp.update(2);
    expect(r.log).toEqual([]);
    r.stamp.update(3);
    expect(r.log).toEqual([`show ${tierId(3)}`]);
    r.stamp.dispose();
  });

  it('ignores a rank past the last tier', () => {
    const r = rig();
    r.stamp.update(cascade.tiers.length + 1);
    expect(r.log).toEqual([]);
    expect(r.nudgeHeld()).toBe(false);
    r.stamp.dispose();
  });
});
