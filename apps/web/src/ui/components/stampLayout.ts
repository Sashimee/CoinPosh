import type { Box, Insets, RailPlan } from './railLayout.ts';

export interface StampLayout {
  readonly viewport: { readonly width: number; readonly height: number };
  readonly safe: Insets;
  /** The whole coin floor, pusher deck included. */
  readonly floor: Box;
  /** The front half of the floor down to the lip, which the announcement must never cover. */
  readonly frontHalf: Box;
  /** Bottom edge of the HUD above the table: banner, Vault plaque and its notices. */
  readonly ceiling: number;
  readonly rails: RailPlan;
}

export interface StampPlanInput extends StampLayout {
  /** The ribbon's natural size, before any fit scale or landing spring. */
  readonly card: { readonly width: number; readonly height: number };
}

export interface StampPlacement {
  /** Where the ribbon rests once landed, fit scale applied. */
  readonly box: Box;
  /** Fit scale for the whole ribbon, 1 when it has room at full size. */
  readonly scale: number;
}

/** Below this the rank name stops reading as a headline, so the ribbon rides up into the HUD. */
export const STAMP_MIN_SCALE = 0.6;
/** Clearance kept above the front half, wide enough for the landing tilt's dipping corner. */
export const STAMP_FIELD_GAP = 12;
const CHROME_GAP = 8;
/** On a tall screen the ribbon stays near the Vault instead of floating mid-sky. */
const MAX_DRIFT = 40;

function railObstacles(rails: RailPlan): Box[] {
  return [rails.left, rails.right].flatMap((slot) => (slot ? [slot.card ?? slot.rail] : []));
}

/**
 * Rests the Cascade rank ribbon between the HUD above the table and the front half of the coin
 * floor, clear of the open meter cards: the payoff it celebrates (coins tumbling over the lip and
 * their pops) stays in view. When that band is too short even at the smallest legible size, the
 * ribbon keeps clear of the field and overlaps the HUD instead.
 */
export function planRankStamp(input: StampPlanInput): StampPlacement {
  const { viewport, safe, floor, frontHalf, card } = input;
  const innerLeft = safe.left + CHROME_GAP;
  const innerRight = viewport.width - safe.right - CHROME_GAP;
  const widthScale = Math.min(1, (innerRight - innerLeft) / Math.max(card.width, 1));
  const fullWidth = card.width * widthScale;
  const centreX = Math.min(
    Math.max(floor.left + floor.width / 2, innerLeft + fullWidth / 2),
    innerRight - fullWidth / 2,
  );
  const spanLeft = centreX - fullWidth / 2 - CHROME_GAP;
  const spanRight = centreX + fullWidth / 2 + CHROME_GAP;

  const bottom = frontHalf.top - STAMP_FIELD_GAP;
  let top = Math.max(input.ceiling, safe.top) + CHROME_GAP;
  for (const obstacle of railObstacles(input.rails)) {
    const sharesColumn = obstacle.left < spanRight && spanLeft < obstacle.left + obstacle.width;
    if (sharesColumn && obstacle.top < bottom) {
      top = Math.max(top, obstacle.top + obstacle.height + CHROME_GAP);
    }
  }

  const room = bottom - top;
  const fitScale = Math.min(widthScale, room / Math.max(card.height, 1));
  const roomy = fitScale >= STAMP_MIN_SCALE;
  const scale = roomy ? fitScale : Math.min(widthScale, STAMP_MIN_SCALE);
  const width = card.width * scale;
  const height = card.height * scale;
  const restTop = roomy
    ? Math.min(top + (room - height) / 2, top + MAX_DRIFT)
    : Math.max(safe.top, bottom - height);
  return { box: { left: centreX - width / 2, top: restTop, width, height }, scale };
}
