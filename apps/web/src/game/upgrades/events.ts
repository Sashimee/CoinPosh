import type { Wallet } from '@coinposh/shared';

/** Why the server (or the net layer) turned a purchase down, as the player should hear it. */
export type UpgradeRejection = 'unaffordable' | 'stale' | 'unavailable' | 'offline' | 'error';

/**
 * Typed game events for purchases. VFX, audio and UI subscribe to these instead of the
 * controller, so a confirmed level can trigger particles or a chime without coupling.
 */
export interface UpgradeEvents {
  'upgrade:requested': { readonly lineId: string; readonly level: number };
  /** The server confirmed the purchase; `wallet` is its balance after paying. */
  'upgrade:purchased': {
    readonly lineId: string;
    readonly level: number;
    readonly wallet: Wallet;
  };
  'upgrade:rejected': {
    readonly lineId: string;
    readonly level: number;
    readonly reason: UpgradeRejection;
  };
}
