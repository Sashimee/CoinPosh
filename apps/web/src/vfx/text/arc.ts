import { clamp01, easeInBack, easeOutBack, easeOutCubic, lerp, progress } from '../easing.ts';

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export interface PopFrame {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly opacity: number;
}

export interface PopPath {
  readonly from: ScreenPoint;
  readonly to: ScreenPoint;
  readonly control: ScreenPoint;
  readonly reducedMotion: boolean;
  readonly popIn: number;
  readonly hang: number;
  readonly flight: number;
  /** Seconds from spawn until the text lands in the HUD (or, reduced, finishes fading). */
  readonly duration: number;
}

export const POP_TIMING = {
  popIn: 0.26,
  hang: 0.18,
  minFlight: 0.4,
  maxFlight: 0.72,
  /** Pixels the text rises while it pops in, before the arc. */
  rise: 30,
  reduced: { fadeIn: 0.16, hold: 0.5, fadeOut: 0.24 },
} as const;

const popInScale = easeOutBack(2.2);
/** Pulls back slightly before it flies: anticipation without reading as a stumble. */
const flightEase = easeInBack(1.1);

export function createPopPath(from: ScreenPoint, to: ScreenPoint, reducedMotion: boolean): PopPath {
  for (const p of [from, to]) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      throw new RangeError(`numberPop needs finite screen points, got (${p.x}, ${p.y})`);
    }
  }
  if (reducedMotion) {
    const { fadeIn, hold, fadeOut } = POP_TIMING.reduced;
    return {
      from,
      to,
      control: from,
      reducedMotion,
      popIn: fadeIn,
      hang: hold,
      flight: fadeOut,
      duration: fadeIn + hold + fadeOut,
    };
  }
  const start = { x: from.x, y: from.y - POP_TIMING.rise };
  const dx = to.x - start.x;
  const dy = to.y - start.y;
  const distance = Math.hypot(dx, dy);
  const flight = lerp(POP_TIMING.minFlight, POP_TIMING.maxFlight, clamp01(distance / 900));
  const control = {
    x: start.x + dx * 0.3,
    y: Math.min(start.y, to.y) - (40 + distance * 0.22),
  };
  return {
    from,
    to,
    control,
    reducedMotion,
    popIn: POP_TIMING.popIn,
    hang: POP_TIMING.hang,
    flight,
    duration: POP_TIMING.popIn + POP_TIMING.hang + flight,
  };
}

export function popFrame(path: PopPath, t: number): PopFrame {
  if (path.reducedMotion) {
    const opacity =
      t < path.popIn
        ? progress(t, 0, path.popIn)
        : 1 - progress(t, path.popIn + path.hang, path.duration);
    return { x: path.from.x, y: path.from.y, scale: 1, opacity };
  }
  const startY = path.from.y - POP_TIMING.rise;
  if (t < path.popIn) {
    const k = t / path.popIn;
    return {
      x: path.from.x,
      y: lerp(path.from.y, startY, easeOutCubic(k)),
      scale: lerp(0.3, 1, popInScale(k)),
      opacity: progress(k, 0, 0.35),
    };
  }
  if (t < path.popIn + path.hang) {
    return { x: path.from.x, y: startY, scale: 1, opacity: 1 };
  }
  const k = progress(t, path.popIn + path.hang, path.duration);
  const e = flightEase(k);
  const u = 1 - e;
  const { control, to } = path;
  return {
    x: u * u * path.from.x + 2 * u * e * control.x + e * e * to.x,
    y: u * u * startY + 2 * u * e * control.y + e * e * to.y,
    scale: lerp(1, 0.5, easeOutCubic(k)),
    opacity: 1 - progress(k, 0.85, 1),
  };
}

/** Bigger wins read bigger: one step per order of magnitude, capped so a jackpot still fits. */
export function popFontSize(value: number): number {
  const magnitude = Math.log10(Math.max(1, Math.abs(value)));
  return Math.round(Math.min(64, 22 + magnitude * 6));
}
