import { registerAscensionStrings } from '../../game/ascension/i18n.ts';
import {
  LANGUAGES,
  type I18n,
  type InterpolationValues,
  type Language,
  type ResourceTree,
} from '../../i18n/index.ts';
import de from '../../i18n/locales/de/account.json';
import en from '../../i18n/locales/en/account.json';
import fr from '../../i18n/locales/fr/account.json';

export const ACCOUNT_NAMESPACE = 'account';

export const ACCOUNT_STRINGS: Readonly<Record<Language, ResourceTree>> = { en, fr, de };

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

/** Also registers the ascension strings, whose venue names the progress choice reuses. */
export function registerAccountStrings(i18n: I18n): void {
  registerAscensionStrings(i18n);
  for (const language of LANGUAGES) {
    i18n.addResourceBundle(language, ACCOUNT_NAMESPACE, ACCOUNT_STRINGS[language]);
  }
}
