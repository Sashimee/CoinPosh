import { album } from '@coinposh/economy';
import { COLLECTIBLE_KINDS, VENUE_IDS } from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import { cratesKey } from '../../game/crates/i18n.ts';
import {
  BUNDLED_RESOURCES,
  createI18n,
  LANGUAGES,
  type Language,
  type ResourceTree,
} from '../../i18n/index.ts';
import { ALBUM_STRINGS, albumKey, registerAlbumStrings, type AlbumKey } from './i18n.ts';
import { HEIRLOOM_IDS } from './model.ts';

function leaves(tree: ResourceTree, prefix = ''): [string, string][] {
  return Object.entries(tree).flatMap(([key, value]): [string, string][] =>
    typeof value === 'string' ? [[`${prefix}${key}`, value]] : leaves(value, `${prefix}${key}.`),
  );
}

function setup(language: Language) {
  const i18n = createI18n({ language, resources: BUNDLED_RESOURCES });
  registerAlbumStrings(i18n);
  return i18n;
}

const pluralBase = (key: string): string => key.replace(/_(one|other|many)$/, '');

describe('album strings', () => {
  it('ships the same keys in every language, plural forms aside', () => {
    const en = new Set(leaves(ALBUM_STRINGS.en).map(([key]) => pluralBase(key)));
    for (const language of LANGUAGES) {
      const keys = new Set(leaves(ALBUM_STRINGS[language]).map(([key]) => pluralBase(key)));
      expect(keys, language).toEqual(en);
    }
  });

  it.each(LANGUAGES)('%s has no empty strings', (language) => {
    for (const [key, value] of leaves(ALBUM_STRINGS[language])) {
      expect(value.trim(), key).not.toBe('');
    }
  });

  it.each(LANGUAGES)('%s resolves every key the album builds from its data', (language) => {
    const i18n = setup(language);
    const keys: AlbumKey[] = [
      ...VENUE_IDS.map((venue): AlbumKey => `venue.${venue}`),
      ...COLLECTIBLE_KINDS.map((kind): AlbumKey => `kind.${kind}`),
      ...album.map((set): AlbumKey => `lore.set.${set.id}`),
      ...HEIRLOOM_IDS.map((id): AlbumKey => `lore.item.${id}`),
    ];
    expect(keys.filter((key) => !i18n.exists(albumKey(key)))).toEqual([]);
    const names = [
      ...album.map((set) => i18n.t(cratesKey(`set.${set.id}`))),
      ...album.flatMap((set) => set.items.map((item) => i18n.t(cratesKey(`item.${item.id}`)))),
    ];
    expect(names.filter((name) => name.includes(':') || name.trim() === '')).toEqual([]);
  });

  it.each(LANGUAGES)('%s gives every heirloom and every set a story', (language) => {
    const i18n = setup(language);
    for (const id of HEIRLOOM_IDS) {
      expect(i18n.t(albumKey(`lore.item.${id}`)).length, id).toBeGreaterThan(80);
    }
    for (const set of album) {
      expect(i18n.t(albumKey(`lore.set.${set.id}`)).length, set.id).toBeGreaterThan(80);
    }
  });

  it.each(LANGUAGES)('%s picks plural forms by count and fills the values', (language) => {
    const i18n = setup(language);
    const one = i18n.t(albumKey('count.subtitle'), { count: 1, owned: 6, total: 19 });
    const two = i18n.t(albumKey('count.subtitle'), { count: 2, owned: 6, total: 19 });
    expect(one).toContain('19');
    expect(one).not.toContain('{{');
    expect(one.replace('1 ', '')).not.toBe(two.replace('2 ', ''));
  });

  it.each(LANGUAGES)('%s interpolates the bonus and fanfare lines', (language) => {
    const i18n = setup(language);
    expect(i18n.t(albumKey('bonusValue'), { value: '5 %' })).toContain('5 %');
    const fanfare = i18n.t(albumKey('fanfare'), { set: 'Gala', bonus: '+15 %' });
    expect(fanfare).toContain('Gala');
    expect(fanfare).toContain('+15 %');
  });

  it.each(['fr', 'de'] as const)('%s is translated, not copied from English', (language) => {
    const i18n = setup(language);
    const keys = ['title', 'loading', 'empty', 'retry', 'bonusLabel', 'loreClose'] as const;
    const translated = keys.filter((key) => i18n.t(albumKey(key)) !== ALBUM_STRINGS.en[key]);
    expect(translated.length).toBeGreaterThanOrEqual(5);
    for (const set of album) {
      expect(i18n.t(albumKey(`lore.set.${set.id}`))).not.toBe(ALBUM_STRINGS.en.lore.set[set.id]);
    }
  });
});
