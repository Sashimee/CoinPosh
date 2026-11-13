import type { VenueId, Wallet } from '@coinposh/shared';

/** Why the server (or the net layer) turned an ascension or a Family Office purchase down. */
export type AscensionRejection =
  'notReady' | 'stale' | 'locked' | 'unaffordable' | 'offline' | 'error';

/**
 * Typed game events for the prestige loop. VFX, audio and UI subscribe to these instead of the
 * controller, so the cinematic, the HUD and the venue swap react without coupling.
 */
export interface AscensionEvents {
  'ascension:opened': { readonly venueId: VenueId };
  'ascension:requested': { readonly venueId: VenueId };
  /** The server reset the venue and credited `goldBarsGranted`; `wallet` is its balance after. */
  'ascension:confirmed': {
    readonly venueId: VenueId;
    readonly goldBarsGranted: number;
    readonly unlockedVenueId: VenueId | null;
    readonly wallet: Wallet;
  };
  'ascension:rejected': { readonly venueId: VenueId; readonly reason: AscensionRejection };
  /** The cinematic handed back; the game now plays `venueId`. */
  'ascension:completed': { readonly venueId: VenueId };
  'familyOffice:requested': { readonly lineId: string; readonly level: number };
  'familyOffice:purchased': {
    readonly lineId: string;
    readonly level: number;
    readonly wallet: Wallet;
  };
  'familyOffice:rejected': {
    readonly lineId: string;
    readonly level: number;
    readonly reason: AscensionRejection;
  };
}
