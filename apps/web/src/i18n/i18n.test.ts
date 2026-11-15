import { describe, expect, it, vi } from 'vitest';
import { cascade, upgradeLines } from '@coinposh/economy';
import { MIXER_BUSES, MOTION_OPTIONS, QUALITY_OPTIONS } from '../app/settings.ts';
import {
  createI18n,
  createNamespaceLoader,
  detectLanguage,
  LANGUAGES,
  localeFile,
  resourcesFromFiles,
  type ResourceTree,
} from './core.ts';
import { BUNDLED_RESOURCES, i18n as appI18n, loadNamespace } from './index.ts';

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

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

function pluralBases(keys: string[]): string[] {
  return [
    ...new Set(
      keys.filter((key) => PLURAL_SUFFIX.test(key)).map((key) => key.replace(PLURAL_SUFFIX, '')),
    ),
  ].sort();
}

function withoutPlurals(keys: string[]): string[] {
  return keys.filter((key) => !PLURAL_SUFFIX.test(key)).sort();
}

const enUi = BUNDLED_RESOURCES.en.ui;
if (!enUi) throw new Error('English ui bundle is missing');
const englishKeys = leafKeys(enUi).sort();
const englishPluralBases = pluralBases(englishKeys);

describe('bundled locales', () => {
  it.each(LANGUAGES.filter((language) => language !== 'en'))(
    '%s has exactly the English keys with the same placeholders',
    (language) => {
      const tree = BUNDLED_RESOURCES[language].ui;
      if (!tree) throw new Error(`${language} ui bundle is missing`);
      const keys = leafKeys(tree);
      expect(withoutPlurals(keys)).toEqual(withoutPlurals(englishKeys));
      expect(pluralBases(keys)).toEqual(englishPluralBases);
      for (const key of keys) {
        const englishKey = PLURAL_SUFFIX.test(key) ? key.replace(PLURAL_SUFFIX, '_other') : key;
        expect(placeholders(stringAt(tree, key)), `${language}:${key}`).toEqual(
          placeholders(stringAt(enUi, englishKey)),
        );
      }
    },
  );

  it.each(LANGUAGES)('%s defines every plural category its language uses', (language) => {
    const tree = BUNDLED_RESOURCES[language].ui;
    if (!tree) throw new Error(`${language} ui bundle is missing`);
    const leaves = new Set(leafKeys(tree));
    const categories = new Intl.PluralRules(language).resolvedOptions().pluralCategories;
    expect(englishPluralBases.length).toBeGreaterThan(0);
    const missing = englishPluralBases.flatMap((base) =>
      categories.map((category) => `${base}_${category}`).filter((key) => !leaves.has(key)),
    );
    expect(missing).toEqual([]);
  });

  it('does not fall back to English for French counts in the millions', () => {
    const i18n = createI18n({ language: 'fr', resources: BUNDLED_RESOURCES });
    expect(new Intl.PluralRules('fr').select(1_000_000)).toBe('many');
    for (const base of englishPluralBases) {
      const options = { count: 1_000_000, value: '1 000 000' };
      expect(i18n.t(base, options), base).not.toBe(i18n.t(base, { ...options, lng: 'en' }));
    }
  });

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
      const plural = upgradeLines.map((line) => `currency.${line.currency}`);
      const templated = [
        ...upgradeLines.flatMap((line) => [
          `upgrades.line.${line.id}.name`,
          `upgrades.line.${line.id}.description`,
        ]),
        ...cascade.tiers.map((tier) => `combo.tier.${tier.id}`),
        ...QUALITY_OPTIONS.map((value) => `settings.qualityOption.${value}`),
        ...MOTION_OPTIONS.map((value) => `settings.motion.${value}`),
        ...MIXER_BUSES.map((bus) => `settings.${bus}`),
        ...LANGUAGES.map((value) => `settings.languageName.${value}`),
      ];
      expect(upgradeLines.length).toBeGreaterThan(0);
      expect(cascade.tiers.length).toBeGreaterThan(0);
      expect(templated.filter((key) => !leaves.has(key))).toEqual([]);
      expect(
        plural.filter((key) => !leaves.has(`${key}_one`) || !leaves.has(`${key}_other`)),
      ).toEqual([]);
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
  it('is backed by an initialised i18next instance that resolves synchronously', () => {
    const i18n = createI18n({ language: 'fr', resources });
    expect(i18n.instance.isInitialized).toBe(true);
    expect(i18n.instance.language).toBe('fr');
    expect(i18n.instance.t('hello', { name: 'Zoé' })).toBe('Bonjour Zoé');
    i18n.changeLanguage('de');
    expect(i18n.language).toBe('de');
    expect(i18n.t('hello', { name: 'Jo' })).toBe('Hallo Jo');
  });

  it('starts, translates and switches without writing to the console', () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    try {
      const i18n = createI18n({ language: 'en', resources: BUNDLED_RESOURCES });
      i18n.t('app.name');
      i18n.changeLanguage('fr');
      i18n.t('app.name');
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('does not HTML-escape interpolated values, since the UI writes textContent', () => {
    const i18n = createI18n({ language: 'en', resources });
    expect(i18n.t('hello', { name: 'A & B <C>' })).toBe('Hello A & B <C>');
  });

  it('rejects an unsupported starting language', () => {
    expect(() => createI18n({ language: 'es' as never, resources })).toThrow(
      /Unsupported language "es"/,
    );
  });

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
    expect(onMissingKey).toHaveBeenCalledTimes(1);
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

const LOCALE_FILES = resourcesFromFiles(
  import.meta.glob<ResourceTree>('./locales/*/*.json', { eager: true, import: 'default' }),
);
const NAMESPACES = [
  ...new Set(LANGUAGES.flatMap((language) => Object.keys(LOCALE_FILES[language]))),
].sort();

function namespaceTree(language: (typeof LANGUAGES)[number], namespace: string): ResourceTree {
  const tree = LOCALE_FILES[language][namespace];
  if (!tree) throw new Error(`locales/${language}/${namespace}.json is missing`);
  return tree;
}

describe('every locale namespace', () => {
  it('finds the namespaces on disk, ui among them', () => {
    expect(NAMESPACES).toEqual(expect.arrayContaining(['account', 'fair', 'ui']));
  });

  it.each(NAMESPACES)('%s ships a file in every language', (namespace) => {
    const missing = LANGUAGES.filter((language) => !LOCALE_FILES[language][namespace]);
    expect(missing).toEqual([]);
  });

  it.each(
    NAMESPACES.flatMap((namespace) => LANGUAGES.map((language) => [namespace, language] as const)),
  )('%s in %s has exactly the English keys and placeholders, none empty', (namespace, language) => {
    const english = namespaceTree('en', namespace);
    const tree = namespaceTree(language, namespace);
    const englishKeys = leafKeys(english);
    const keys = leafKeys(tree);
    expect(withoutPlurals(keys)).toEqual(withoutPlurals(englishKeys));
    expect(pluralBases(keys)).toEqual(pluralBases(englishKeys));
    const categories = new Intl.PluralRules(language).resolvedOptions().pluralCategories;
    const leaves = new Set(keys);
    const missingPlurals = pluralBases(englishKeys).flatMap((base) =>
      categories.map((category) => `${base}_${category}`).filter((key) => !leaves.has(key)),
    );
    expect(missingPlurals).toEqual([]);
    for (const key of keys) {
      const text = stringAt(tree, key);
      expect(text.trim(), `${language}:${namespace}:${key}`).not.toBe('');
      const englishKey = PLURAL_SUFFIX.test(key) ? key.replace(PLURAL_SUFFIX, '_other') : key;
      expect(placeholders(text), `${language}:${namespace}:${key}`).toEqual(
        placeholders(stringAt(english, englishKey)),
      );
    }
  });
});

describe('localeFile', () => {
  it('reads the language and namespace from the path', () => {
    expect(localeFile('./locales/fr/account.json')).toEqual({
      language: 'fr',
      namespace: 'account',
    });
    expect(localeFile('/src/i18n/locales/de/vaultTour.json')).toEqual({
      language: 'de',
      namespace: 'vaultTour',
    });
  });

  it('refuses files outside the layout, other languages and bad namespace names', () => {
    expect(() => localeFile('./strings/en/ui.json')).toThrow(/not at locales\/<language>/);
    expect(() => localeFile('./locales/es/ui.json')).toThrow(/unsupported language "es"/);
    expect(() => localeFile('./locales/en/Ui.json')).toThrow(/invalid namespace "Ui"/);
  });
});

const SAMPLE_STRINGS = {
  en: {
    greeting: 'Welcome to the {{room}}',
    chips_one: '{{count}} chip',
    chips_other: '{{count}} chips',
  },
  fr: {
    greeting: 'Bienvenue au {{room}}',
    chips_one: '{{count}} jeton',
    chips_other: '{{count}} jetons',
  },
  de: {
    greeting: 'Willkommen im {{room}}',
    chips_one: '{{count}} Chip',
    chips_other: '{{count}} Chips',
  },
} as const satisfies Record<(typeof LANGUAGES)[number], ResourceTree>;

function sampleLoaders(languages: readonly (typeof LANGUAGES)[number][] = LANGUAGES) {
  const calls: string[] = [];
  const loaders = Object.fromEntries(
    languages.map((language) => [
      `./locales/${language}/sample.json`,
      () => {
        calls.push(language);
        return Promise.resolve<ResourceTree>(SAMPLE_STRINGS[language]);
      },
    ]),
  );
  return { calls, loaders };
}

/** i18next keeps the resource objects it is handed and writes added bundles into them. */
function freshResources(): typeof resources {
  return structuredClone(resources);
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createNamespaceLoader', () => {
  it('fetches only the active language and the fallback, once', async () => {
    const i18n = createI18n({ language: 'fr', resources: freshResources() });
    const { calls, loaders } = sampleLoaders();
    const load = createNamespaceLoader(i18n, loaders);
    expect(i18n.exists('sample:greeting')).toBe(false);
    await Promise.all([load('sample'), load('sample')]);
    await load('sample');
    expect(calls.sort()).toEqual(['en', 'fr']);
    expect(i18n.t('sample:greeting', { room: 'Salon' })).toBe('Bienvenue au Salon');
    expect(i18n.t('sample:chips', { count: 1 })).toBe('1 jeton');
    expect(i18n.t('sample:greeting', { room: 'Salon', lng: 'en' })).toBe('Welcome to the Salon');
    expect(i18n.instance.hasResourceBundle('de', 'sample')).toBe(false);
  });

  it('fetches a single file for a player who reads the fallback language', async () => {
    const i18n = createI18n({ language: 'en', resources: freshResources() });
    const { calls, loaders } = sampleLoaders();
    await createNamespaceLoader(i18n, loaders)('sample');
    expect(calls).toEqual(['en']);
    expect(i18n.t('sample:chips', { count: 2 })).toBe('2 chips');
  });

  it('fetches the new language of every loaded namespace on a switch, reading the fallback until it lands', async () => {
    const i18n = createI18n({ language: 'en', resources: freshResources() });
    const german = deferred<ResourceTree>();
    const { calls, loaders } = sampleLoaders();
    const load = createNamespaceLoader(i18n, {
      ...loaders,
      './locales/de/sample.json': () => {
        calls.push('de');
        return german.promise;
      },
    });
    await load('sample');
    const listener = vi.fn();
    i18n.onLanguageChanged(listener);
    i18n.changeLanguage('de');
    expect(calls).toEqual(['en', 'de']);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(i18n.t('sample:chips', { count: 3 })).toBe('3 chips');
    expect(i18n.t('hello', { name: 'Jo' })).toBe('Hallo Jo');
    german.resolve(SAMPLE_STRINGS.de);
    await load('sample');
    expect(i18n.t('sample:chips', { count: 3 })).toBe('3 Chips');
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith('de');
    i18n.changeLanguage('en');
    i18n.changeLanguage('de');
    await load('sample');
    expect(calls).toEqual(['en', 'de']);
    expect(i18n.instance.hasResourceBundle('fr', 'sample')).toBe(false);
  });

  it('leaves a namespace nobody asked for alone on a switch', async () => {
    const i18n = createI18n({ language: 'en', resources: freshResources() });
    const { calls, loaders } = sampleLoaders();
    createNamespaceLoader(i18n, loaders);
    i18n.changeLanguage('fr');
    await settled();
    expect(calls).toEqual([]);
  });

  it('awaits the active language before resolving', async () => {
    const i18n = createI18n({ language: 'de', resources: freshResources() });
    const german = deferred<ResourceTree>();
    const load = createNamespaceLoader(i18n, {
      ...sampleLoaders().loaders,
      './locales/de/sample.json': () => german.promise,
    });
    let done = false;
    const loading = load('sample').then(() => {
      done = true;
    });
    await settled();
    expect(done).toBe(false);
    german.resolve(SAMPLE_STRINGS.de);
    await loading;
    expect(i18n.t('sample:greeting', { room: 'Salon' })).toBe('Willkommen im Salon');
  });

  it('resolves at once for a namespace every language already holds', async () => {
    const i18n = createI18n({ language: 'en', resources: structuredClone(BUNDLED_RESOURCES) });
    const { calls, loaders } = sampleLoaders();
    await createNamespaceLoader(i18n, loaders)('ui');
    expect(calls).toEqual([]);
  });

  it('rejects a namespace with no files, or missing any language, naming the file to add', async () => {
    const i18n = createI18n({ language: 'en', resources: freshResources() });
    const { calls, loaders } = sampleLoaders(['en', 'fr']);
    const load = createNamespaceLoader(i18n, loaders);
    await expect(load('nowhere')).rejects.toThrow(/No locale files for namespace "nowhere"/);
    await expect(load('sample')).rejects.toThrow(/add locales\/de\/sample\.json/);
    expect(calls).toEqual([]);
    expect(i18n.exists('sample:greeting')).toBe(false);
  });

  it('tries a failed load again on the next call', async () => {
    const i18n = createI18n({ language: 'fr', resources: freshResources() });
    let failures = 1;
    const load = createNamespaceLoader(i18n, {
      ...sampleLoaders().loaders,
      './locales/fr/sample.json': () => {
        if (failures-- > 0) return Promise.reject(new Error('chunk failed to load'));
        return Promise.resolve(SAMPLE_STRINGS.fr);
      },
    });
    await expect(load('sample')).rejects.toThrow('chunk failed to load');
    await load('sample');
    expect(i18n.t('sample:greeting', { room: 'bar' })).toBe('Bienvenue au bar');
  });

  it('reports a failed fetch after a switch and retries it on the next call', async () => {
    const i18n = createI18n({ language: 'en', resources: freshResources() });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let failures = 1;
    const load = createNamespaceLoader(i18n, {
      ...sampleLoaders().loaders,
      './locales/de/sample.json': () => {
        if (failures-- > 0) return Promise.reject(new Error('chunk failed to load'));
        return Promise.resolve(SAMPLE_STRINGS.de);
      },
    });
    await load('sample');
    i18n.changeLanguage('de');
    await settled();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('The de strings for "sample" did not load'),
      expect.any(Error),
    );
    error.mockRestore();
    expect(i18n.t('sample:chips', { count: 1 })).toBe('1 chip');
    await load('sample');
    expect(i18n.t('sample:chips', { count: 1 })).toBe('1 Chip');
  });

  it('refuses a locale file for an unsupported language when it is set up', () => {
    const i18n = createI18n({ language: 'en', resources: freshResources() });
    expect(() =>
      createNamespaceLoader(i18n, { './locales/es/sample.json': () => Promise.resolve({}) }),
    ).toThrow(/unsupported language "es"/);
  });
});

describe('loadNamespace', () => {
  it.each(['account', 'fair'])(
    'loads the %s files from locales/<language>/ for the active language',
    async (namespace) => {
      const [key] = leafKeys(namespaceTree('en', namespace));
      if (key === undefined) throw new Error(`${namespace} has no strings`);
      try {
        for (const language of LANGUAGES) {
          appI18n.changeLanguage(language);
          await loadNamespace(namespace);
          expect(appI18n.t(`${namespace}:${key}`)).toBe(
            stringAt(namespaceTree(language, namespace), key),
          );
        }
      } finally {
        appI18n.changeLanguage('en');
      }
    },
  );

  it('keeps ui bundled for the first paint and resolves it without a fetch', async () => {
    for (const language of LANGUAGES) {
      expect(appI18n.instance.hasResourceBundle(language, 'ui')).toBe(true);
    }
    await expect(loadNamespace('ui')).resolves.toBeUndefined();
  });
});
