import type * as CoinVariants from './index.ts';

/**
 * The variant coin field is not in the initial bundle: the table loads it the first time a
 * variant coin is minted. Import this module, never `./index.ts`, from outside the folder.
 */
export function loadCoinVariants(): Promise<typeof CoinVariants> {
  return import('./index.ts');
}
