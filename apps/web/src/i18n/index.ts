import {
  createI18n,
  createNamespaceLoader,
  FALLBACK_LANGUAGE,
  resourcesFromFiles,
  type InterpolationValues,
  type LoadNamespace,
  type ResourceTree,
  type Resources,
} from './core.ts';

export {
  createI18n,
  createNamespaceLoader,
  DEFAULT_NAMESPACE,
  detectLanguage,
  FALLBACK_LANGUAGE,
  isLanguage,
  LANGUAGES,
  localeFile,
  resourcesFromFiles,
} from './core.ts';
export type {
  I18n,
  I18nOptions,
  InterpolationValues,
  Language,
  LanguageListener,
  LoadNamespace,
  LocaleFile,
  NamespaceLoaders,
  Resources,
  ResourceTree,
} from './core.ts';
export * from './format.ts';

/** The namespaces every page needs before its first paint; any other one loads on demand. */
export const BUNDLED_RESOURCES: Resources = resourcesFromFiles(
  import.meta.glob<ResourceTree>('./locales/*/ui.json', { eager: true, import: 'default' }),
);

const reportedMissing = new Set<string>();

/** The app-wide instance. Other namespaces (such as `net`) join through `addResourceBundle`. */
export const i18n = createI18n({
  language: FALLBACK_LANGUAGE,
  resources: BUNDLED_RESOURCES,
  onMissingKey(key, language) {
    const id = `${language}:${key}`;
    if (reportedMissing.has(id)) return;
    reportedMissing.add(id);
    console.warn(`[CoinPosh] i18n key "${key}" is missing for "${language}" and the fallback`);
  },
});

/**
 * Loads `locales/<language>/<namespace>.json` in every language into the app-wide instance, each
 * file its own chunk, so a feature's strings ship with the feature. Await it before the first
 * `t('<namespace>:…')`.
 */
export const loadNamespace: LoadNamespace = createNamespaceLoader(
  i18n,
  import.meta.glob<ResourceTree>(['./locales/*/*.json', '!./locales/*/ui.json'], {
    import: 'default',
  }),
);

export function t(key: string, values?: InterpolationValues): string {
  return i18n.t(key, values);
}
