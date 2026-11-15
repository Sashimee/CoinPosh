import type * as Prizes from './index.ts';

/**
 * The prize kit is not in the initial bundle: the table loads it the first time a prize drops.
 * Import this module, never `./index.ts`, from outside the folder.
 */
export function loadPrizes(): Promise<typeof Prizes> {
  return import('./index.ts');
}
