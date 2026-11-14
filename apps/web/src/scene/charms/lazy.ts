import type * as CharmViews from './index.ts';

/**
 * The charm views are not in the initial bundle: the board loads them the first time a charm
 * is placed. Import this module, never `./index.ts`, from outside the folder.
 */
export function loadCharmViews(): Promise<typeof CharmViews> {
  return import('./index.ts');
}
