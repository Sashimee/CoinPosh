import { createI18n, FALLBACK_LANGUAGE, type InterpolationValues, type Resources } from './core.ts';
import deUi from './locales/de/ui.json';
import enUi from './locales/en/ui.json';
import frUi from './locales/fr/ui.json';

export {
  createI18n,
  DEFAULT_NAMESPACE,
  detectLanguage,
  FALLBACK_LANGUAGE,
  isLanguage,
  LANGUAGES,
} from './core.ts';
export type {
  I18n,
  I18nOptions,
  InterpolationValues,
  Language,
  LanguageListener,
  Resources,
  ResourceTree,
} from './core.ts';
export * from './format.ts';

export const BUNDLED_RESOURCES: Resources = {
  en: { ui: enUi },
  fr: { ui: frUi },
  de: { ui: deUi },
};

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

export function t(key: string, values?: InterpolationValues): string {
  return i18n.t(key, values);
}
