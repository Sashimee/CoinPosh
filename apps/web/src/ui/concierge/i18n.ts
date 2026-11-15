import type { ConciergeLineId } from '../../game/concierge/index.ts';
import {
  createNamespaceLoader,
  type I18n,
  type InterpolationValues,
  type LoadNamespace,
  type ResourceTree,
} from '../../i18n/index.ts';
import type en from '../../i18n/locales/en/concierge.json';

export const CONCIERGE_NAMESPACE = 'concierge';

const CONCIERGE_FILES = import.meta.glob<ResourceTree>('../../i18n/locales/*/concierge.json', {
  import: 'default',
});

const loaders = new WeakMap<I18n, LoadNamespace>();

/**
 * Loads the `concierge` namespace into `i18n`, each language its own lazy chunk, so the
 * Concierge's 145 lines ship with the character and never with the first paint.
 */
export function loadConciergeStrings(i18n: I18n): Promise<void> {
  let load = loaders.get(i18n);
  if (load === undefined) {
    load = createNamespaceLoader(i18n, CONCIERGE_FILES);
    loaders.set(i18n, load);
  }
  return load(CONCIERGE_NAMESPACE);
}

type Leaves<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

/** The card's own labels and the names it interpolates: every EN key outside the line table. */
export type ConciergeUiKey = Extract<Leaves<typeof en>, `card.${string}` | `names.${string}`>;

export function conciergeKey(key: ConciergeUiKey): string {
  return `${CONCIERGE_NAMESPACE}:${key}`;
}

/** `concierge:<lineId>.<variant>`, the key lines.ts promises every line id and variant. */
export function lineKey(lineId: ConciergeLineId, variant: number): string {
  return `${CONCIERGE_NAMESPACE}:${lineId}.${String(variant)}`;
}

export type ConciergeT = (key: ConciergeUiKey, values?: InterpolationValues) => string;

export function conciergeT(i18n: I18n): ConciergeT {
  return (key, values) => i18n.t(conciergeKey(key), values);
}
