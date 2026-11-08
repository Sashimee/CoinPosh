import type {
  ClaimRejection,
  CrateId,
  CrateKind,
  PityCounters,
  Rarity,
  Roll,
  Wallet,
} from '@coinposh/shared';
import type { TablePoint } from '../systems/events.ts';

export type CrateStingerCue =
  'arrive' | 'teeter' | 'fall' | 'land' | 'shudder' | 'rays' | 'burst' | 'collect';

/**
 * Everything the crates module tells the rest of the game. Rolls, wallets and pity counters
 * are the server's answers; positions are what this client drew.
 */
export interface CrateEvents {
  /** The server put a crate on the table with this drop. */
  'crate:spawned': {
    readonly crateId: CrateId;
    readonly kind: CrateKind;
    readonly position: TablePoint;
  };
  /** The crate reached the lip and hangs over it: the anticipation beat. */
  'crate:teeter': { readonly crateId: CrateId; readonly position: TablePoint };
  /** It went over; the claim is on its way to the server. */
  'crate:fell': { readonly crateId: CrateId; readonly tick: number; readonly position: TablePoint };
  'crate:claimed': { readonly crateId: CrateId };
  'crate:rejected': { readonly crateId: CrateId; readonly reason: ClaimRejection };
  /** The claim or the open failed outright (offline for good, a contract error). */
  'crate:failed': { readonly crateId: CrateId; readonly error: unknown };
  /** The server rolled the contents. `wallet` already includes them. */
  'crate:opened': {
    readonly crateId: CrateId;
    readonly roll: Roll;
    readonly wallet: Wallet;
  };
  /** The cinematic burst: the rarity is now on screen. */
  'crate:revealed': { readonly crateId: CrateId; readonly rarity: Rarity };
  /** The player collected; the HUD shows the wallet from `crate:opened`. */
  'crate:collected': { readonly crateId: CrateId; readonly roll: Roll; readonly wallet: Wallet };
  /** Server pity counters after the latest roll. */
  'crate:pity': { readonly pity: PityCounters };
  /**
   * An audio cue. `step` rises 1..3 through the shudders; `duckSeconds` asks the music to
   * step back for that long under a reveal.
   */
  'crate:stinger': {
    readonly cue: CrateStingerCue;
    readonly rarity: Rarity | null;
    readonly step: number;
    readonly duckSeconds: number;
  };
}
