import { CharmSlotSchema, InventorySchema } from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import {
  filterCounts,
  filterStacks,
  fuseProgress,
  groupStacks,
  inventoryViewFromState,
  levelGains,
  levelUpReady,
  NO_FILTER,
  ownedKinds,
  seenLevels,
  sortStacks,
  type InventoryEntry,
  type ItemStack,
} from './model.ts';

function entry(
  partial: Partial<InventoryEntry> & Pick<InventoryEntry, 'id' | 'type'>,
): InventoryEntry {
  return {
    kind: 'charm',
    rarity: 'common',
    level: 1,
    equipped: false,
    ready: false,
    ...partial,
  };
}

const NAMES: Record<string, string> = {
  'charm:captainsBellCharm': "Captain's Bell",
  'charm:champagneBucketCharm': 'Champagne Bucket',
  'charm:pearlNecklaceCharm': 'Pearl Necklace',
  'safe:brassSafe': 'Safe',
  'scratchCard:scratchCard': 'Scratch Card',
};
const nameOf = (stack: ItemStack): string => NAMES[stack.key] ?? stack.key;

const ENTRIES: readonly InventoryEntry[] = [
  entry({ id: 'c1', type: 'captainsBellCharm', rarity: 'fine', level: 2 }),
  entry({ id: 's1', type: 'brassSafe', kind: 'safe', rarity: null, ready: true }),
  entry({ id: 'c2', type: 'pearlNecklaceCharm', rarity: 'rare', level: 1 }),
  entry({ id: 'c3', type: 'champagneBucketCharm', rarity: 'fine', level: 4, equipped: true }),
  entry({ id: 'c4', type: 'captainsBellCharm', rarity: 'fine', level: 3 }),
  entry({ id: 'k1', type: 'scratchCard', kind: 'scratchCard', rarity: null }),
];

describe('groupStacks', () => {
  it('folds duplicates of one type into a single stack with every copy', () => {
    const stacks = groupStacks(ENTRIES);
    expect(stacks.map((s) => s.key)).toEqual([
      'charm:captainsBellCharm',
      'safe:brassSafe',
      'charm:pearlNecklaceCharm',
      'charm:champagneBucketCharm',
      'scratchCard:scratchCard',
    ]);
    const bell = stacks[0];
    expect(bell).toMatchObject({ copies: 2, ids: ['c1', 'c4'], level: 3, newest: 4 });
  });

  it('keeps the highest level and any equipped or ready flag across copies', () => {
    const stacks = groupStacks([
      entry({ id: 'a', type: 'captainsBellCharm', level: 5, equipped: true }),
      entry({ id: 'b', type: 'captainsBellCharm', level: 2 }),
      entry({ id: 's1', type: 'brassSafe', kind: 'safe', rarity: null, ready: false }),
      entry({ id: 's2', type: 'brassSafe', kind: 'safe', rarity: null, ready: true }),
    ]);
    expect(stacks[0]).toMatchObject({ level: 5, equipped: true, copies: 2 });
    expect(stacks[1]).toMatchObject({ ready: true, copies: 2 });
  });

  it('keeps a charm and a safe that share a type key apart', () => {
    const stacks = groupStacks([
      entry({ id: 'a', type: 'same' }),
      entry({ id: 'b', type: 'same', kind: 'safe', rarity: null }),
    ]);
    expect(stacks).toHaveLength(2);
  });

  it('returns nothing for an empty inventory', () => {
    expect(groupStacks([])).toEqual([]);
  });
});

describe('sortStacks', () => {
  const stacks = groupStacks(ENTRIES);

  it('puts the rarest first, then the highest level, then by name', () => {
    expect(sortStacks(stacks, 'rarity', nameOf).map((s) => s.type)).toEqual([
      'pearlNecklaceCharm',
      'champagneBucketCharm',
      'captainsBellCharm',
      'brassSafe',
      'scratchCard',
    ]);
  });

  it('sorts by level with rarity breaking ties', () => {
    expect(sortStacks(stacks, 'level', nameOf).map((s) => s.type)).toEqual([
      'champagneBucketCharm',
      'captainsBellCharm',
      'pearlNecklaceCharm',
      'brassSafe',
      'scratchCard',
    ]);
  });

  it('sorts by the most recent copy', () => {
    expect(sortStacks(stacks, 'newest', nameOf).map((s) => s.type)).toEqual([
      'scratchCard',
      'captainsBellCharm',
      'champagneBucketCharm',
      'pearlNecklaceCharm',
      'brassSafe',
    ]);
  });

  it('sorts by the localized name it is given', () => {
    const german: Record<string, string> = {
      'charm:captainsBellCharm': 'Kapitänsglocke',
      'charm:champagneBucketCharm': 'Champagnerkühler',
      'charm:pearlNecklaceCharm': 'Perlenkette',
    };
    const inGerman = (stack: ItemStack): string => german[stack.key] ?? nameOf(stack);
    expect(sortStacks(stacks, 'name', nameOf).map((s) => s.type)).toEqual([
      'captainsBellCharm',
      'champagneBucketCharm',
      'pearlNecklaceCharm',
      'brassSafe',
      'scratchCard',
    ]);
    expect(sortStacks(stacks, 'name', inGerman).map((s) => s.type)).toEqual([
      'champagneBucketCharm',
      'captainsBellCharm',
      'pearlNecklaceCharm',
      'brassSafe',
      'scratchCard',
    ]);
  });

  it('does not reorder the input array', () => {
    const before = stacks.map((s) => s.key);
    sortStacks(stacks, 'name', nameOf);
    expect(stacks.map((s) => s.key)).toEqual(before);
  });

  it('is stable for equal stacks by falling back to the key', () => {
    const twins = groupStacks([entry({ id: 'b', type: 'b' }), entry({ id: 'a', type: 'a' })]);
    expect(sortStacks(twins, 'rarity', () => 'same').map((s) => s.type)).toEqual(['a', 'b']);
  });
});

describe('filterStacks', () => {
  const stacks = groupStacks(ENTRIES);

  it('shows everything with no filter', () => {
    expect(filterStacks(stacks, NO_FILTER)).toHaveLength(5);
  });

  it('filters by kind', () => {
    expect(filterStacks(stacks, { kind: 'safe', rarity: 'all' }).map((s) => s.type)).toEqual([
      'brassSafe',
    ]);
  });

  it('filters by rarity, which leaves out unrated items', () => {
    expect(filterStacks(stacks, { kind: 'all', rarity: 'fine' }).map((s) => s.type)).toEqual([
      'captainsBellCharm',
      'champagneBucketCharm',
    ]);
  });

  it('returns nothing when kind and rarity cannot both match', () => {
    expect(filterStacks(stacks, { kind: 'safe', rarity: 'rare' })).toEqual([]);
  });

  it('counts kinds overall and rarities within the chosen kind', () => {
    const all = filterCounts(stacks, 'all');
    expect(all.kinds).toEqual({ all: 5, charm: 3, safe: 1, scratchCard: 1 });
    expect(all.rarities).toMatchObject({ all: 5, fine: 2, rare: 1, common: 0 });
    const safes = filterCounts(stacks, 'safe');
    expect(safes.rarities).toMatchObject({ all: 1, fine: 0, rare: 0 });
    expect(ownedKinds(all)).toEqual(['charm', 'safe', 'scratchCard']);
    expect(ownedKinds(filterCounts([], 'all'))).toEqual([]);
  });
});

describe('duplicates', () => {
  const bell = groupStacks([
    entry({ id: 'a', type: 'captainsBellCharm' }),
    entry({ id: 'b', type: 'captainsBellCharm' }),
    entry({ id: 'c', type: 'captainsBellCharm' }),
    entry({ id: 'd', type: 'captainsBellCharm' }),
  ])[0];
  if (!bell) throw new Error('fixture stack missing');

  it('counts spare copies toward the next level', () => {
    expect(fuseProgress(bell, 3)).toEqual({ have: 0, need: 3, levels: 1 });
    expect(fuseProgress(bell, 2)).toEqual({ have: 1, need: 2, levels: 1 });
    expect(fuseProgress(bell, 5)).toEqual({ have: 3, need: 5, levels: 0 });
    expect(levelUpReady(bell, 3)).toBe(true);
    expect(levelUpReady(bell, 5)).toBe(false);
  });

  it('a lone copy has nothing to fuse', () => {
    const single = { ...bell, copies: 1, ids: ['a'] };
    expect(fuseProgress(single, 1)).toEqual({ have: 0, need: 1, levels: 0 });
  });

  it('has no fuse while the economy has no rate, nor for safes', () => {
    expect(fuseProgress(bell, null)).toBeNull();
    expect(levelUpReady(bell, null)).toBe(false);
    expect(fuseProgress({ ...bell, kind: 'safe' }, 3)).toBeNull();
  });

  it('rejects a nonsensical rate loudly', () => {
    expect(() => fuseProgress(bell, 0)).toThrow(RangeError);
    expect(() => fuseProgress(bell, 1.5)).toThrow(RangeError);
  });

  it('finds levels that rose since they were last seen', () => {
    const stacks = groupStacks(ENTRIES);
    const seen = { 'charm:captainsBellCharm': 2, 'charm:pearlNecklaceCharm': 1 };
    expect(levelGains(seen, stacks)).toEqual([{ key: 'charm:captainsBellCharm', from: 2, to: 3 }]);
    expect(levelGains({}, stacks)).toEqual([]);
    expect(levelGains(seenLevels(stacks), stacks)).toEqual([]);
    expect(Object.keys(seenLevels(stacks))).toEqual([
      'charm:captainsBellCharm',
      'charm:pearlNecklaceCharm',
      'charm:champagneBucketCharm',
    ]);
  });
});

describe('inventoryViewFromState', () => {
  const inventory = InventorySchema.parse({
    charms: [
      { id: 'charm_bell0001', type: 'captainsBellCharm', level: 2 },
      { id: 'charm_pearl001', type: 'pearlNecklaceCharm', level: 1 },
    ],
    safes: [
      { id: 'safe_early0001', type: 'brassSafe', unlocksAt: 1_000 },
      { id: 'safe_later0001', type: 'brassSafe', unlocksAt: 9_000 },
    ],
    scratchCards: ['scratch_card0001'],
  });
  const loadout = [
    CharmSlotSchema.parse({ socket: 0, charmId: 'charm_pearl001' }),
    CharmSlotSchema.parse({ socket: 1, charmId: null }),
  ];

  it('reads rarity from the economy album and equipped from the loadout', () => {
    const view = inventoryViewFromState({ serverTime: 5_000, inventory, venue: { loadout } });
    expect(view.duplicatesPerLevel).toBeNull();
    expect(view.entries.map((e) => [e.id, e.kind, e.rarity, e.equipped, e.ready])).toEqual([
      ['charm_bell0001', 'charm', 'fine', false, false],
      ['charm_pearl001', 'charm', 'rare', true, false],
      ['safe_early0001', 'safe', null, false, true],
      ['safe_later0001', 'safe', null, false, false],
      ['scratch_card0001', 'scratchCard', null, false, false],
    ]);
  });

  it('refuses a charm the economy album does not list', () => {
    const odd = InventorySchema.parse({
      charms: [{ id: 'charm_odd00001', type: 'mysteryCharm', level: 1 }],
      safes: [],
      scratchCards: [],
    });
    expect(() =>
      inventoryViewFromState({ serverTime: 0, inventory: odd, venue: { loadout: [] } }),
    ).toThrow(RangeError);
  });
});
