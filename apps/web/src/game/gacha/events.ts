import type { PityCounters, Rarity, Roll, Wallet } from '@coinposh/shared';

/** Why the server, or the network, turned a pull down. Each has its own line of copy. */
export type GachaRejection = 'noTickets' | 'unavailable' | 'busy' | 'offline' | 'error';

/**
 * Everything the gacha tells the rest of the game. Rolls, wallets and pity counters are the
 * server's answers; the client only says that it asked for a pull.
 */
export interface GachaEvents {
  'gacha:requested': { readonly count: number };
  /** The server rolled the capsule. `wallet` already has the Ticket taken off and the prize on. */
  'gacha:pulled': { readonly roll: Roll; readonly wallet: Wallet };
  /** Server pity counters after the roll, for the pity log. */
  'gacha:pity': { readonly pity: PityCounters };
  'gacha:rejected': { readonly reason: GachaRejection };
  /** The capsule popped open: the rarity is on screen. */
  'gacha:revealed': { readonly rarity: Rarity };
  /** The player collected; the HUD shows the wallet from `gacha:pulled`. */
  'gacha:collected': { readonly roll: Roll; readonly wallet: Wallet };
}
