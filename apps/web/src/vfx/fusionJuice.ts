import { COIN_TIERS, type CoinTier } from '@coinposh/shared';

/**
 * `full`: the set piece (hit-stop, double ring, corona, bloom surge, camera kick), kept for
 * milestones and the rarest results.
 * `mid`: a routine gold or platinum result: a brighter flash in the tier's metal, a small
 * double ring and a double crown of sparks; no hit-stop or camera.
 * `compact`: a flash a few coins wide over the new coin, for routine copper and silver and
 * for anything that lands while the bigger treatments are resting.
 */
export type FusionTreatment = 'full' | 'mid' | 'compact';

/** Why a fusion got its treatment; `milestone` covers first of session and first of a tier. */
export type FusionReason = 'milestone' | 'rare' | 'routine' | 'resting';

export interface FusionJuice {
  readonly treatment: FusionTreatment;
  readonly hitStop: boolean;
  readonly reason: FusionReason;
}

/** Routine results from this tier up get the mid treatment. */
export const FUSION_MID_FROM: CoinTier = 'gold';
/** Routine results from this tier up are rare enough for the full set piece. */
export const FUSION_FULL_FROM: CoinTier = 'diamond';
/** A rare result plays in full only this long after the previous full one (founder #182). */
export const FUSION_FULL_GAP_MS = 20_000;
/** Even a milestone waits this long after a full set piece, so two never stack. */
export const FUSION_FULL_SPACING_MS = 3000;
/** However the fusions fall, no window this long holds more than `FUSION_FULL_PER_WINDOW`. */
export const FUSION_FULL_WINDOW_MS = 30_000;
export const FUSION_FULL_PER_WINDOW = 2;
/** Mid treatments closer together than this go compact, so a fusion chain does not strobe. */
export const FUSION_MID_GAP_MS = 900;

const MID_FROM_RANK = COIN_TIERS.indexOf(FUSION_MID_FROM);
const FULL_FROM_RANK = COIN_TIERS.indexOf(FUSION_FULL_FROM);

/**
 * Picks each fusion's treatment, one per `Vfx`, which lives for the session.
 *
 * The full set piece is earned: the first fusion of the session, the first time each tier is
 * reached, and diamond and up. Rare results are capped to one per `FUSION_FULL_GAP_MS`;
 * milestones skip that cap but not the spacing or the per-window limit, and one that is
 * held back stays owed, so the next fusion of that tier plays it in full. Routine gold and
 * platinum play mid; copper and silver, and whatever lands inside a rest, play compact.
 */
export class FusionDirector {
  private readonly celebrated = new Set<CoinTier>();
  private readonly fullAt: number[] = [];
  private lastMidMs = Number.NEGATIVE_INFINITY;
  private lastMs = Number.NEGATIVE_INFINITY;

  select(tier: CoinTier, nowMs: number): FusionJuice {
    const rank = COIN_TIERS.indexOf(tier);
    if (rank < 0) throw new RangeError(`Unknown coin tier "${tier}"`);
    if (!Number.isFinite(nowMs)) throw new RangeError(`fusion clock must be finite, got ${nowMs}`);
    if (nowMs < this.lastMs) {
      throw new RangeError(`fusion clock went backwards: ${nowMs} ms after ${this.lastMs} ms`);
    }
    this.lastMs = nowMs;

    const milestone = !this.celebrated.has(tier);
    const rare = rank >= FULL_FROM_RANK;
    if ((milestone || rare) && this.fullAllowed(nowMs, milestone)) {
      this.celebrated.add(tier);
      this.fullAt.push(nowMs);
      return { treatment: 'full', hitStop: true, reason: milestone ? 'milestone' : 'rare' };
    }
    if (rank >= MID_FROM_RANK && nowMs - this.lastMidMs >= FUSION_MID_GAP_MS) {
      this.lastMidMs = nowMs;
      return { treatment: 'mid', hitStop: false, reason: 'routine' };
    }
    const reason = rank >= MID_FROM_RANK || milestone ? 'resting' : 'routine';
    return { treatment: 'compact', hitStop: false, reason };
  }

  private fullAllowed(nowMs: number, milestone: boolean): boolean {
    while (this.fullAt.length > 0 && nowMs - (this.fullAt[0] ?? 0) >= FUSION_FULL_WINDOW_MS) {
      this.fullAt.shift();
    }
    if (this.fullAt.length >= FUSION_FULL_PER_WINDOW) return false;
    const since = nowMs - (this.fullAt.at(-1) ?? Number.NEGATIVE_INFINITY);
    return since >= (milestone ? FUSION_FULL_SPACING_MS : FUSION_FULL_GAP_MS);
  }
}
