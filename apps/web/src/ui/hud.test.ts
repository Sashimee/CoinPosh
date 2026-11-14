import { openingHeap, upgradeCost, upgradeLines } from '@coinposh/economy';
import { describe, expect, it } from 'vitest';
import { upgradeRow } from '../app/model.ts';
import { defaultSettings } from '../app/settings.ts';
import { initialUiState } from '../app/state.ts';
import { createStore } from '../app/store.ts';
import { BUNDLED_RESOURCES, createI18n, LANGUAGES } from '../i18n/index.ts';
import {
  createPosterGate,
  dockAffordableCount,
  inHandCopy,
  posterHeapTarget,
  safesTriggerBeckons,
  safesTriggerState,
  setInHand,
  vaultIsEmpty,
} from './hud.ts';

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

  it('counts only what spendable coins can buy, not winnings still awaiting the house', () => {
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
  sim: { renderTick: number; coins: number } | null;
  playable: boolean;
  restored: { poses: number; heapSlots: number } | null;
}

function freshBoot(): FakeBoot {
  return { sim: null, playable: false, restored: { poses: 0, heapSlots: openingHeap.coins } };
}

function frame(renderTick: number, coins: number): FakeBoot['sim'] {
  return { renderTick, coins };
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
    boot.sim = frame(13, HEAP_TARGET);
    expect(mayLeave()).toBe(true);
  });

  it('leaves on playable once the held table draws the heap, at the laid tick', () => {
    const boot = freshBoot();
    const mayLeave = createPosterGate(boot);
    boot.sim = frame(0, openingHeap.coins);
    expect(mayLeave(), 'the sim is held, so the tick has not moved').toBe(false);
    boot.playable = true;
    expect(mayLeave()).toBe(true);
  });

  it('holds a playable boot until the heap is drawn', () => {
    const boot = freshBoot();
    boot.playable = true;
    const mayLeave = createPosterGate(boot);
    expect(mayLeave(), 'no sim frame drawn yet').toBe(false);
    boot.sim = frame(0, 0);
    expect(mayLeave(), 'the coins are not synced yet').toBe(false);
    boot.sim = frame(0, HEAP_TARGET - 1);
    expect(mayLeave()).toBe(false);
    boot.sim = frame(0, HEAP_TARGET);
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

  it('leaves on the frame after the heap, wherever the pusher is', () => {
    const boot = freshBoot();
    const mayLeave = createPosterGate(boot);
    boot.sim = frame(12, openingHeap.coins);
    expect(mayLeave()).toBe(false);
    boot.sim = frame(105, openingHeap.coins);
    expect(mayLeave(), 'a shader stall let the sim run on, so the poster leaves now').toBe(true);
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

describe('safesTriggerState', () => {
  it('is empty with no safes, locked while every timer runs, ready once one opens free', () => {
    expect(safesTriggerState({ count: 0, ready: 0 })).toBe('empty');
    expect(safesTriggerState({ count: 3, ready: 0 })).toBe('locked');
    expect(safesTriggerState({ count: 3, ready: 1 })).toBe('ready');
  });
});

describe('safesTriggerBeckons', () => {
  it('flares when a safe comes off its timer', () => {
    expect(safesTriggerBeckons({ count: 2, ready: 0 }, { count: 2, ready: 1 })).toBe(true);
    expect(safesTriggerBeckons({ count: 2, ready: 1 }, { count: 3, ready: 2 })).toBe(true);
  });

  it('stays calm on the first tally, an open, or a new locked safe', () => {
    expect(safesTriggerBeckons(null, { count: 4, ready: 4 })).toBe(false);
    expect(safesTriggerBeckons({ count: 2, ready: 2 }, { count: 1, ready: 1 })).toBe(false);
    expect(safesTriggerBeckons({ count: 1, ready: 0 }, { count: 2, ready: 0 })).toBe(false);
  });
});

describe('dock.safesReady', () => {
  it.each(LANGUAGES)('names the button and pluralises the ready count in %s', (language) => {
    const i18n = createI18n({ language, resources: BUNDLED_RESOURCES });
    const one = i18n.t('dock.safesReady', { label: 'SAFES', count: 1 });
    const many = i18n.t('dock.safesReady', { label: 'SAFES', count: 3 });
    for (const text of [one, many]) {
      expect(text.startsWith('SAFES')).toBe(true);
      expect(text).not.toContain('dock.');
      expect(text).not.toContain('{{');
    }
    expect(one).toContain('1');
    expect(many).toContain('3');
    expect(many, 'the plural form differs from the singular').not.toBe(one.replace('1', '3'));
  });
});

describe('inHandCopy', () => {
  it.each([
    ['en', 'In hand', '1 coin in hand', '12 coins in hand'],
    ['fr', 'En main', '1 pièce en main', '12 pièces en main'],
    ['de', 'In der Hand', '1 Münze in der Hand', '12 Münzen in der Hand'],
  ] as const)('labels and pluralises the drop buffer in %s', (language, label, one, many) => {
    const i18n = createI18n({ language, resources: BUNDLED_RESOURCES });
    const t = i18n.t.bind(i18n);
    expect(inHandCopy(t, 12, language)).toMatchObject({ label, value: '12' });
    expect(inHandCopy(t, 1, language).spoken).toContain(one);
    expect(inHandCopy(t, 12, language).spoken).toContain(many);
    expect(inHandCopy(t, 0, language).value).toBe('0');
  });
});

describe('vaultIsEmpty', () => {
  it('stays quiet while coins in hand can still drop, even with the Vault at zero', () => {
    expect(vaultIsEmpty(0, 12)).toBe(false);
    expect(vaultIsEmpty(5, 0)).toBe(false);
  });

  it('calls the Vault empty only once neither the Vault nor the hand can pay for a drop', () => {
    expect(vaultIsEmpty(0, 0)).toBe(true);
  });
});

describe('setInHand', () => {
  const store = createStore(initialUiState(defaultSettings('en')));

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('refuses %s coins in hand', (coins) => {
    expect(() => {
      setInHand(store, coins);
    }).toThrow(RangeError);
  });

  it('accepts an empty and a full buffer', () => {
    expect(() => {
      setInHand(store, 0);
      setInHand(store, 12);
    }).not.toThrow();
  });
});
