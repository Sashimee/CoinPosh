import { RARITIES } from '@coinposh/shared';
import { describe, expect, it, vi } from 'vitest';
import { cratesKey } from '../../game/crates/i18n.ts';
import {
  BUNDLED_RESOURCES,
  createI18n,
  LANGUAGES,
  type I18n,
  type Language,
  type ResourceTree,
} from '../../i18n/index.ts';
import de from '../../i18n/locales/de/fair.json';
import en from '../../i18n/locales/en/fair.json';
import fr from '../../i18n/locales/fr/fair.json';
import { FAIR_NAMESPACE, fairKey, fairT, loadFairStrings, type FairKey } from './i18n.ts';
import { FAIR_SOURCES, FAIR_TABS, VERIFY_FIELDS } from './model.ts';

function leaves(tree: ResourceTree, prefix = ''): [string, string][] {
  return Object.entries(tree).flatMap(([key, value]): [string, string][] =>
    typeof value === 'string' ? [[`${prefix}${key}`, value]] : leaves(value, `${prefix}${key}.`),
  );
}

const FAIR_STRINGS: Readonly<Record<Language, ResourceTree>> = { en, fr, de };

async function setup(language: Language) {
  // i18next stores added bundles in the resources object it was given, so each instance gets its own copy.
  const i18n = createI18n({ language, resources: structuredClone(BUNDLED_RESOURCES) });
  await loadFairStrings(i18n);
  return i18n;
}

const loaded = (i18n: I18n) =>
  LANGUAGES.filter((language) => i18n.instance.hasResourceBundle(language, FAIR_NAMESPACE));

const pluralBase = (key: string): string => key.replace(/_(one|other|many)$/, '');

describe('Certified Fair strings', () => {
  it('ships the same keys in every language, plural forms aside', () => {
    const en = new Set(leaves(FAIR_STRINGS.en).map(([key]) => pluralBase(key)));
    for (const language of LANGUAGES) {
      const keys = new Set(leaves(FAIR_STRINGS[language]).map(([key]) => pluralBase(key)));
      expect(keys, language).toEqual(en);
    }
  });

  it.each(LANGUAGES)('%s has no empty strings', (language) => {
    for (const [key, value] of leaves(FAIR_STRINGS[language])) {
      expect(value.trim(), key).not.toBe('');
    }
  });

  it.each(LANGUAGES)('%s keeps every placeholder English uses', (language) => {
    const placeholders = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
    const en = new Map(leaves(FAIR_STRINGS.en).map(([key, value]) => [pluralBase(key), value]));
    for (const [key, value] of leaves(FAIR_STRINGS[language])) {
      const reference = en.get(pluralBase(key)) ?? '';
      expect(placeholders(value).sort(), key).toEqual(placeholders(reference).sort());
    }
  });

  it.each(LANGUAGES)('%s resolves every key the panel builds from its data', async (language) => {
    const i18n = await setup(language);
    const keys: FairKey[] = [
      ...FAIR_TABS.map((tab): FairKey => `tab.${tab}`),
      ...FAIR_SOURCES.map((source): FairKey => `source.${source}`),
      ...VERIFY_FIELDS.map((field): FairKey => `verify.${field}`),
      ...VERIFY_FIELDS.map((field): FairKey => `verify.invalid.${field}`),
      'verify.mismatch.commitment',
      'verify.mismatch.clientSeed',
      'verify.unavailableTitle',
      'verify.cryptoUnavailable',
      'odds.rowLabel',
      'odds.totalLabel',
    ];
    expect(keys.filter((key) => !i18n.exists(fairKey(key)))).toEqual([]);
    const rarities = RARITIES.map((rarity) => i18n.t(cratesKey(`rarity.${rarity}`)));
    expect(rarities.filter((name) => name.includes(':') || name.trim() === '')).toEqual([]);
  });

  it.each([
    ['en', 'Rare: 12.5 %', 'Total: 100 %'],
    ['fr', 'Rare\u00a0: 12.5 %', 'Total\u00a0: 100 %'],
    ['de', 'Rare: 12.5 %', 'Summe: 100 %'],
  ] as const)(
    '%s builds the odds aria labels with its own punctuation',
    async (language, row, sum) => {
      const t = fairT(await setup(language));
      expect(t('odds.rowLabel', { rarity: 'Rare', share: '12.5 %' })).toBe(row);
      expect(t('odds.totalLabel', { total: t('odds.total'), share: '100 %' })).toBe(sum);
    },
  );

  it.each(LANGUAGES)('%s picks plural forms by count', async (language) => {
    const t = fairT(await setup(language));
    for (const key of [
      'verify.rolls',
      'pity.left',
      'pity.within',
      'verify.mismatch.unspent',
    ] as const) {
      const one = t(key, { count: 1 });
      const seven = t(key, { count: 7 });
      expect(one, key).toContain('1');
      expect(seven, key).toContain('7');
      expect(one.replace('1', ''), key).not.toBe(seven.replace('7', ''));
    }
  });

  it.each(['fr', 'de'] as const)('%s is translated, not copied from English', async (language) => {
    const t = fairT(await setup(language));
    const keys = ['title', 'tab.pity', 'verify.match', 'verify.rotate', 'pity.intro'] as const;
    const english = fairT(await setup('en'));
    expect(keys.filter((key) => t(key) === english(key))).toEqual([]);
  });
});

describe('loadFairStrings', () => {
  it('loads only English for an English player', async () => {
    expect(loaded(await setup('en'))).toEqual(['en']);
  });

  it.each(['fr', 'de'] as const)(
    'loads %s and the English fallback, never the third',
    async (language) => {
      expect(loaded(await setup(language))).toEqual(['en', language]);
    },
  );

  it('fetches the new language on a switch and redraws once it lands', async () => {
    const i18n = await setup('en');
    const heard: Language[] = [];
    i18n.onLanguageChanged((language) => heard.push(language));
    i18n.changeLanguage('de');
    await vi.waitFor(() => {
      expect(loaded(i18n)).toEqual(['en', 'de']);
    });
    expect(heard).toEqual(['de', 'de']);
    expect(fairT(i18n)('title')).toBe(de.title);
  });

  it('is safe to await again and keeps the crate rarity names', async () => {
    const i18n = await setup('fr');
    await loadFairStrings(i18n);
    expect(loaded(i18n)).toEqual(['en', 'fr']);
    expect(i18n.t(cratesKey('rarity.rare'))).not.toContain(':');
  });
});
