import { COIN_TIERS, type CoinTier } from '@coinposh/shared';

/**
 * `full`: the set piece (hit-stop, table-wide ring, corona, bloom surge). `compact`: a
 * flash a few coins wide over the new coin, for the copper and silver fusions a busy
 * table makes every couple of seconds.
 */
export type FusionTreatment = 'full' | 'compact';

export interface FusionJuice {
  readonly treatment: FusionTreatment;
  readonly hitStop: boolean;
  /** FOV tighten on the implosion and the shake + FOV kick on impact. */
  readonly cameraKick: boolean;
}

/** Results from this tier up always get the full treatment. */
export const FUSION_FULL_FROM: CoinTier = 'gold';
/** However many full fusions land, the camera kicks for at most one per this window. */
export const FUSION_KICK_GAP_MS = 3000;

const FULL_FROM_RANK = COIN_TIERS.indexOf(FUSION_FULL_FROM);

/**
 * Picks each fusion's treatment: the first of the session and every gold-or-better result
 * are full, the rest compact, and camera kicks are rate-limited across all of them so a
 * run of gold fusions does not turn into a seasick camera. One per `Vfx`, which lives for
 * the session.
 */
export class FusionDirector {
  private fused = false;
  private lastKickMs = Number.NEGATIVE_INFINITY;

  select(tier: CoinTier, nowMs: number): FusionJuice {
    const rank = COIN_TIERS.indexOf(tier);
    if (rank < 0) throw new RangeError(`Unknown coin tier "${tier}"`);
    if (!Number.isFinite(nowMs)) throw new RangeError(`fusion clock must be finite, got ${nowMs}`);
    const full = !this.fused || rank >= FULL_FROM_RANK;
    this.fused = true;
    if (!full) return { treatment: 'compact', hitStop: false, cameraKick: false };
    const cameraKick = nowMs - this.lastKickMs >= FUSION_KICK_GAP_MS;
    if (cameraKick) this.lastKickMs = nowMs;
    return { treatment: 'full', hitStop: true, cameraKick };
  }
}
