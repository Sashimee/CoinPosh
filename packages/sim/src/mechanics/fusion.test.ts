import { describe, expect, it } from 'vitest';
import { StateHasher } from '../hash.ts';
import type { CoinPair } from './contacts.ts';
import { economyConfig, upgradeStatAt } from '@coinposh/economy';
import { ContactFusion, freshTicks, fusionTicks } from './fusion.ts';
import { FUSION_TUNING } from './tuning.ts';

const RULES = { inputCount: 3, contactSeconds: 0.4 };
const TRIPLE: CoinPair[] = [
  { a: 0, b: 1 },
  { a: 1, b: 2 },
];

/** Feeds `pairs` at every tick in [from, to] and returns the first tick that fused, with its groups. */
function feed(
  fusion: ContactFusion,
  pairs: readonly CoinPair[],
  from: number,
  to: number,
): { tick: number; groups: number[][] } | null {
  for (let tick = from; tick <= to; tick++) {
    const groups = fusion.update(tick, pairs);
    if (groups.length > 0) {
      return { tick, groups };
    }
  }
  return null;
}

describe('fusionTicks', () => {
  it('turns the economy window into whole ticks, rounding up', () => {
    expect(fusionTicks(0.4)).toBe(24);
    expect(fusionTicks(0.4 * 1.05)).toBe(26);
    expect(fusionTicks(1 / 60)).toBe(1);
    expect(fusionTicks(0.001)).toBe(1);
  });

  it('forgives a rounding error just above a whole tick', () => {
    expect(fusionTicks(0.5 + 1e-15)).toBe(30);
  });

  it('rejects windows that are not positive', () => {
    for (const bad of [0, -0.4, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => fusionTicks(bad)).toThrow(RangeError);
    }
  });
});

describe('freshTicks', () => {
  it('is FUSION_TUNING.freshTicks without the fusionWindow upgrade', () => {
    expect(freshTicks()).toBe(FUSION_TUNING.freshTicks);
    expect(freshTicks(upgradeStatAt({}, 'fusionWindow'))).toBe(FUSION_TUNING.freshTicks);
  });

  it('stretches the fresh window by the economy’s fusionWindow stat, rounding up', () => {
    expect(freshTicks(upgradeStatAt({ fusionWindow: 1 }, 'fusionWindow'))).toBe(331);
    expect(freshTicks(upgradeStatAt({ fusionWindow: 10 }, 'fusionWindow'))).toBe(473);
    const top = economyConfig.upgradeLines.find(({ id }) => id === 'fusionWindow')?.maxLevel;
    expect(freshTicks(upgradeStatAt({ fusionWindow: top ?? 0 }, 'fusionWindow'))).toBe(630);
  });

  it('forgives a rounding error just above a whole tick', () => {
    expect(freshTicks(1 + 1e-15)).toBe(FUSION_TUNING.freshTicks);
  });

  it('rejects a fusionWindow that is not positive', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => freshTicks(bad)).toThrow(RangeError);
    }
  });
});

describe('ContactFusion', () => {
  it('fuses three coins after exactly 0.4 s of contact, not a tick before', () => {
    const fusion = new ContactFusion(RULES, 3);
    expect(feed(fusion, TRIPLE, 100, 123)).toBeNull();
    expect(fusion.update(124, TRIPLE)).toEqual([[0, 1, 2]]);
  });

  it('keeps the clock through a break inside the grace and restarts it after', () => {
    const kept = new ContactFusion(RULES, 3);
    feed(kept, TRIPLE, 0, 10);
    feed(kept, [], 11, 13);
    expect(feed(kept, TRIPLE, 14, 30)).toEqual({ tick: 24, groups: [[0, 1, 2]] });

    const reset = new ContactFusion(RULES, 3);
    feed(reset, TRIPLE, 0, 10);
    feed(reset, [], 11, 14);
    expect(feed(reset, TRIPLE, 15, 60)).toEqual({ tick: 15 + 24, groups: [[0, 1, 2]] });
  });

  it('needs every contact in the group to be ripe and touching now', () => {
    const fusion = new ContactFusion(RULES, 3);
    feed(fusion, [{ a: 0, b: 1 }], 0, 20);
    expect(feed(fusion, TRIPLE, 21, 60)?.tick).toBe(21 + 24);
  });

  it('never fuses a lone pair', () => {
    const fusion = new ContactFusion(RULES, 3);
    expect(feed(fusion, [{ a: 0, b: 1 }], 0, 200)).toBeNull();
  });

  it('splits a long chain into disjoint groups from the lowest id', () => {
    const fusion = new ContactFusion(RULES, 3);
    const chain = [4, 5, 6, 7, 8, 9, 10].slice(0, -1).map((a) => ({ a, b: a + 1 }));
    expect(feed(fusion, chain, 0, 30)?.groups).toEqual([
      [4, 5, 6],
      [7, 8, 9],
    ]);
  });

  it('builds a group breadth first, taking neighbours in id order', () => {
    const fusion = new ContactFusion(RULES, 3);
    const star = [
      { a: 1, b: 9 },
      { a: 3, b: 9 },
      { a: 5, b: 9 },
      { a: 7, b: 9 },
    ];
    expect(feed(fusion, star, 0, 30)?.groups).toEqual([[1, 3, 9]]);
  });

  it('fuses larger groups when the rules ask for them', () => {
    const fusion = new ContactFusion({ inputCount: 4, contactSeconds: 0.1 }, 0);
    const ring = [
      { a: 0, b: 1 },
      { a: 0, b: 3 },
      { a: 1, b: 2 },
    ];
    expect(feed(fusion, ring, 0, 30)).toEqual({ tick: 6, groups: [[0, 1, 2, 3]] });
  });

  it('forgets contacts of coins that left', () => {
    const fusion = new ContactFusion(RULES, 3);
    feed(fusion, TRIPLE, 0, 20);
    expect(fusion.trackedContacts).toBe(2);
    fusion.forget([2]);
    expect(fusion.trackedContacts).toBe(1);
    expect(feed(fusion, TRIPLE, 21, 44)).toBeNull();
    fusion.forget([]);
    fusion.forget([0, 1]);
    expect(fusion.trackedContacts).toBe(0);
  });

  it('reports the charge-up of the pairs touching now', () => {
    const fusion = new ContactFusion(RULES, 3);
    feed(fusion, TRIPLE, 0, 12);
    fusion.update(13, [{ a: 1, b: 2 }]);
    expect(fusion.progress(13)).toEqual([{ a: 1, b: 2, progress: 13 / 24 }]);
    feed(fusion, TRIPLE, 14, 23);
    expect(fusion.progress(23).map(({ progress }) => progress)).toEqual([23 / 24, 23 / 24]);
  });

  it('digests the same state the same way whatever order the contacts arrived in', () => {
    const forward = new ContactFusion(RULES, 3);
    const backward = new ContactFusion(RULES, 3);
    forward.update(0, [{ a: 0, b: 1 }]);
    forward.update(0, [{ a: 1, b: 2 }]);
    backward.update(0, [{ a: 1, b: 2 }]);
    backward.update(0, [{ a: 0, b: 1 }]);
    expect(forward.hashInto(new StateHasher()).digest()).toBe(
      backward.hashInto(new StateHasher()).digest(),
    );
    backward.update(1, [{ a: 0, b: 1 }]);
    expect(forward.hashInto(new StateHasher()).digest()).not.toBe(
      backward.hashInto(new StateHasher()).digest(),
    );
  });

  it('rejects rules it cannot run', () => {
    expect(() => new ContactFusion({ inputCount: 1, contactSeconds: 0.4 }, 3)).toThrow(RangeError);
    expect(() => new ContactFusion({ inputCount: 2.5, contactSeconds: 0.4 }, 3)).toThrow(
      RangeError,
    );
    expect(() => new ContactFusion({ inputCount: 3, contactSeconds: 0 }, 3)).toThrow(RangeError);
    expect(() => new ContactFusion(RULES, -1)).toThrow(RangeError);
  });
});
