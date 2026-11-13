import { RARITIES, type Rarity, type StateResponse } from '@coinposh/shared';
import { rarityRank } from '@coinposh/economy';
import { albumPlace } from '../../game/crates/loot.ts';

export const ITEM_KINDS = ['charm', 'safe', 'scratchCard'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** One owned thing, as the inventory panel reads it. Local until packages/shared has a contract. */
export interface InventoryEntry {
  readonly id: string;
  readonly kind: ItemKind;
  /** The catalogue key: a charm type, a safe type, or `scratchCard`. */
  readonly type: string;
  /** Album rarity; safes and scratch cards have none. */
  readonly rarity: Rarity | null;
  readonly level: number;
  readonly equipped: boolean;
  /** A safe whose timer has run out. */
  readonly ready: boolean;
}

export interface InventoryView {
  /** In acquisition order, oldest first. */
  readonly entries: readonly InventoryEntry[];
  /**
   * Extra copies the Workshop fuses into one level, or `null` while the economy has no number
   * for it and no route spends duplicates (the server then levels a duplicate on grant).
   */
  readonly duplicatesPerLevel: number | null;
}

/** Where the panel gets its items; `levelUp` exists only once the server has a fuse route. */
export interface InventoryData {
  load(): Promise<InventoryView>;
  readonly levelUp?: (stack: ItemStack) => Promise<InventoryView>;
}

/** Every copy of one catalogue item, shown as a single card. */
export interface ItemStack {
  readonly key: string;
  readonly kind: ItemKind;
  readonly type: string;
  readonly rarity: Rarity | null;
  readonly level: number;
  readonly copies: number;
  readonly ids: readonly string[];
  readonly equipped: boolean;
  readonly ready: boolean;
  /** Position of the most recent copy in acquisition order. */
  readonly newest: number;
}

export const SORT_MODES = ['rarity', 'level', 'newest', 'name'] as const;
export type SortMode = (typeof SORT_MODES)[number];

export interface StackFilter {
  readonly kind: ItemKind | 'all';
  readonly rarity: Rarity | 'all';
}

export const NO_FILTER: StackFilter = { kind: 'all', rarity: 'all' };

export function stackKey(kind: ItemKind, type: string): string {
  return `${kind}:${type}`;
}

export interface InventoryState extends Pick<StateResponse, 'serverTime' | 'inventory'> {
  readonly venue: Pick<StateResponse['venue'], 'loadout'>;
}

export function inventoryViewFromState(state: InventoryState): InventoryView {
  const equipped = new Set(state.venue.loadout.flatMap((slot) => slot.charmId ?? []));
  const entries: InventoryEntry[] = [
    ...state.inventory.charms.map((charm): InventoryEntry => ({
      id: charm.id,
      kind: 'charm',
      type: charm.type,
      rarity: albumPlace(charm.type).rarity,
      level: charm.level,
      equipped: equipped.has(charm.id),
      ready: false,
    })),
    ...state.inventory.safes.map((safe): InventoryEntry => ({
      id: safe.id,
      kind: 'safe',
      type: safe.type,
      rarity: null,
      level: 1,
      equipped: false,
      ready: safe.unlocksAt <= state.serverTime,
    })),
    ...state.inventory.scratchCards.map((id): InventoryEntry => ({
      id,
      kind: 'scratchCard',
      type: 'scratchCard',
      rarity: null,
      level: 1,
      equipped: false,
      ready: false,
    })),
  ];
  return { entries, duplicatesPerLevel: null };
}

export function groupStacks(entries: readonly InventoryEntry[]): readonly ItemStack[] {
  const stacks = new Map<string, ItemStack>();
  entries.forEach((entry, index) => {
    const key = stackKey(entry.kind, entry.type);
    const stack = stacks.get(key);
    if (stack === undefined) {
      stacks.set(key, {
        key,
        kind: entry.kind,
        type: entry.type,
        rarity: entry.rarity,
        level: entry.level,
        copies: 1,
        ids: [entry.id],
        equipped: entry.equipped,
        ready: entry.ready,
        newest: index,
      });
      return;
    }
    stacks.set(key, {
      ...stack,
      level: Math.max(stack.level, entry.level),
      copies: stack.copies + 1,
      ids: [...stack.ids, entry.id],
      equipped: stack.equipped || entry.equipped,
      ready: stack.ready || entry.ready,
      newest: index,
    });
  });
  return [...stacks.values()];
}

function rank(rarity: Rarity | null): number {
  return rarity === null ? -1 : rarityRank(rarity);
}

type Compare = (a: ItemStack, b: ItemStack) => number;

export function sortStacks(
  stacks: readonly ItemStack[],
  mode: SortMode,
  nameOf: (stack: ItemStack) => string,
): readonly ItemStack[] {
  const byRarity: Compare = (a, b) => rank(b.rarity) - rank(a.rarity);
  const byLevel: Compare = (a, b) => b.level - a.level;
  const byNewest: Compare = (a, b) => b.newest - a.newest;
  const byName: Compare = (a, b) => nameOf(a).localeCompare(nameOf(b));
  const byKey: Compare = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const order: Record<SortMode, readonly Compare[]> = {
    rarity: [byRarity, byLevel, byName, byKey],
    level: [byLevel, byRarity, byName, byKey],
    newest: [byNewest, byKey],
    name: [byName, byRarity, byKey],
  };
  const compares = order[mode];
  return [...stacks].sort((a, b) => {
    for (const compare of compares) {
      const result = compare(a, b);
      if (result !== 0) return result;
    }
    return 0;
  });
}

export function matchesFilter(stack: ItemStack, filter: StackFilter): boolean {
  if (filter.kind !== 'all' && stack.kind !== filter.kind) return false;
  return filter.rarity === 'all' || stack.rarity === filter.rarity;
}

export function filterStacks(
  stacks: readonly ItemStack[],
  filter: StackFilter,
): readonly ItemStack[] {
  return stacks.filter((stack) => matchesFilter(stack, filter));
}

export interface FilterCounts {
  readonly kinds: Readonly<Record<ItemKind | 'all', number>>;
  /** Cards per rarity within the chosen kind, so the gem row counts what tapping would show. */
  readonly rarities: Readonly<Record<Rarity | 'all', number>>;
}

export function filterCounts(
  stacks: readonly ItemStack[],
  kind: StackFilter['kind'],
): FilterCounts {
  const kinds: Record<ItemKind | 'all', number> = { all: 0, charm: 0, safe: 0, scratchCard: 0 };
  const rarities = Object.fromEntries([['all', 0], ...RARITIES.map((r) => [r, 0])]) as Record<
    Rarity | 'all',
    number
  >;
  for (const stack of stacks) {
    kinds.all += 1;
    kinds[stack.kind] += 1;
    if (kind !== 'all' && stack.kind !== kind) continue;
    rarities.all += 1;
    if (stack.rarity !== null) rarities[stack.rarity] += 1;
  }
  return { kinds, rarities };
}

/** Only kinds the player owns get a chip, so a lone kind shows no kind row at all. */
export function ownedKinds(counts: FilterCounts): readonly ItemKind[] {
  return ITEM_KINDS.filter((kind) => counts.kinds[kind] > 0);
}

export interface FuseProgress {
  /** Spare copies toward the next level. */
  readonly have: number;
  readonly need: number;
  /** Levels the spare copies pay for right now. */
  readonly levels: number;
}

/** Duplicate progress for a charm stack, or `null` where duplicates cannot be fused. */
export function fuseProgress(
  stack: ItemStack,
  duplicatesPerLevel: number | null,
): FuseProgress | null {
  if (stack.kind !== 'charm' || duplicatesPerLevel === null) return null;
  if (!Number.isInteger(duplicatesPerLevel) || duplicatesPerLevel < 1) {
    throw new RangeError(
      `duplicatesPerLevel must be a positive integer, got ${duplicatesPerLevel}; fix the inventory contract`,
    );
  }
  const spare = stack.copies - 1;
  return {
    have: spare % duplicatesPerLevel,
    need: duplicatesPerLevel,
    levels: Math.floor(spare / duplicatesPerLevel),
  };
}

export function levelUpReady(stack: ItemStack, duplicatesPerLevel: number | null): boolean {
  return (fuseProgress(stack, duplicatesPerLevel)?.levels ?? 0) > 0;
}

export interface LevelGain {
  readonly key: string;
  readonly from: number;
  readonly to: number;
}

/**
 * Levels that rose since the panel last showed them. Where the server levels a duplicate on
 * grant (Demo Mode today), this is how the panel finds the level-up to celebrate.
 */
export function levelGains(
  seen: Readonly<Record<string, number>>,
  stacks: readonly ItemStack[],
): readonly LevelGain[] {
  return stacks.flatMap((stack) => {
    const from = seen[stack.key];
    return from !== undefined && stack.level > from
      ? [{ key: stack.key, from, to: stack.level }]
      : [];
  });
}

export function seenLevels(stacks: readonly ItemStack[]): Record<string, number> {
  return Object.fromEntries(
    stacks.filter((stack) => stack.kind === 'charm').map((stack) => [stack.key, stack.level]),
  );
}
