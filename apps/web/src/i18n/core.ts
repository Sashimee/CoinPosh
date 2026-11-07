export const LANGUAGES = ['en', 'fr', 'de'] as const;
export type Language = (typeof LANGUAGES)[number];

export const FALLBACK_LANGUAGE: Language = 'en';
export const DEFAULT_NAMESPACE = 'ui';
const NAMESPACE_SEPARATOR = ':';
const KEY_SEPARATOR = '.';
const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

export interface ResourceTree {
  readonly [key: string]: string | ResourceTree;
}

export type Resources = Readonly<Record<Language, Readonly<Record<string, ResourceTree>>>>;

export type InterpolationValues = Readonly<Record<string, string | number>>;

export type LanguageListener = (language: Language) => void;

export interface I18n {
  readonly language: Language;
  /**
   * i18next-style lookup: `ns:path.to.key` (namespace defaults to `ui`), `{{name}}`
   * interpolation, `_one` / `_other` / … plural suffixes chosen by `count`, and an `lng`
   * value to read one string in another language.
   */
  t(key: string, values?: InterpolationValues): string;
  exists(key: string): boolean;
  changeLanguage(language: Language): void;
  /** Lets another module (e.g. the net layer's `net` namespace) ship its own strings. */
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

function splitKey(key: string): { namespace: string; path: string[] } {
  const at = key.indexOf(NAMESPACE_SEPARATOR);
  const namespace = at === -1 ? DEFAULT_NAMESPACE : key.slice(0, at);
  const path = (at === -1 ? key : key.slice(at + 1)).split(KEY_SEPARATOR);
  return { namespace, path };
}

function walk(tree: ResourceTree | undefined, path: readonly string[]): string | undefined {
  let node: string | ResourceTree | undefined = tree;
  for (const part of path) {
    if (node === undefined || typeof node === 'string') return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}

function interpolate(template: string, values: InterpolationValues | undefined): string {
  return template.replace(PLACEHOLDER, (match, name: string) => {
    const value = values?.[name];
    return value === undefined ? match : String(value);
  });
}

function mergeTrees(base: ResourceTree | undefined, extra: ResourceTree): ResourceTree {
  const merged: Record<string, string | ResourceTree> = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const existing = merged[key];
    merged[key] =
      typeof value === 'object' && typeof existing === 'object'
        ? mergeTrees(existing, value)
        : value;
  }
  return merged;
}

export function createI18n(options: I18nOptions): I18n {
  const store = new Map<Language, Map<string, ResourceTree>>();
  for (const language of LANGUAGES) {
    store.set(language, new Map(Object.entries(options.resources[language])));
  }
  const listeners = new Set<LanguageListener>();
  const pluralRules = new Map<Language, Intl.PluralRules>();
  let language = options.language;

  const rulesFor = (lng: Language): Intl.PluralRules => {
    let rules = pluralRules.get(lng);
    if (!rules) {
      rules = new Intl.PluralRules(lng);
      pluralRules.set(lng, rules);
    }
    return rules;
  };

  const lookup = (lng: Language, key: string, count: number | undefined): string | undefined => {
    const { namespace, path } = splitKey(key);
    const tree = store.get(lng)?.get(namespace);
    if (count !== undefined) {
      const last = path.length - 1;
      const withSuffix = (suffix: string): string[] =>
        path.map((part, i) => (i === last ? `${part}_${suffix}` : part));
      const plural =
        walk(tree, withSuffix(rulesFor(lng).select(count))) ?? walk(tree, withSuffix('other'));
      if (plural !== undefined) return plural;
    }
    return walk(tree, path);
  };

  const resolve = (
    key: string,
    count: number | undefined,
    lng: Language = language,
  ): string | undefined => lookup(lng, key, count) ?? lookup(FALLBACK_LANGUAGE, key, count);

  return {
    get language() {
      return language;
    },
    t(key, values) {
      const count = typeof values?.count === 'number' ? values.count : undefined;
      const lng = isLanguage(values?.lng) ? values.lng : language;
      const template = resolve(key, count, lng);
      if (template === undefined) {
        options.onMissingKey?.(key, lng);
        return key;
      }
      return interpolate(template, values);
    },
    exists(key) {
      return resolve(key, undefined) !== undefined || resolve(key, 1) !== undefined;
    },
    changeLanguage(next) {
      if (!isLanguage(next)) {
        throw new RangeError(
          `Unsupported language "${String(next)}"; use one of ${LANGUAGES.join(', ')}`,
        );
      }
      if (next === language) return;
      language = next;
      for (const listener of listeners) listener(next);
    },
    addResourceBundle(lng, namespace, resources) {
      const bundles = store.get(lng);
      if (!bundles)
        throw new RangeError(`Unsupported language "${lng}" for namespace ${namespace}`);
      bundles.set(namespace, mergeTrees(bundles.get(namespace), resources));
    },
    onLanguageChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
