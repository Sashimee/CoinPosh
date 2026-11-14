import type { PityCounters, Rarity, Roll, ScratchCardId, Wallet } from '@coinposh/shared';

/** Why the server, or the network, turned a reveal down. Each has its own line of copy. */
export type ScratchRejection = 'gone' | 'unavailable' | 'offline' | 'error';

/**
 * Everything the scratch module tells the rest of the game. The grid, the roll, the wallet and
 * the pity counters are the server's answers; the client only names the card it wants revealed.
 */
export interface ScratchEvents {
  /** The owned cards changed. */
  'scratch:changed': { readonly count: number };
  'scratch:requested': { readonly cardId: ScratchCardId };
  /** The server rolled the card. `wallet` already includes the prize; the card is spent. */
  'scratch:revealed': {
    readonly cardId: ScratchCardId;
    readonly grid: readonly Rarity[];
    readonly roll: Roll;
    readonly wallet: Wallet;
  };
  /** Server pity counters after the roll, for the pity log. */
  'scratch:pity': { readonly cardId: ScratchCardId; readonly pity: PityCounters };
  'scratch:rejected': { readonly cardId: ScratchCardId; readonly reason: ScratchRejection };
  /** The three matching gems are on screen. */
  'scratch:matched': { readonly cardId: ScratchCardId; readonly rarity: Rarity };
  /** The player collected; the HUD shows the wallet from `scratch:revealed`. */
  'scratch:collected': {
    readonly cardId: ScratchCardId;
    readonly roll: Roll;
    readonly wallet: Wallet;
  };
}
