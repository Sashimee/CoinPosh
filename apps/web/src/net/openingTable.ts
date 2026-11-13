import { openingHeap } from '@coinposh/economy';
import type { MintedCoin, StateResponse } from '@coinposh/shared';

/**
 * The server coins the sim lays as its opening heap, in sim id order. Demo Mode's mock and the
 * live server both mint the heap onto the table at sign-up and list it first, so the sim's
 * heap coin `i` is the snapshot's `i`th coin and its fall is claimed by that coin's ID. The
 * live server refunds every other table coin on a `hydrate=boot` snapshot, so a boot snapshot
 * holds nothing else; a coin that is not heap tier means it did not, and that coin would sit
 * on the server unclaimable.
 */
export function openingTableCoins(state: StateResponse): readonly MintedCoin[] {
  const stray = state.table.coins.find((coin) => coin.tier !== openingHeap.tier);
  if (stray !== undefined) {
    throw new Error(
      `CoinPosh boot: the table snapshot holds a ${stray.tier} coin (${stray.id}) beside the ${openingHeap.tier} opening heap, and the sim can only lay the heap. The server should have refunded it for this hydrate=boot snapshot (PlayerDO.refundStranded).`,
    );
  }
  return state.table.coins;
}
