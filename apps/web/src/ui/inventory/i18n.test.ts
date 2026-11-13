import { RARITIES } from '@coinposh/shared';
import { album } from '@coinposh/economy';
import { describe, expect, it } from 'vitest';
import {
  BUNDLED_RESOURCES,
  createI18n,
  LANGUAGES,
  type Language,
  type ResourceTree,
} from '../../i18n/index.ts';
import { itemName, rarityName } from './card.ts';
import { INVENTORY_STRINGS, inventoryKey, registerInventoryStrings } from './i18n.ts';
import { ITEM_KINDS, SORT_MODES } from './model.ts';

function leaves(tree: ResourceTree, prefix = ''): [string, string][] {
  return Object.entries(tree).flatMap(([key, value]): [string, string][] =>
    typeof value === 'string' ? [[`${prefix}${key}`, value]] : leaves(value, `${prefix}${key}.`),
  );
}

function setup(language: Language) {
  const i18n = createI18n({ language, resources: BUNDLED_RESOURCES });
  registerInventoryStrings(i18n);
  return i18n;
}

const pluralBase = (key: string): string => key.replace(/_(one|other|many)$/, '');

describe('inventory strings', () => {
  it('ships the same keys in every language, plural forms aside', () => {
    const en = new Set(leaves(INVENTORY_STRINGS.en).map(([key]) => pluralBase(key)));
    for (const language of LANGUAGES) {
      const keys = new Set(leaves(INVENTORY_STRINGS[language]).map(([key]) => pluralBase(key)));
      expect(keys, language).toEqual(en);
    }
  });

  it.each(LANGUAGES)('%s has no empty strings', (language) => {
    for (const [key, value] of leaves(INVENTORY_STRINGS[language])) {
      expect(value.trim(), key).not.toBe('');
    }
  });

  it.each(LANGUAGES)('%s resolves every key the panel builds from its data', (language) => {
    const i18n = setup(language);
    const keys = [
      inventoryKey('kind.all'),
      ...ITEM_KINDS.map((kind) => inventoryKey(`kind.${kind}`)),
      ...SORT_MODES.map((mode) => inventoryKey(`sort.${mode}`)),
      ...ITEM_KINDS.map((kind) => inventoryKey(`about.${kind}`)),
    ];
    expect(keys.filter((key) => !i18n.exists(key))).toEqual([]);
    const names = [
      ...album.flatMap((set) =>
        set.items.map((item) => itemName(i18n, { kind: 'charm', type: item.id })),
      ),
      itemName(i18n, { kind: 'safe', type: 'brassSafe' }),
      itemName(i18n, { kind: 'scratchCard', type: 'scratchCard' }),
      ...RARITIES.map((rarity) => rarityName(i18n, rarity)),
    ];
    expect(names.filter((name) => name.includes(':') || name.trim() === '')).toEqual([]);
  });

  it.each(LANGUAGES)('%s picks plural forms by count', (language) => {
    const i18n = setup(language);
    const one = i18n.t(inventoryKey('count.subtitle'), { count: 1 });
    const seven = i18n.t(inventoryKey('count.subtitle'), { count: 7 });
    expect(one).toContain('1');
    expect(seven).toContain('7');
    expect(one.replace('1', '')).not.toBe(seven.replace('7', ''));
    expect(i18n.t(inventoryKey('count.shown'), { count: 2 })).not.toContain('count.');
  });

  it.each(['fr', 'de'] as const)('%s is translated, not copied from English', (language) => {
    const i18n = setup(language);
    const keys = ['title', 'fuse', 'empty', 'retry', 'turnBack', 'equipped'] as const;
    const translated = keys.filter(
      (key) => i18n.t(inventoryKey(key)) !== INVENTORY_STRINGS.en[key],
    );
    expect(translated.length).toBeGreaterThanOrEqual(5);
  });
});
