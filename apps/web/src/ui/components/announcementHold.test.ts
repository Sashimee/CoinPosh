import { cascade } from '@coinposh/economy';
import { describe, expect, it } from 'vitest';
import { comboView } from '../../app/model.ts';
import {
  announcementHoldFor,
  createAnnouncementHold,
  createRankGate,
  holdTierVoice,
  peakReplay,
  type PeakReplay,
  type RankAnnouncements,
} from './announcementHold.ts';

function recorder(): RankAnnouncements & { rises: number[]; replays: [number, number][] } {
  const rises: number[] = [];
  const replays: [number, number][] = [];
  return {
    rises,
    replays,
    rise: (rank) => rises.push(rank),
    replay: (peak, live) => replays.push([peak, live]),
  };
}

/** The coin count at which the cascade reaches `rank`. */
function countFor(rank: number): number {
  const tier = cascade.tiers[rank - 1];
  if (!tier) throw new Error(`economy cascade has no rank ${rank}`);
  return tier.minCoins;
}

describe('createAnnouncementHold', () => {
  it('starts free', () => {
    expect(createAnnouncementHold().held).toBe(false);
  });

  it('nests holds and frees only when the last one is released', () => {
    const hold = createAnnouncementHold();
    const changes: boolean[] = [];
    hold.onChange((held) => changes.push(held));
    const first = hold.hold();
    const second = hold.hold();
    first();
    expect(hold.held).toBe(true);
    second();
    expect(hold.held).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it('counts a release only once', () => {
    const hold = createAnnouncementHold();
    const first = hold.hold();
    const second = hold.hold();
    first();
    first();
    expect(hold.held).toBe(true);
    second();
    expect(hold.held).toBe(false);
  });

  it('stops notifying a listener once it unsubscribes', () => {
    const hold = createAnnouncementHold();
    const changes: boolean[] = [];
    const off = hold.onChange((held) => changes.push(held));
    off();
    hold.hold()();
    expect(changes).toEqual([]);
  });

  it('shares one hold per owner and keeps owners apart', () => {
    const a = {};
    const b = {};
    expect(announcementHoldFor(a)).toBe(announcementHoldFor(a));
    const release = announcementHoldFor(a).hold();
    expect(announcementHoldFor(b).held).toBe(false);
    release();
  });
});

describe('createRankGate', () => {
  it('announces every rise while free, and nothing for a drop or a repeat', () => {
    const calls = recorder();
    const gate = createRankGate(createAnnouncementHold(), calls);
    for (const rank of [1, 1, 2, 3, 0, 1]) gate.update(rank);
    expect(calls.rises).toEqual([1, 2, 3, 1]);
    expect(calls.replays).toEqual([]);
  });

  it('holds rises and replays only the highest rank once the hold ends', () => {
    const hold = createAnnouncementHold();
    const calls = recorder();
    const gate = createRankGate(hold, calls);
    const release = hold.hold();
    for (const rank of [1, 2, 3, 4]) gate.update(rank);
    expect(calls.rises).toEqual([]);
    release();
    expect(calls.replays).toEqual([[4, 4]]);
    expect(calls.rises).toEqual([]);
  });

  it('replays the peak even when the cascade has ended under the hold', () => {
    const hold = createAnnouncementHold();
    const calls = recorder();
    const gate = createRankGate(hold, calls);
    const release = hold.hold();
    gate.update(1);
    gate.update(3);
    gate.update(0);
    release();
    expect(calls.replays).toEqual([[3, 0]]);
  });

  it('replays nothing when no rank rose during the hold', () => {
    const hold = createAnnouncementHold();
    const calls = recorder();
    const gate = createRankGate(hold, calls);
    gate.update(2);
    const release = hold.hold();
    gate.update(2);
    gate.update(1);
    release();
    expect(calls.rises).toEqual([2]);
    expect(calls.replays).toEqual([]);
  });

  it('replays once per hold, and announces live again afterwards', () => {
    const hold = createAnnouncementHold();
    const calls = recorder();
    const gate = createRankGate(hold, calls);
    const first = hold.hold();
    gate.update(2);
    first();
    hold.hold()();
    gate.update(3);
    expect(calls.replays).toEqual([[2, 2]]);
    expect(calls.rises).toEqual([3]);
  });

  it('waits for nested holds before replaying', () => {
    const hold = createAnnouncementHold();
    const calls = recorder();
    const gate = createRankGate(hold, calls);
    const crate = hold.hold();
    const next = hold.hold();
    gate.update(2);
    crate();
    gate.update(5);
    expect(calls.replays).toEqual([]);
    next();
    expect(calls.replays).toEqual([[5, 5]]);
  });

  it('starts from a rank already reached', () => {
    const calls = recorder();
    const gate = createRankGate(createAnnouncementHold(), calls, 2);
    gate.update(2);
    gate.update(3);
    expect(calls.rises).toEqual([3]);
  });

  it('stops replaying once disposed', () => {
    const hold = createAnnouncementHold();
    const calls = recorder();
    const gate = createRankGate(hold, calls);
    const release = hold.hold();
    gate.update(2);
    gate.dispose();
    release();
    expect(calls.replays).toEqual([]);
  });

  it('keeps the live rank, and so the credited multiplier, counting under a hold', () => {
    const counts = Array.from({ length: countFor(cascade.tiers.length) + 3 }, (_, i) => i + 1);
    const free = createRankGate(createAnnouncementHold(), recorder());
    const hold = createAnnouncementHold();
    const held = createRankGate(hold, recorder());
    const release = hold.hold();
    for (const count of counts) {
      const view = comboView(count, cascade);
      free.update(view.rank);
      held.update(view.rank);
      expect(held.live).toBe(free.live);
      expect(cascade.tiers[held.live - 1]?.multiplier ?? 1).toBe(view.multiplier);
    }
    release();
    expect(held.live).toBe(cascade.tiers.length);
  });
});

describe('peakReplay', () => {
  it('stamps a peak the cascade still stands at', () => {
    expect(peakReplay(3, 3)).toBe('stamp');
  });

  it('pulses a peak whose cascade has ended', () => {
    expect(peakReplay(3, 0)).toBe('pulse');
  });

  it('pulses a peak the cascade has fallen from but not left', () => {
    expect(peakReplay(4, 2)).toBe('pulse');
  });

  it('stamps when the live rank stands above the peak', () => {
    expect(peakReplay(2, 3)).toBe('stamp');
  });

  it('routes a hold that ends mid-cascade to the stamp and one that outlives it to the pulse', () => {
    const hold = createAnnouncementHold();
    const shown: PeakReplay[] = [];
    const gate = createRankGate(hold, {
      rise: () => undefined,
      replay: (peak, live) => shown.push(peakReplay(peak, live)),
    });
    const crate = hold.hold();
    for (const count of [1, countFor(2), countFor(3)]) gate.update(comboView(count, cascade).rank);
    crate();
    const next = hold.hold();
    gate.update(comboView(countFor(4), cascade).rank);
    gate.update(comboView(0, cascade).rank);
    next();
    expect(shown).toEqual(['stamp', 'pulse']);
  });
});

/** Voices tiers the way the audio engine does: only a rise above the current tier chimes. */
class FakeVoice {
  tier = 0;
  readonly chimes: number[] = [];
  setComboTier(tier: number): void {
    if (tier > this.tier) this.chimes.push(tier);
    this.tier = tier;
  }
}

describe('holdTierVoice', () => {
  it('passes rises and the cascade end straight through while free', () => {
    const voice = new FakeVoice();
    const held = holdTierVoice(() => voice, createAnnouncementHold());
    for (const tier of [1, 2, 3, 0, 1]) held.setComboTier(tier);
    expect(voice.chimes).toEqual([1, 2, 3, 1]);
    expect(voice.tier).toBe(1);
  });

  it('chimes only the highest held tier, once, and leaves the voice on the live tier', () => {
    const voice = new FakeVoice();
    const hold = createAnnouncementHold();
    const held = holdTierVoice(() => voice, hold);
    held.setComboTier(1);
    const release = hold.hold();
    for (const tier of [2, 3, 4]) held.setComboTier(tier);
    expect(voice.chimes).toEqual([1]);
    release();
    expect(voice.chimes).toEqual([1, 4]);
    expect(voice.tier).toBe(4);
  });

  it('chimes the peak after a cascade that ended under the hold, then rests at 0', () => {
    const voice = new FakeVoice();
    const hold = createAnnouncementHold();
    const held = holdTierVoice(() => voice, hold);
    const release = hold.hold();
    held.setComboTier(1);
    held.setComboTier(2);
    held.setComboTier(0);
    expect(voice.chimes).toEqual([]);
    release();
    expect(voice.chimes).toEqual([2]);
    expect(voice.tier).toBe(0);
  });

  it('never chimes under the hold, even when the live tier falls back above the voice', () => {
    const voice = new FakeVoice();
    const hold = createAnnouncementHold();
    const held = holdTierVoice(() => voice, hold);
    const release = hold.hold();
    held.setComboTier(3);
    held.setComboTier(2);
    expect(voice.chimes).toEqual([]);
    release();
    expect(voice.chimes).toEqual([3]);
    expect(voice.tier).toBe(2);
  });

  it('chimes the replayed peak when the hold began at that same tier', () => {
    const voice = new FakeVoice();
    const hold = createAnnouncementHold();
    const held = holdTierVoice(() => voice, hold);
    for (const tier of [1, 2, 3]) held.setComboTier(tier);
    expect(voice.chimes).toEqual([1, 2, 3]);
    const release = hold.hold();
    held.setComboTier(2);
    expect(voice.tier).toBe(2);
    held.setComboTier(3);
    expect(voice.tier).toBe(2);
    release();
    expect(voice.chimes).toEqual([1, 2, 3, 3]);
    expect(voice.tier).toBe(3);
  });

  it('skips the replay without a voice, and chimes again from the next rise', () => {
    let voice: FakeVoice | null = null;
    const hold = createAnnouncementHold();
    const held = holdTierVoice(() => voice, hold);
    const release = hold.hold();
    held.setComboTier(2);
    release();
    voice = new FakeVoice();
    held.setComboTier(3);
    expect(voice.chimes).toEqual([3]);
  });
});
