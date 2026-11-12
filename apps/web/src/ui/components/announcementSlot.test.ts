import { describe, expect, it } from 'vitest';
import { announcementHoldFor, createAnnouncementHold } from './announcementHold.ts';
import {
  announcementSlotFor,
  CALLOUT_PRIORITY,
  createAnnouncementSlot,
  type Callout,
} from './announcementSlot.ts';

describe('createAnnouncementSlot', () => {
  it('ranks the crate hint over the rank stamp over the upgrade nudge', () => {
    const order: readonly Callout[] = CALLOUT_PRIORITY;
    const at = (callout: Callout) => order.indexOf(callout);
    expect(at('crate-hint')).toBeLessThan(at('rank-stamp'));
    expect(at('rank-stamp')).toBeLessThan(at('upgrade-nudge'));
    expect(at('crate-on-table')).toBeLessThan(at('upgrade-nudge'));
    expect(at('rank-stamp')).toBeLessThan(at('crate-on-table'));
  });

  it('starts free for every callout', () => {
    const slot = createAnnouncementSlot(createAnnouncementHold());
    for (const callout of CALLOUT_PRIORITY) expect(slot.outranked(callout)).toBe(false);
  });

  it('quiets only the callouts ranked below a claim', () => {
    const slot = createAnnouncementSlot(createAnnouncementHold());
    const release = slot.claim('rank-stamp');
    expect(slot.outranked('crate-hint')).toBe(false);
    expect(slot.outranked('rank-stamp')).toBe(false);
    expect(slot.outranked('crate-on-table')).toBe(true);
    expect(slot.outranked('upgrade-nudge')).toBe(true);
    release();
    expect(slot.outranked('upgrade-nudge')).toBe(false);
  });

  it('keeps the rank stamp quiet under the crate hint but not under a crate on the table', () => {
    const slot = createAnnouncementSlot(createAnnouncementHold());
    const table = slot.claim('crate-on-table');
    expect(slot.outranked('rank-stamp')).toBe(false);
    expect(slot.outranked('upgrade-nudge')).toBe(true);
    const hint = slot.claim('crate-hint');
    expect(slot.outranked('rank-stamp')).toBe(true);
    hint();
    table();
    expect(slot.outranked('upgrade-nudge')).toBe(false);
  });

  it('lets the cinematic hold outrank every callout', () => {
    const hold = createAnnouncementHold();
    const slot = createAnnouncementSlot(hold);
    const release = hold.hold();
    for (const callout of CALLOUT_PRIORITY) expect(slot.outranked(callout)).toBe(true);
    release();
    expect(slot.outranked('crate-hint')).toBe(false);
  });

  it('nests claims and counts each release once', () => {
    const slot = createAnnouncementSlot(createAnnouncementHold());
    const first = slot.claim('crate-hint');
    const second = slot.claim('crate-hint');
    first();
    first();
    expect(slot.outranked('rank-stamp')).toBe(true);
    second();
    expect(slot.outranked('rank-stamp')).toBe(false);
  });

  it('tells a quiet view only about its own changes', () => {
    const hold = createAnnouncementHold();
    const slot = createAnnouncementSlot(hold);
    const changes: boolean[] = [];
    const stop = slot.quietFor('upgrade-nudge').onChange((held) => changes.push(held));
    const stamp = slot.claim('rank-stamp');
    const hint = slot.claim('crate-hint');
    const cinematic = hold.hold();
    stamp();
    hint();
    expect(changes).toEqual([true]);
    cinematic();
    expect(changes).toEqual([true, false]);
    stop();
    slot.claim('rank-stamp');
    expect(changes).toEqual([true, false]);
  });

  it('reads the live answer through a quiet view', () => {
    const slot = createAnnouncementSlot(createAnnouncementHold());
    const quiet = slot.quietFor('rank-stamp');
    expect(quiet.held).toBe(false);
    const release = slot.claim('crate-hint');
    expect(quiet.held).toBe(true);
    release();
    expect(quiet.held).toBe(false);
  });
});

describe('announcementSlotFor', () => {
  it('shares one slot per hold', () => {
    const owner = {};
    const hold = announcementHoldFor(owner);
    expect(announcementSlotFor(hold)).toBe(announcementSlotFor(announcementHoldFor(owner)));
    expect(announcementSlotFor(hold)).not.toBe(announcementSlotFor(createAnnouncementHold()));
  });
});
