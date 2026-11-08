import { openingHeap } from '@coinposh/economy';
import type { MintedCoin, StateResponse } from '@coinposh/shared';

/**
 * The server coins the sim lays as its opening heap, in sim id order. Demo Mode's mock and the
 * live server both mint the heap onto the table at sign-up and list it first, so the sim's
 * heap coin `i` is the snapshot's `i`th heap-tier coin and its fall is claimed by that coin's ID.
 * The sim lays its heap in one tier and cannot place a returning player's other table coins
 * yet, so only heap-tier coins are laid.
 */
export function openingTableCoins(state: StateResponse): readonly MintedCoin[] {
  return state.table.coins.filter((coin) => coin.tier === openingHeap.tier);
}
