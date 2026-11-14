import { album } from '@coinposh/economy';
import { AlbumResponseSchema } from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import { albumResponse, rawAlbum } from './fixture.ts';
import {
  albumView,
  bonusBefore,
  completedSetIds,
  HEIRLOOM_IDS,
  newlyCompleted,
  setLore,
  setProgress,
  slotLore,
  type AlbumView,
} from './model.ts';

const [deck, captains, gala] = album;
const HEIRLOOM = 'duchessSovereign1891';

function viewWith(count: (id: string, set: string) => number): AlbumView {
  return albumView(albumResponse(count));
}

const deckDone = viewWith((_, set) => (set === deck.id ? 1 : 0));
const allDone = viewWith(() => 2);
const nothing = viewWith(() => 0);

describe('albumView', () => {
  it('joins the server album with the economy catalogue in album order', () => {
    expect(nothing.sets.map((set) => set.id)).toEqual(album.map((set) => set.id));
    const first = nothing.sets[0];
    expect(first?.venue).toBe(deck.venue);
    expect(first?.bonus).toBe(deck.globalBonus);
    expect(first?.slots.map((slot) => [slot.id, slot.rarity])).toEqual(
      deck.items.map((item) => [item.id, item.rarity]),
    );
    expect(nothing.total).toBe(album.reduce((sum, set) => sum + set.items.length, 0));
  });

  it('counts owned pieces, duplicates and the bonus of completed sets only', () => {
    const view = viewWith((id, set) => (set === deck.id ? (id === deck.items[0].id ? 4 : 1) : 0));
    expect(view.owned).toBe(deck.items.length);
    expect(view.completedSets).toBe(1);
    expect(view.bonus).toBeCloseTo(deck.globalBonus);
    expect(view.sets[0]?.slots[0]?.count).toBe(4);
    expect(view.sets[1]?.slots.every((slot) => !slot.owned && slot.count === 0)).toBe(true);
  });

  it('starts from nothing on an empty account', () => {
    expect(nothing).toMatchObject({ owned: 0, completedSets: 0, bonus: 0 });
  });

  it('sums every completion bonus when the album is full', () => {
    expect(allDone.bonus).toBeCloseTo(album.reduce((sum, set) => sum + set.globalBonus, 0));
    expect(allDone.completedSets).toBe(album.length);
  });

  it('keeps the server verdict on completion rather than recomputing it', () => {
    const response = albumResponse(() => 1);
    const sets = response.sets.map((set, index) =>
      index === 0 ? { ...set, completed: false } : set,
    );
    expect(albumView({ sets }).sets[0]?.completed).toBe(false);
  });

  it('shows at least one copy of an owned piece the server counts as zero', () => {
    const response = albumResponse(() => 0);
    const [first, ...rest] = response.sets;
    if (!first) throw new Error('fixture has no sets');
    const [entry, ...others] = first.entries;
    if (!entry) throw new Error('fixture set has no entries');
    const sets = [{ ...first, entries: [{ ...entry, owned: true, count: 0 }, ...others] }, ...rest];
    expect(albumView({ sets }).sets[0]?.slots[0]?.count).toBe(1);
  });

  it('rejects a set the economy does not know', () => {
    const [first] = rawAlbum(() => 0).sets;
    const stray = AlbumResponseSchema.parse({ sets: [{ ...first, id: 'pirateCove' }] });
    expect(() => albumView(stray)).toThrow(/pirateCove/);
  });

  it('rejects a piece filed under the wrong set', () => {
    const response = albumResponse(() => 0);
    const [first, second] = response.sets;
    if (!first || !second) throw new Error('fixture needs two sets');
    const moved = { ...first, entries: [...first.entries, ...second.entries.slice(0, 1)] };
    expect(() => albumView({ sets: [moved] })).toThrow(/filed album entry/);
  });

  it('rejects a piece the economy does not know', () => {
    const [first] = rawAlbum(() => 0).sets;
    const stray = AlbumResponseSchema.parse({
      sets: [
        { ...first, entries: [{ id: 'mysteryDoubloon', kind: 'coinSkin', owned: true, count: 1 }] },
      ],
    });
    expect(() => albumView(stray)).toThrow();
  });
});

describe('setProgress', () => {
  it('runs from 0 to 1', () => {
    expect(setProgress({ owned: 0, total: 6 })).toBe(0);
    expect(setProgress({ owned: 3, total: 6 })).toBe(0.5);
    expect(setProgress({ owned: 6, total: 6 })).toBe(1);
  });

  it('is 0 for an empty set and never exceeds 1', () => {
    expect(setProgress({ owned: 0, total: 0 })).toBe(0);
    expect(setProgress({ owned: 9, total: 6 })).toBe(1);
  });
});

describe('newlyCompleted', () => {
  it('celebrates every complete set on a first visit', () => {
    expect(newlyCompleted(null, allDone)).toEqual(album.map((set) => set.id));
  });

  it('has nothing to celebrate on a first visit with no complete set', () => {
    expect(newlyCompleted(null, nothing)).toEqual([]);
  });

  it('celebrates only the sets finished since the last visit', () => {
    expect(newlyCompleted([deck.id], allDone)).toEqual([captains.id, gala.id]);
    expect(newlyCompleted([deck.id], deckDone)).toEqual([]);
  });

  it('ignores stale ids and does not re-celebrate a set seen before', () => {
    expect(newlyCompleted(['retiredSet', ...completedSetIds(allDone)], allDone)).toEqual([]);
    expect(newlyCompleted([], deckDone)).toEqual([deck.id]);
  });
});

describe('bonusBefore', () => {
  it('leaves out the sets still waiting for their fanfare', () => {
    expect(bonusBefore(allDone, [gala.id])).toBeCloseTo(deck.globalBonus + captains.globalBonus);
    expect(bonusBefore(allDone, [])).toBeCloseTo(allDone.bonus);
    expect(bonusBefore(allDone, completedSetIds(allDone))).toBe(0);
  });
});

describe('lore targets', () => {
  const galaFull = allDone.sets.find((set) => set.id === gala.id);
  const galaEmpty = nothing.sets.find((set) => set.id === gala.id);
  if (!galaFull || !galaEmpty) throw new Error('fixture lacks the gala set');
  const heirloom = galaFull.slots.find((slot) => slot.id === HEIRLOOM);
  const missingHeirloom = galaEmpty.slots.find((slot) => slot.id === HEIRLOOM);
  const plain = galaFull.slots.find((slot) => slot.rarity !== 'heirloom');

  it('knows the economy heirlooms', () => {
    expect(HEIRLOOM_IDS).toContain(HEIRLOOM);
  });

  it('opens an owned heirloom only', () => {
    if (!heirloom || !missingHeirloom || !plain) throw new Error('fixture lacks slots');
    expect(slotLore(heirloom, gala.id)).toEqual({ kind: 'heirloom', id: HEIRLOOM, set: gala.id });
    expect(slotLore(missingHeirloom, gala.id)).toBeNull();
    expect(slotLore(plain, gala.id)).toBeNull();
  });

  it('opens a completed set only', () => {
    expect(setLore(galaFull)).toEqual({ kind: 'set', id: gala.id });
    expect(setLore(galaEmpty)).toBeNull();
  });
});
