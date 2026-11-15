import i18next, { type i18n as I18next } from 'i18next';

export const LANGUAGES = ['en', 'fr', 'de'] as const;
export type Language = (typeof LANGUAGES)[number];

export const FALLBACK_LANGUAGE: Language = 'en';
export const DEFAULT_NAMESPACE = 'ui';

export interface ResourceTree {
  readonly [key: string]: string | ResourceTree;
}

export type Resources = Readonly<Record<Language, Readonly<Record<string, ResourceTree>>>>;

export type InterpolationValues = Readonly<Record<string, string | number>>;

export type LanguageListener = (language: Language) => void;

export interface I18n {
  readonly language: Language;
  /** The underlying i18next instance, for layers that want its full API. */
  readonly instance: I18next;
  /**
   * i18next lookup: `ns:path.to.key` (namespace defaults to `ui`), `{{name}}` interpolation,
   * `_one` / `_other` / … plural suffixes chosen by `count`, and `lng` to read one string in
   * another language.
   */
  t(key: string, values?: InterpolationValues): string;
  exists(key: string): boolean;
  changeLanguage(language: Language): void;
  /**
   * Lets another module (e.g. the net layer's `net` namespace) ship its own strings. A bundle in
   * the active language for a namespace that was missing it at the last language switch tells
   * the language listeners again, so they redraw.
   */
  addResourceBundle(language: Language, namespace: string, resources: ResourceTree): void;
  onLanguageChanged(listener: LanguageListener): () => void;
}

export interface I18nOptions {
  readonly language: Language;
  readonly resources: Resources;
  readonly onMissingKey?: (key: string, language: Language) => void;
}

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}

/** Picks the first supported language from a browser-style preference list (`fr-CA` → `fr`). */
export function detectLanguage(preferred: readonly string[]): Language {
  for (const tag of preferred) {
    const primary = tag.toLowerCase().split('-')[0];
    if (isLanguage(primary)) return primary;
  }
  return FALLBACK_LANGUAGE;
}

function requireLanguage(value: unknown): Language {
  if (!isLanguage(value)) {
    throw new RangeError(
      `Unsupported language "${String(value)}"; use one of ${LANGUAGES.join(', ')}`,
    );
  }
  return value;
}

export function createI18n(options: I18nOptions): I18n {
  const instance = i18next.createInstance();
  let language = requireLanguage(options.language);
  // With inline resources and initAsync off, init and changeLanguage settle synchronously, so
  // the UI can render translated text on its first paint.
  void instance.init({
    lng: language,
    fallbackLng: FALLBACK_LANGUAGE,
    supportedLngs: [...LANGUAGES],
    ns: [DEFAULT_NAMESPACE],
    defaultNS: DEFAULT_NAMESPACE,
    resources: options.resources,
    initAsync: false,
    returnEmptyString: false,
    interpolation: { escapeValue: false },
  });
  if (!instance.isInitialized) {
    throw new Error('i18next did not initialise synchronously; check that resources are inline');
  }

  const listeners = new Set<LanguageListener>();
  const notify = (next: Language): void => {
    for (const listener of [...listeners]) listener(next);
  };
  // Namespaces loaded in some language but not yet in the active one: when one arrives, the
  // listeners hear the language again so text drawn from the fallback redraws in the new one.
  let arriving = new Set<string>();
  instance.on('languageChanged', (next: string) => {
    if (!isLanguage(next) || next === language) return;
    language = next;
    arriving = new Set(
      Object.values(instance.store.data)
        .flatMap((namespaces) => Object.keys(namespaces))
        .filter((namespace) => !instance.hasResourceBundle(next, namespace)),
    );
    notify(next);
  });

  return {
    get language() {
      return language;
    },
    instance,
    t(key, values) {
      const lng = isLanguage(values?.lng) ? values.lng : language;
      if (options.onMissingKey && !instance.exists(key, { ...values, lng })) {
        options.onMissingKey(key, lng);
      }
      return instance.t(key, { ...values, lng });
    },
    exists(key) {
      return instance.exists(key) || instance.exists(key, { count: 1 });
    },
    changeLanguage(next) {
      void instance.changeLanguage(requireLanguage(next));
    },
    addResourceBundle(lng, namespace, resources) {
      instance.addResourceBundle(requireLanguage(lng), namespace, resources, true, true);
      if (lng === language && arriving.delete(namespace)) notify(language);
    },
    onLanguageChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const LOCALE_FILE = /(?:^|\/)locales\/([^/]+)\/([^/]+)\.json$/;
const NAMESPACE_NAME = /^[a-z][A-Za-z0-9_-]*$/;

export interface LocaleFile {
  readonly language: Language;
  readonly namespace: string;
}

/** Reads a locale file's language and namespace from its `locales/<language>/<ns>.json` path. */
export function localeFile(path: string): LocaleFile {
  const [, language, namespace] = LOCALE_FILE.exec(path) ?? [];
  if (language === undefined || namespace === undefined) {
    throw new Error(`Locale file ${path} is not at locales/<language>/<namespace>.json`);
  }
  if (!isLanguage(language)) {
    throw new Error(
      `Locale file ${path} is for unsupported language "${language}"; use one of ${LANGUAGES.join(', ')}`,
    );
  }
  if (!NAMESPACE_NAME.test(namespace)) {
    throw new Error(
      `Locale file ${path} has an invalid namespace "${namespace}"; start with a lowercase letter and use letters, digits, "_" or "-"`,
    );
  }
  return { language, namespace };
}

/** Builds inline resources from eagerly globbed locale files, keyed by their paths. */
export function resourcesFromFiles(files: Readonly<Record<string, ResourceTree>>): Resources {
  const resources: Record<Language, Record<string, ResourceTree>> = { en: {}, fr: {}, de: {} };
  for (const [path, tree] of Object.entries(files)) {
    const { language, namespace } = localeFile(path);
    resources[language][namespace] = tree;
  }
  return resources;
}

/** Lazy locale files keyed by path, as `import.meta.glob` hands them over. */
export type NamespaceLoaders = Readonly<Record<string, () => Promise<ResourceTree>>>;

export type LoadNamespace = (namespace: string) => Promise<void>;

/**
 * Loads a namespace's locale file in the active language and in FALLBACK_LANGUAGE, so a player
 * downloads one translation per namespace (two when theirs is not the fallback), never all of
 * them. A language switch fetches the new language for every namespace asked for so far; until
 * it lands, lookups read the fallback, never a raw key. Each file loads once and a failed load is
 * tried again by the next call. A namespace missing a language file is refused whatever the
 * active language, so a gap shows in any locale.
 */
export function createNamespaceLoader(i18n: I18n, loaders: NamespaceLoaders): LoadNamespace {
  const files = new Map<string, Map<Language, () => Promise<ResourceTree>>>();
  for (const [path, load] of Object.entries(loaders)) {
    const { language, namespace } = localeFile(path);
    const byLanguage = files.get(namespace) ?? new Map<Language, () => Promise<ResourceTree>>();
    byLanguage.set(language, load);
    files.set(namespace, byLanguage);
  }
  const requested = new Set<string>();
  const pending = new Map<string, Promise<void>>();

  function loadFile(namespace: string, language: Language): Promise<void> {
    if (i18n.instance.hasResourceBundle(language, namespace)) return Promise.resolve();
    const id = `${language}/${namespace}`;
    let loading = pending.get(id);
    if (loading === undefined) {
      const loadTree = files.get(namespace)?.get(language);
      if (loadTree === undefined) {
        return Promise.reject(
          new Error(
            `Namespace "${namespace}" has no ${language} strings; add locales/${language}/${namespace}.json`,
          ),
        );
      }
      loading = loadTree().then(
        (tree) => {
          i18n.addResourceBundle(language, namespace, tree);
        },
        (error: unknown) => {
          pending.delete(id);
          throw error;
        },
      );
      pending.set(id, loading);
    }
    return loading;
  }

  i18n.onLanguageChanged((language) => {
    for (const namespace of requested) {
      loadFile(namespace, language).catch((error: unknown) => {
        console.error(
          `[i18n] The ${language} strings for "${namespace}" did not load after a language switch; lookups read ${FALLBACK_LANGUAGE} until the next loadNamespace("${namespace}") retries.`,
          error,
        );
      });
    }
  });

  return async (namespace) => {
    if (LANGUAGES.every((language) => i18n.instance.hasResourceBundle(language, namespace))) return;
    const byLanguage = files.get(namespace);
    if (byLanguage === undefined) {
      throw new Error(
        `No locale files for namespace "${namespace}"; add locales/<language>/${namespace}.json for ${LANGUAGES.join(', ')}`,
      );
    }
    const missing = LANGUAGES.filter((language) => !byLanguage.has(language));
    if (missing.length > 0) {
      throw new Error(
        `Namespace "${namespace}" has no ${missing.join(', ')} strings; add ${missing.map((language) => `locales/${language}/${namespace}.json`).join(', ')}`,
      );
    }
    requested.add(namespace);
    const language = i18n.language;
    await Promise.all([language, FALLBACK_LANGUAGE].map((lng) => loadFile(namespace, lng)));
  };
}
