import { registerCratesStrings } from '../../game/crates/i18n.ts';
import {
  LANGUAGES,
  type I18n,
  type InterpolationValues,
  type Language,
  type ResourceTree,
} from '../../i18n/index.ts';
import de from '../../i18n/locales/de/fair.json';
import en from '../../i18n/locales/en/fair.json';
import fr from '../../i18n/locales/fr/fair.json';

export const FAIR_NAMESPACE = 'fair';

export const FAIR_STRINGS: Readonly<Record<Language, ResourceTree>> = { en, fr, de };

type Plural<K extends string> = K extends `${infer Base}_${'one' | 'many' | 'other'}` ? Base : K;

type Leaves<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string
    ? `${Prefix}${Plural<K>}`
    : Leaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

/** Every key in the EN bundle, plural suffixes folded into their base. */
export type FairKey = Leaves<typeof en>;

export function fairKey(key: FairKey): string {
  return `${FAIR_NAMESPACE}:${key}`;
}

export type FairT = (key: FairKey, values?: InterpolationValues) => string;

export function fairT(i18n: I18n): FairT {
  return (key, values) => i18n.t(fairKey(key), values);
}

/** Also registers the crate strings, whose rarity names the tables reuse. */
export function registerFairStrings(i18n: I18n): void {
  registerCratesStrings(i18n);
  for (const language of LANGUAGES) {
    i18n.addResourceBundle(language, FAIR_NAMESPACE, FAIR_STRINGS[language]);
  }
}
