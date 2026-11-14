import { album } from '@coinposh/economy';
import type { AlbumResponse, CollectibleKind, Rarity, VenueId } from '@coinposh/shared';
import { albumPlace, type AlbumItemId, type AlbumSetKey } from '../../game/crates/loot.ts';

type AlbumItemDef = (typeof album)[number]['items'][number];

/** The album entries the economy grades heirloom: each carries a lore card. */
type HeirloomDef = Extract<AlbumItemDef, { readonly rarity: 'heirloom' }>;
export type HeirloomId = HeirloomDef['id'];

const ITEM_DEFS: readonly AlbumItemDef[] = album.flatMap(
  (set): readonly AlbumItemDef[] => set.items,
);

export const HEIRLOOM_IDS: readonly HeirloomId[] = ITEM_DEFS.filter(
  (item): item is HeirloomDef => item.rarity === 'heirloom',
).map((item) => item.id);

export function isHeirloomId(id: string): id is HeirloomId {
  return (HEIRLOOM_IDS as readonly string[]).includes(id);
}

export interface AlbumSlot {
  readonly id: AlbumItemId;
  readonly kind: CollectibleKind;
  readonly rarity: Rarity;
  readonly owned: boolean;
  /** Copies the server counts, duplicates included; 0 when not owned. */
  readonly count: number;
}

export interface AlbumSetView {
  readonly id: AlbumSetKey;
  readonly venue: VenueId;
  /** Added to the permanent global coin multiplier once the set is complete (0.05 = +5 %). */
  readonly bonus: number;
  readonly slots: readonly AlbumSlot[];
  readonly owned: number;
  readonly total: number;
  /** The server's verdict, not recomputed here. */
  readonly completed: boolean;
}

export interface AlbumView {
  readonly sets: readonly AlbumSetView[];
  readonly owned: number;
  readonly total: number;
  readonly completedSets: number;
  /** Sum of the completion bonuses the finished sets pay. */
  readonly bonus: number;
}

export interface AlbumData {
  load(): Promise<AlbumView>;
}

const SET_DEFS: ReadonlyMap<string, (typeof album)[number]> = new Map(
  album.map((set) => [set.id, set]),
);

function setDef(id: string): (typeof album)[number] {
  const def = SET_DEFS.get(id);
  if (def === undefined) {
    throw new RangeError(
      `The server's album lists set "${id}", which the economy album does not; ship the client with the server's packages/economy catalogue`,
    );
  }
  return def;
}

/**
 * Joins the server's album (what is owned, how many, which sets are done) with the economy
 * catalogue (venue, rarity, completion bonus). Ownership and completion stay the server's.
 */
export function albumView(response: AlbumResponse): AlbumView {
  const sets = response.sets.map((set): AlbumSetView => {
    const def = setDef(set.id);
    const slots = set.entries.map((entry): AlbumSlot => {
      const place = albumPlace(entry.id);
      if (place.set !== def.id) {
        throw new RangeError(
          `The server filed album entry "${entry.id}" under set "${set.id}", but the economy album files it under "${place.set}"`,
        );
      }
      return {
        id: place.item,
        kind: entry.kind,
        rarity: place.rarity,
        owned: entry.owned,
        count: entry.owned ? Math.max(1, entry.count) : 0,
      };
    });
    return {
      id: def.id,
      venue: def.venue,
      bonus: def.globalBonus,
      slots,
      owned: slots.filter((slot) => slot.owned).length,
      total: slots.length,
      completed: set.completed,
    };
  });
  const done = sets.filter((set) => set.completed);
  return {
    sets,
    owned: sets.reduce((sum, set) => sum + set.owned, 0),
    total: sets.reduce((sum, set) => sum + set.total, 0),
    completedSets: done.length,
    bonus: done.reduce((sum, set) => sum + set.bonus, 0),
  };
}

/** 0..1 share of the set's pieces owned. */
export function setProgress(set: Pick<AlbumSetView, 'owned' | 'total'>): number {
  return set.total === 0 ? 0 : Math.min(1, set.owned / set.total);
}

export function completedSetIds(view: AlbumView): readonly AlbumSetKey[] {
  return view.sets.filter((set) => set.completed).map((set) => set.id);
}

/**
 * The sets that turned complete since the album last showed them, in album order. A first
 * visit (`seen` null) celebrates every complete set: a set finished before the album was ever
 * opened has had no fanfare yet, and a completion is too rare a moment to swallow.
 */
export function newlyCompleted(
  seen: readonly string[] | null,
  view: AlbumView,
): readonly AlbumSetKey[] {
  const before = new Set(seen ?? []);
  return completedSetIds(view).filter((id) => !before.has(id));
}

/** The bonus the album paid before `pending` sets completed, for the readout to count up from. */
export function bonusBefore(view: AlbumView, pending: readonly AlbumSetKey[]): number {
  const waiting = new Set<string>(pending);
  return view.sets
    .filter((set) => set.completed && !waiting.has(set.id))
    .reduce((sum, set) => sum + set.bonus, 0);
}

export type LoreTarget =
  | { readonly kind: 'heirloom'; readonly id: HeirloomId; readonly set: AlbumSetKey }
  | { readonly kind: 'set'; readonly id: AlbumSetKey };

/** An owned Heirloom opens its lore card; anything else in a slot has none. */
export function slotLore(slot: AlbumSlot, set: AlbumSetKey): LoreTarget | null {
  if (!slot.owned || slot.rarity !== 'heirloom' || !isHeirloomId(slot.id)) return null;
  return { kind: 'heirloom', id: slot.id, set };
}

/** A completed set opens its lore card; an unfinished one keeps its story sealed. */
export function setLore(set: Pick<AlbumSetView, 'id' | 'completed'>): LoreTarget | null {
  return set.completed ? { kind: 'set', id: set.id } : null;
}
