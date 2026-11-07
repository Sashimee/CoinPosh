import { describe, expect, it, vi } from 'vitest';
import { cascade, upgradeLines } from '../app/economy.ts';
import { MIXER_BUSES, MOTION_OPTIONS, QUALITY_OPTIONS } from '../app/settings.ts';
import { createI18n, detectLanguage, LANGUAGES, type ResourceTree } from './core.ts';
import { BUNDLED_RESOURCES } from './index.ts';

function leafKeys(tree: ResourceTree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string' ? [`${prefix}${key}`] : leafKeys(value, `${prefix}${key}.`),
  );
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1] ?? '').sort();
}

function stringAt(tree: ResourceTree, path: string): string {
  let node: string | ResourceTree | undefined = tree;
  for (const part of path.split('.')) {
    if (node === undefined || typeof node === 'string') break;
    node = node[part];
  }
  if (typeof node !== 'string') throw new Error(`${path} is not a string`);
  return node;
}

const enUi = BUNDLED_RESOURCES.en.ui;
if (!enUi) throw new Error('English ui bundle is missing');
const englishKeys = leafKeys(enUi).sort();

describe('bundled locales', () => {
  it.each(LANGUAGES.filter((language) => language !== 'en'))(
    '%s has exactly the English keys with the same placeholders',
    (language) => {
      const tree = BUNDLED_RESOURCES[language].ui;
      if (!tree) throw new Error(`${language} ui bundle is missing`);
      expect(leafKeys(tree).sort()).toEqual(englishKeys);
      for (const key of englishKeys) {
        expect(placeholders(stringAt(tree, key)), `${language}:${key}`).toEqual(
          placeholders(stringAt(enUi, key)),
        );
      }
    },
  );

  it('has no empty strings', () => {
    for (const language of LANGUAGES) {
      const tree = BUNDLED_RESOURCES[language].ui;
      if (!tree) throw new Error(`${language} ui bundle is missing`);
      for (const key of leafKeys(tree)) expect(stringAt(tree, key).trim(), key).not.toBe('');
    }
  });

  it('covers every literal key the UI asks for', () => {
    const sources = import.meta.glob<string>(
      ['../ui/**/*.ts', '../app/**/*.ts', '!../**/*.test.ts'],
      { query: '?raw', import: 'default', eager: true },
    );
    const i18n = createI18n({ language: 'en', resources: BUNDLED_RESOURCES });
    const used = new Set<string>();
    for (const source of Object.values(sources)) {
      for (const match of source.matchAll(/\b(?:tr\(ctx, |\.t\()'([a-zA-Z.]+)'/g)) {
        if (match[1]) used.add(match[1]);
      }
    }
    expect(used.size).toBeGreaterThan(40);
    const missing = [...used].filter((key) => !i18n.exists(key));
    expect(missing).toEqual([]);
  });

  it.each(LANGUAGES)(
    '%s covers every key the UI builds from economy and settings data',
    (language) => {
      const tree = BUNDLED_RESOURCES[language].ui;
      if (!tree) throw new Error(`${language} ui bundle is missing`);
      const leaves = new Set(leafKeys(tree));
      const has = (key: string): boolean => leaves.has(key) || leaves.has(`${key}_other`);
      const templated = [
        ...upgradeLines.flatMap((line) => [
          `upgrades.line.${line.id}.name`,
          `upgrades.line.${line.id}.description`,
          `currency.${line.currency}`,
        ]),
        ...cascade.tiers.map((tier) => `combo.tier.${tier.id}`),
        ...QUALITY_OPTIONS.map((value) => `settings.qualityOption.${value}`),
        ...MOTION_OPTIONS.map((value) => `settings.motion.${value}`),
        ...MIXER_BUSES.map((bus) => `settings.${bus}`),
        ...LANGUAGES.map((value) => `settings.languageName.${value}`),
      ];
      expect(upgradeLines.length).toBeGreaterThan(0);
      expect(cascade.tiers.length).toBeGreaterThan(0);
      expect(templated.filter((key) => !has(key))).toEqual([]);
    },
  );
});

const resources = {
  en: {
    ui: {
      hello: 'Hello {{name}}',
      coins_one: '{{count}} coin',
      coins_other: '{{count}} coins',
      onlyEnglish: 'Fallback',
      nested: { deep: 'Deep' },
    },
  },
  fr: {
    ui: {
      hello: 'Bonjour {{name}}',
      coins_one: '{{count}} pièce',
      coins_other: '{{count}} pièces',
      nested: { deep: 'Profond' },
    },
  },
  de: { ui: { hello: 'Hallo {{name}}' } },
};

describe('createI18n', () => {
  it('interpolates values and leaves unknown placeholders intact', () => {
    const i18n = createI18n({ language: 'en', resources });
    expect(i18n.t('hello', { name: 'Ada' })).toBe('Hello Ada');
    expect(i18n.t('hello')).toBe('Hello {{name}}');
  });

  it('picks plural forms with each language’s rules', () => {
    const i18n = createI18n({ language: 'en', resources });
    expect(i18n.t('coins', { count: 1 })).toBe('1 coin');
    expect(i18n.t('coins', { count: 0 })).toBe('0 coins');
    i18n.changeLanguage('fr');
    // French treats 0 and 1 as singular.
    expect(i18n.t('coins', { count: 0 })).toBe('0 pièce');
    expect(i18n.t('coins', { count: 2 })).toBe('2 pièces');
  });

  it('falls back to English, then to the key, reporting the miss', () => {
    const onMissingKey = vi.fn();
    const i18n = createI18n({ language: 'de', resources, onMissingKey });
    expect(i18n.t('onlyEnglish')).toBe('Fallback');
    expect(i18n.t('nested.deep')).toBe('Deep');
    expect(i18n.t('nope.nothing')).toBe('nope.nothing');
    expect(onMissingKey).toHaveBeenCalledWith('nope.nothing', 'de');
  });

  it('reads one string in another language with lng', () => {
    const i18n = createI18n({ language: 'en', resources });
    expect(i18n.t('hello', { name: 'A', lng: 'fr' })).toBe('Bonjour A');
    expect(i18n.language).toBe('en');
  });

  it('notifies listeners on change and rejects unsupported languages', () => {
    const i18n = createI18n({ language: 'en', resources });
    const listener = vi.fn();
    const off = i18n.onLanguageChanged(listener);
    i18n.changeLanguage('de');
    i18n.changeLanguage('de');
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    i18n.changeLanguage('fr');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(() => {
      i18n.changeLanguage('es' as never);
    }).toThrow(/Unsupported language "es"/);
  });

  it('lets another layer add a namespace such as net', () => {
    const i18n = createI18n({ language: 'fr', resources });
    i18n.addResourceBundle('en', 'net', { offline: 'Offline' });
    i18n.addResourceBundle('fr', 'net', { offline: 'Hors ligne' });
    expect(i18n.t('net:offline')).toBe('Hors ligne');
    i18n.addResourceBundle('fr', 'ui', { extra: 'En plus' });
    expect(i18n.t('extra')).toBe('En plus');
    expect(i18n.t('nested.deep')).toBe('Profond');
  });
});

describe('detectLanguage', () => {
  it('matches primary subtags in preference order', () => {
    expect(detectLanguage(['es-ES', 'fr-CA', 'de'])).toBe('fr');
    expect(detectLanguage(['DE-at'])).toBe('de');
  });

  it('falls back to English', () => {
    expect(detectLanguage([])).toBe('en');
    expect(detectLanguage(['ja', 'pt-BR'])).toBe('en');
  });
});
