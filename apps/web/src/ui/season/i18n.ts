import {
  createNamespaceLoader,
  type I18n,
  type InterpolationValues,
  type LoadNamespace,
  type ResourceTree,
} from '../../i18n/index.ts';
import type en from '../../i18n/locales/en/season.json';

export const SEASON_NAMESPACE = 'season';

const SEASON_FILES = import.meta.glob<ResourceTree>('../../i18n/locales/*/season.json', {
  import: 'default',
});

const loaders = new WeakMap<I18n, LoadNamespace>();

/**
 * Loads the `season` namespace into `i18n` through the shared namespace loader, each language
 * its own lazy chunk, so the strings ship with the panel and never with the first paint.
 */
export function loadSeasonStrings(i18n: I18n): Promise<void> {
  let load = loaders.get(i18n);
  if (load === undefined) {
    load = createNamespaceLoader(i18n, SEASON_FILES);
    loaders.set(i18n, load);
  }
  return load(SEASON_NAMESPACE);
}

type PluralSuffix = '_one' | '_many' | '_other';
type Base<K extends string> = K extends `${infer Stem}${PluralSuffix}` ? Stem : K;

type Leaves<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string
    ? `${Prefix}${Base<K>}`
    : Leaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

/** Every key in the EN bundle, plural forms folded into their base. */
export type SeasonKey = Leaves<typeof en>;

export function seasonKey(key: SeasonKey): string {
  return `${SEASON_NAMESPACE}:${key}`;
}

export type SeasonT = (key: SeasonKey, values?: InterpolationValues) => string;

export function seasonT(i18n: I18n): SeasonT {
  return (key, values) => i18n.t(seasonKey(key), values);
}
