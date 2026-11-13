import type { PityCounters, Rarity, Roll, SafeId, SafeOpenMethod, Wallet } from '@coinposh/shared';

/** Why the server, or the network, turned an open down. Each has its own line of copy. */
export type SafeRejection = 'notReady' | 'noKeys' | 'gone' | 'unavailable' | 'offline' | 'error';

/**
 * Everything the safes module tells the rest of the game. Rolls, wallets, pity counters and
 * unlock times are the server's answers; the client only says what it asked for.
 */
export interface SafeEvents {
  /** The owned safes changed: `ready` of them can be opened on their timer right now. */
  'safes:changed': { readonly count: number; readonly ready: number };
  /** A safe's timer ran out on the server clock: it opens without Keys now. */
  'safe:ready': { readonly safeId: SafeId };
  'safe:requested': { readonly safeId: SafeId; readonly method: SafeOpenMethod };
  /** The server rolled the contents. `wallet` already includes them and any Keys spent. */
  'safe:opened': {
    readonly safeId: SafeId;
    readonly method: SafeOpenMethod;
    readonly roll: Roll;
    readonly wallet: Wallet;
  };
  /** Server pity counters after the roll, for the pity log. */
  'safe:pity': { readonly safeId: SafeId; readonly pity: PityCounters };
  'safe:rejected': {
    readonly safeId: SafeId;
    readonly method: SafeOpenMethod;
    readonly reason: SafeRejection;
  };
  /** The door is open: the rarity is on screen. */
  'safe:revealed': { readonly safeId: SafeId; readonly rarity: Rarity };
  /** The player collected; the HUD shows the wallet from `safe:opened`. */
  'safe:collected': { readonly safeId: SafeId; readonly roll: Roll; readonly wallet: Wallet };
}
