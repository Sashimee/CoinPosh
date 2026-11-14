import { openingHeap, upgradeCost, upgradeLines } from '@coinposh/economy';
import { describe, expect, it } from 'vitest';
import { upgradeRow } from '../app/model.ts';
import { createPosterGate, dockAffordableCount, posterHeapTarget } from './hud.ts';

const RICH = 1e15;
const familyOffice = upgradeLines.filter((line) => line.scope === 'global');
const venue = upgradeLines.filter((line) => line.scope === 'venue');

describe('dockAffordableCount', () => {
  it('ignores Family Office lines that Gold Bars can afford', () => {
    expect(familyOffice.length).toBeGreaterThan(0);
    const wallet = { coins: 0, goldBars: RICH };
    expect(familyOffice.every((line) => upgradeRow(line, 0, wallet).affordable)).toBe(true);
    expect(dockAffordableCount({ ...wallet, upgradeLevels: {} })).toBe(0);
  });

  it('counts each affordable venue line the sheet lists', () => {
    expect(dockAffordableCount({ coins: RICH, goldBars: RICH, upgradeLevels: {} })).toBe(
      venue.length,
    );
  });

  it('counts only what spendable coins can buy, not coins still in the drop rail', () => {
    const cheapest = Math.min(...venue.map((line) => upgradeCost(line, 0)));
    const shown = cheapest + 4;
    expect(
      dockAffordableCount({
        coins: shown,
        spendableCoins: cheapest - 5,
        goldBars: 0,
        upgradeLevels: {},
      }),
    ).toBe(0);
    expect(
      dockAffordableCount({
        coins: shown,
        spendableCoins: cheapest,
        goldBars: 0,
        upgradeLevels: {},
      }),
    ).toBeGreaterThan(0);
  });

  it('drops maxed venue lines and shows nothing on an empty wallet', () => {
    const [first] = venue;
    if (!first) throw new Error('packages/economy defines no venue upgrade line');
    const levels = { [first.id]: first.maxLevel };
    expect(dockAffordableCount({ coins: RICH, goldBars: 0, upgradeLevels: levels })).toBe(
      venue.length - 1,
    );
    expect(dockAffordableCount({ coins: 0, goldBars: 0, upgradeLevels: {} })).toBe(0);
  });
});

interface FakeBoot {
  sim: { renderTick: number; coins: number; pusherStroke: number } | null;
  playable: boolean;
  restored: { poses: number; heapSlots: number } | null;
}

function freshBoot(): FakeBoot {
  return { sim: null, playable: false, restored: { poses: 0, heapSlots: openingHeap.coins } };
}

function frame(renderTick: number, coins: number, pusherStroke = 0): FakeBoot['sim'] {
  return { renderTick, coins, pusherStroke };
}

const HEAP_TARGET = Math.ceil(openingHeap.coins * 0.9);

describe('posterHeapTarget', () => {
  it('asks for 90 % of the opening heap on a fresh table', () => {
    expect(posterHeapTarget({ poses: 0, heapSlots: openingHeap.coins })).toBe(HEAP_TARGET);
  });

  it('caps a restored table that holds more than the heap at the heap', () => {
    expect(posterHeapTarget({ poses: openingHeap.coins * 3, heapSlots: 0 })).toBe(HEAP_TARGET);
  });

  it('follows a played-down table, so the poster is never stranded', () => {
    expect(posterHeapTarget({ poses: 7, heapSlots: 3 })).toBe(9);
    expect(posterHeapTarget({ poses: 0, heapSlots: 0 })).toBe(0);
    expect(posterHeapTarget(null)).toBe(0);
  });
});

describe('createPosterGate', () => {
  it('holds the poster until a second lit frame draws the heap', () => {
    const boot = freshBoot();
    const mayLeave = createPosterGate(boot);
    expect(mayLeave()).toBe(false);
    boot.sim = frame(0, openingHeap.coins);
    expect(mayLeave()).toBe(false);
    boot.sim = frame(4, HEAP_TARGET - 1);
    expect(mayLeave()).toBe(false);
    boot.sim = frame(12, HEAP_TARGET);
    expect(mayLeave(), 'the frame that first draws the heap').toBe(false);
    expect(mayLeave(), 'the same sim tick drawn again').toBe(false);
    boot.sim = frame(13, HEAP_TARGET, 0.02);
    expect(mayLeave()).toBe(true);
  });

  it('does not wait for playable', () => {
    const boot = freshBoot();
    const mayLeave = createPosterGate(boot);
    boot.sim = frame(1, openingHeap.coins);
    mayLeave();
    boot.sim = frame(2, openingHeap.coins);
    expect(boot.playable).toBe(false);
    expect(mayLeave()).toBe(true);
  });

  it('waits for the pusher to come back to the retracted pose the poster shows', () => {
    const boot = freshBoot();
    const mayLeave = createPosterGate(boot);
    boot.sim = frame(12, openingHeap.coins);
    mayLeave();
    boot.sim = frame(105, openingHeap.coins, 0.84);
    expect(mayLeave(), 'a shader stall let the pusher run out under the poster').toBe(false);
    boot.sim = frame(200, openingHeap.coins, 0.16);
    expect(mayLeave()).toBe(false);
    boot.sim = frame(230, openingHeap.coins, 0.15);
    expect(mayLeave()).toBe(true);
  });

  it('gives up on the pose after more than a pusher cycle, so the poster is never stranded', () => {
    const boot = freshBoot();
    const mayLeave = createPosterGate(boot);
    boot.sim = frame(12, openingHeap.coins, 0.5);
    mayLeave();
    boot.sim = frame(330, openingHeap.coins, 0.5);
    expect(mayLeave(), 'the cycle is counted from the first frame after the stall').toBe(false);
    boot.sim = frame(809, openingHeap.coins, 0.5);
    expect(mayLeave()).toBe(false);
    boot.sim = frame(810, openingHeap.coins, 0.5);
    expect(mayLeave()).toBe(true);
  });

  it('starts over when the heap drops under the target before a second frame', () => {
    const boot = freshBoot();
    const mayLeave = createPosterGate(boot);
    boot.sim = frame(10, HEAP_TARGET);
    mayLeave();
    boot.sim = frame(11, HEAP_TARGET - 1);
    expect(mayLeave()).toBe(false);
    boot.sim = frame(12, HEAP_TARGET);
    expect(mayLeave()).toBe(false);
    boot.sim = frame(13, HEAP_TARGET);
    expect(mayLeave()).toBe(true);
  });

  it('leaves on the second lit frame of a table laid with no coins', () => {
    const boot: FakeBoot = { sim: null, playable: false, restored: null };
    const mayLeave = createPosterGate(boot);
    boot.sim = frame(1, 0);
    expect(mayLeave()).toBe(false);
    boot.sim = frame(2, 0);
    expect(mayLeave()).toBe(true);
  });
});
