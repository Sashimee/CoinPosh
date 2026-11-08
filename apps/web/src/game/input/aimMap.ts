/**
 * Screen x to aim and back. The drop rail spans the middle `span` of the surface, so the thumb
 * reaches either end of the rail without touching the screen edge, where system gestures live.
 */
export interface AimMap {
  toAim(px: number, width: number): number;
  toPx(aim: number, width: number): number;
}

export const DEFAULT_AIM_SPAN = 0.8;

export function linearAimMap(span: number = DEFAULT_AIM_SPAN): AimMap {
  if (!(span > 0 && span <= 1))
    throw new RangeError(`linearAimMap: span must be in (0, 1], got ${span}`);
  return {
    toAim(px, width) {
      if (!(width > 0)) return 0;
      const centred = ((px / width) * 2 - 1) / span;
      return Math.min(1, Math.max(-1, centred));
    },
    toPx(aim, width) {
      return ((Math.min(1, Math.max(-1, aim)) * span + 1) / 2) * width;
    },
  };
}
