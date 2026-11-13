import { COIN_TIERS, type CoinTier } from '@coinposh/shared';

/**
 * `full`: the set piece (hit-stop, table-wide ring, corona, bloom surge, camera kick).
 * `compact`: a flash a few coins wide over the new coin, for every copper and silver
 * fusion and for gold-or-better ones that land while the set piece is resting.
 */
export type FusionTreatment = 'full' | 'compact';

export interface FusionJuice {
  readonly treatment: FusionTreatment;
  readonly hitStop: boolean;
  /** FOV tighten on the implosion and the shake + FOV kick on impact. */
  readonly cameraKick: boolean;
}

/** Only results from this tier up can get the full treatment. */
export const FUSION_FULL_FROM: CoinTier = 'gold';
/** However many gold-or-better fusions land, at most one per this window plays in full. */
export const FUSION_KICK_GAP_MS = 3000;

const FULL_FROM_RANK = COIN_TIERS.indexOf(FUSION_FULL_FROM);
const COMPACT: FusionJuice = { treatment: 'compact', hitStop: false, cameraKick: false };
const FULL: FusionJuice = { treatment: 'full', hitStop: true, cameraKick: true };

/**
 * Picks each fusion's treatment. Copper and silver results, the bulk of a busy table, are
 * always compact, so frequent fusions read crisp instead of overwhelming. A gold-or-better
 * result plays the full set piece, but at most once per `FUSION_KICK_GAP_MS`: a run of gold
 * fusions gets one hit-stop and camera kick, then compact flashes until the window
 * reopens. One per `Vfx`, which lives for the session.
 */
export class FusionDirector {
  private lastFullMs = Number.NEGATIVE_INFINITY;

  select(tier: CoinTier, nowMs: number): FusionJuice {
    const rank = COIN_TIERS.indexOf(tier);
    if (rank < 0) throw new RangeError(`Unknown coin tier "${tier}"`);
    if (!Number.isFinite(nowMs)) throw new RangeError(`fusion clock must be finite, got ${nowMs}`);
    if (rank < FULL_FROM_RANK || nowMs - this.lastFullMs < FUSION_KICK_GAP_MS) return COMPACT;
    this.lastFullMs = nowMs;
    return FULL;
  }
}
