import {
  ascension,
  ascensionGoldBars,
  upgradeCost,
  upgradeLines,
  upgradeStat,
  venues,
  type UpgradeLineDef,
  type VenueDef,
} from '@coinposh/economy';
import { VenueIdSchema, type VenueId, type VenueState } from '@coinposh/shared';

export interface AscensionProgress {
  readonly venueId: VenueId;
  readonly nextVenueId: VenueId | null;
  readonly threshold: number;
  /** Lifetime Bullion as last reported by the server; null when the client has no figure. */
  readonly bullion: number | null;
  /** 0..1 toward the threshold; 0 when the Bullion is unknown. */
  readonly fraction: number;
  /** null when unknown: the server checks eligibility either way. */
  readonly ready: boolean | null;
  /**
   * Provisional Gold Bars from the same economy formula the server uses; the screen labels it
   * as an estimate and only the server's response is ever credited.
   */
  readonly estimatedGoldBars: number | null;
}

const ORDERED_VENUES: readonly VenueDef[] = [...venues].sort((a, b) => a.order - b.order);

export function venueDef(venueId: VenueId): VenueDef {
  const venue = ORDERED_VENUES.find((candidate) => candidate.id === venueId);
  if (venue === undefined) throw new RangeError(`Economy config has no venue "${venueId}"`);
  return venue;
}

export function nextVenueId(venueId: VenueId): VenueId | null {
  const venue = venueDef(venueId);
  const next = ORDERED_VENUES.find((candidate) => candidate.order === venue.order + 1);
  return next === undefined ? null : VenueIdSchema.parse(next.id);
}

export function ascensionProgress(venueId: VenueId, bullion: number | null): AscensionProgress {
  const venue = venueDef(venueId);
  const known = bullion !== null && Number.isFinite(bullion) && bullion >= 0 ? bullion : null;
  return {
    venueId,
    nextVenueId: nextVenueId(venueId),
    threshold: venue.bullionThreshold,
    bullion: known,
    fraction: known === null ? 0 : Math.min(1, known / venue.bullionThreshold),
    ready: known === null ? null : known >= venue.bullionThreshold,
    estimatedGoldBars:
      known === null ? null : ascensionGoldBars(known, venue.bullionThreshold, ascension),
  };
}

/** The server's Bullion since the last ascension; null (the unknown path) while it reports none. */
export function lifetimeBullionOf(venue: Pick<VenueState, 'lifetimeBullion'>): number | null {
  return venue.lifetimeBullion ?? null;
}

/** Only an explicit "not yet" from the numbers blocks the hold; an unknown lets the server decide. */
export function canRequestAscension(progress: AscensionProgress): boolean {
  return progress.ready !== false;
}

export const FAMILY_OFFICE_LINES: readonly UpgradeLineDef[] = upgradeLines.filter(
  (line) => line.scope === 'global',
);

export interface FamilyOfficeRow {
  readonly lineId: string;
  readonly level: number;
  readonly maxLevel: number;
  readonly maxed: boolean;
  /** Gold Bars for the next level; null once maxed. */
  readonly cost: number | null;
  readonly affordable: boolean;
  readonly effect: number;
  readonly nextEffect: number | null;
}

export function familyOfficeRows(
  levels: Readonly<Record<string, number>>,
  goldBars: number,
): readonly FamilyOfficeRow[] {
  return FAMILY_OFFICE_LINES.map((line) => {
    const level = levels[line.id] ?? 0;
    const maxed = level >= line.maxLevel;
    const cost = maxed ? null : upgradeCost(line, level);
    return {
      lineId: line.id,
      level,
      maxLevel: line.maxLevel,
      maxed,
      cost,
      affordable: cost !== null && goldBars >= cost,
      effect: upgradeStat(line, level),
      nextEffect: maxed ? null : upgradeStat(line, level + 1),
    };
  });
}

/** Long enough that ascending is never an accident, short enough to feel like a flourish. */
export const HOLD_TO_ASCEND_MS = 900;

/** How many haptic ticks the hold ring plays on its way round. */
export const HOLD_TICKS = 6;

export function holdFraction(heldMs: number): number {
  if (!(heldMs > 0)) return 0;
  return Math.min(1, heldMs / HOLD_TO_ASCEND_MS);
}

/** Index of the last tick passed at `fraction`, 0 before the first. */
export function holdTick(fraction: number): number {
  return Math.min(HOLD_TICKS, Math.floor(Math.max(0, fraction) * HOLD_TICKS));
}
