import { registerAscensionStrings } from '../../game/ascension/i18n.ts';
import type { I18n, InterpolationValues, Language, ResourceTree } from '../../i18n/index.ts';
import en from '../../i18n/locales/en/account.json';

export const ACCOUNT_NAMESPACE = 'account';

/**
 * English is the fallback, so it ships with the account surface; French and German each load
 * only for a player who reads them, keeping two thirds of the strings off everyone else's wire.
 */
const TRANSLATIONS: Readonly<Record<Exclude<Language, 'en'>, () => Promise<ResourceTree>>> = {
  fr: () => import('../../i18n/locales/fr/account.json').then((module) => module.default),
  de: () => import('../../i18n/locales/de/account.json').then((module) => module.default),
};

type Leaves<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

/** Every key in the EN bundle. */
export type AccountKey = Leaves<typeof en>;

export function accountKey(key: AccountKey): string {
  return `${ACCOUNT_NAMESPACE}:${key}`;
}

export type AccountT = (key: AccountKey, values?: InterpolationValues) => string;

export function accountT(i18n: I18n): AccountT {
  return (key, values) => i18n.t(accountKey(key), values);
}

export function accountStrings(language: Language): Promise<ResourceTree> {
  return language === 'en' ? Promise.resolve(en) : TRANSLATIONS[language]();
}

/**
 * Registers English and `language`, plus the ascension strings, whose venue names the progress
 * choice reuses. Until another language's strings arrive, i18next reads them in English.
 */
export async function registerAccountStrings(i18n: I18n, language: Language): Promise<void> {
  registerAscensionStrings(i18n);
  i18n.addResourceBundle('en', ACCOUNT_NAMESPACE, en);
  if (language === 'en' || i18n.instance.hasResourceBundle(language, ACCOUNT_NAMESPACE)) return;
  i18n.addResourceBundle(language, ACCOUNT_NAMESPACE, await accountStrings(language));
}
