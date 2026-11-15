import { registerCratesStrings } from '../../game/crates/i18n.ts';
import {
  createNamespaceLoader,
  type I18n,
  type InterpolationValues,
  type LoadNamespace,
  type ResourceTree,
} from '../../i18n/index.ts';
import type en from '../../i18n/locales/en/fair.json';

export const FAIR_NAMESPACE = 'fair';

/** One lazy chunk per language, so a player fetches only the translation they read. */
const FAIR_LOCALES = import.meta.glob<ResourceTree>('../../i18n/locales/*/fair.json', {
  import: 'default',
});

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

// One loader per instance: the loader follows its instance's language switches, and a test or
// preview may pass an instance other than the app-wide one that i18n/index.ts loadNamespace binds.
const loaders = new WeakMap<I18n, LoadNamespace>();

/**
 * Loads the fair strings in the active language and the fallback (later switches fetch the new
 * language), and registers the crate strings whose rarity names the tables reuse. Await it before
 * the first `t('fair:…')`.
 */
export function loadFairStrings(i18n: I18n): Promise<void> {
  registerCratesStrings(i18n);
  let load = loaders.get(i18n);
  if (load === undefined) {
    load = createNamespaceLoader(i18n, FAIR_LOCALES);
    loaders.set(i18n, load);
  }
  return load(FAIR_NAMESPACE);
}
