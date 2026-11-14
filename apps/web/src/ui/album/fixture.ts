import { album } from '@coinposh/economy';
import { AlbumResponseSchema, type AlbumResponse, type CollectibleKind } from '@coinposh/shared';

type ItemDef = (typeof album)[number]['items'][number];

function kindOf(item: ItemDef): CollectibleKind {
  if (item.id.endsWith('Charm')) return 'charm';
  return item.rarity === 'heirloom' ? 'heirloom' : 'coinSkin';
}

/** The album body as the server sends it, with `count(id, set)` copies of each piece. */
export function rawAlbum(count: (id: string, set: string) => number) {
  return {
    sets: album.map((set) => {
      const entries = set.items.map((item) => {
        const copies = count(item.id, set.id);
        return { id: item.id, kind: kindOf(item), owned: copies > 0, count: copies };
      });
      return { id: set.id, entries, completed: entries.every((entry) => entry.owned) };
    }),
  };
}

export function albumResponse(count: (id: string, set: string) => number): AlbumResponse {
  return AlbumResponseSchema.parse(rawAlbum(count));
}
