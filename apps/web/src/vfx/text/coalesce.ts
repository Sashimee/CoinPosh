import type { ScreenPoint } from './arc.ts';

/**
 * When number pops fold into one tally instead of printing side by side. A credit joins
 * an open pop heading to the same HUD target if it lands within `windowS` of that pop's
 * last credit and its text box would sit within `gapPx` of the pop's box, so a cascade
 * tipping coins over the lip reads as one "+27" counting up rather than "+6+6+5+5+5".
 */
export const COALESCE = {
  windowS: 0.25,
  gapPx: 40,
  /** No credit joins a pop older than this, so an endless cascade still pays out in beats. */
  maxOpenS: 1.1,
  /** A pop that just took a credit hangs at least this long so the new total reads. */
  readS: 0.34,
  /** Flights into one target leave at least this far apart, so arcs never stack. */
  flightGapS: 0.14,
  /**
   * Longest a pop waits at its hang for the lane above it to clear (or for the stagger)
   * before it flies anyway, so nothing can stall a credit. It outlasts the longest a pop
   * in the way can stay open (maxOpenS + readS), so the lane always clears first.
   */
  maxWaitS: 1.7,
  countS: 0.24,
  driftS: 0.09,
  punchS: 0.26,
  punchScale: 0.2,
  /** Clearance kept between pops that did not merge. */
  clearPx: 4,
  /** Two targets this close are the same HUD element. */
  sameTargetPx: 2,
} as const;

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Playfair Display bold, tabular lining digits: about 0.6 em per glyph, 1.15 em line. */
const GLYPH_EM = 0.62;
const LINE_EM = 1.15;

export function emptyBox(): Box {
  return { left: 0, top: 0, right: 0, bottom: 0 };
}

/**
 * The on-screen box of a pop's text centred on (`x`, `y`), estimated from its glyph count
 * and font size so placement never forces a layout read. Writes into `out` when given.
 */
export function popBox(
  glyphs: number,
  fontSize: number,
  x: number,
  y: number,
  scale: number,
  out: Box = emptyBox(),
): Box {
  const halfW = (Math.max(1, glyphs) * GLYPH_EM * fontSize * scale) / 2;
  const halfH = (LINE_EM * fontSize * scale) / 2;
  out.left = x - halfW;
  out.right = x + halfW;
  out.top = y - halfH;
  out.bottom = y + halfH;
  return out;
}

/** Distance between two boxes along the axis that separates them; negative when they overlap. */
export function boxGap(a: Box, b: Box): number {
  const gapX = Math.max(a.left - b.right, b.left - a.right);
  const gapY = Math.max(a.top - b.bottom, b.top - a.bottom);
  return Math.max(gapX, gapY);
}

export function boxesOverlap(a: Box, b: Box): boolean {
  return boxGap(a, b) < 0;
}

export interface OpenPop {
  /** Seconds since the pop spawned. */
  readonly age: number;
  /** Age at which it last took a credit (0 for its own). */
  readonly lastCreditAge: number;
  /** Age at which it leaves for the HUD (or, reduced, starts fading out). */
  readonly departsAt: number;
  readonly to: ScreenPoint;
}

/** Whether a credit for `to` landing `gap` px from `pop`'s box folds into it. */
export function canCoalesce(pop: OpenPop, to: ScreenPoint, gap: number): boolean {
  if (pop.age >= pop.departsAt || pop.age > COALESCE.maxOpenS) return false;
  if (pop.age - pop.lastCreditAge > COALESCE.windowS) return false;
  if (Math.hypot(pop.to.x - to.x, pop.to.y - to.y) > COALESCE.sameTargetPx) return false;
  return gap <= COALESCE.gapPx;
}

/**
 * Offsets tried, in units of the pop's own width and height, when its spot is taken:
 * beside first (pops on the lip read left to right), then below. Below beats above
 * because the older pop leaves first and rises away, so the newer one's flight follows
 * it up the same lane instead of crossing it.
 */
const NUDGES: readonly (readonly [number, number])[] = [
  [0, 0],
  [-1, 0],
  [1, 0],
  [0, 1],
  [-1, 1],
  [1, 1],
  [-2, 0],
  [2, 0],
  [0, 2],
  [-2, 1],
  [2, 1],
  [0, -1],
];

/**
 * Where to centre a `width` x `height` box wanted at `at` so it overlaps none of
 * `taken` and stays inside `bounds`; the least crowded nudge when every one is taken.
 */
export function placeClear(
  at: ScreenPoint,
  width: number,
  height: number,
  taken: readonly Box[],
  bounds: { readonly width: number; readonly height: number },
): ScreenPoint {
  const stepX = width + COALESCE.clearPx;
  // The extra row clearance covers the small dip a pop makes as it winds up to fly.
  const stepY = height + COALESCE.clearPx * 4;
  const probe = emptyBox();
  let best = at;
  let bestCrowd = Number.POSITIVE_INFINITY;
  for (const [nx, ny] of NUDGES) {
    const x = clampAxis(at.x + nx * stepX, width, bounds.width);
    const y = clampAxis(at.y + ny * stepY, height, bounds.height);
    probe.left = x - width / 2 - COALESCE.clearPx / 2;
    probe.right = x + width / 2 + COALESCE.clearPx / 2;
    probe.top = y - height / 2 - COALESCE.clearPx / 2;
    probe.bottom = y + height / 2 + COALESCE.clearPx / 2;
    let crowd = 0;
    for (const box of taken) crowd += overlapArea(probe, box);
    if (crowd === 0) return { x, y };
    if (crowd < bestCrowd) {
      bestCrowd = crowd;
      best = { x, y };
    }
  }
  return best;
}

function clampAxis(value: number, size: number, extent: number): number {
  if (!(extent > size)) return value;
  return Math.min(extent - size / 2, Math.max(size / 2, value));
}

function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}
