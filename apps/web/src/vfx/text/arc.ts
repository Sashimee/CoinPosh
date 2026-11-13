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
  landScale: 0.42,
  /** Flight progress where the text starts dissolving into the HUD number. */
  fadeFrom: 0.72,
  reduced: { fadeIn: 0.16, hold: 0.5, fadeOut: 0.24 },
} as const;

const popInScale = easeOutBack(2.2);
/** Pulls back slightly before it flies: anticipation without reading as a stumble. */
const flightEase = easeInBack(0.7);

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
  // Rise first, then sweep into the target from below: arcing over the top would drag the
  // text across the plaque's label before it reaches the number.
  const control = {
    x: start.x + dx * 0.12,
    y: to.y - dy * 0.45,
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

/** The same path hanging `hang` seconds before it flies (or, reduced, before it fades). */
export function holdPath(path: PopPath, hang: number): PopPath {
  const held = Math.max(0, hang);
  return { ...path, hang: held, duration: path.popIn + held + path.flight };
}

/** The same timing and target, launched from `from`. */
export function movePath(path: PopPath, from: ScreenPoint): PopPath {
  return holdPath(createPopPath(from, path.to, path.reducedMotion), path.hang);
}

/** A frame the caller owns, so the per-frame update can reuse one instead of allocating. */
export interface MutablePopFrame {
  x: number;
  y: number;
  scale: number;
  opacity: number;
}

export function popFrame(path: PopPath, t: number, out?: MutablePopFrame): PopFrame {
  const f = out ?? { x: 0, y: 0, scale: 1, opacity: 0 };
  if (path.reducedMotion) {
    f.x = path.from.x;
    f.y = path.from.y;
    f.scale = 1;
    f.opacity =
      t < path.popIn
        ? progress(t, 0, path.popIn)
        : 1 - progress(t, path.popIn + path.hang, path.duration);
    return f;
  }
  const startY = path.from.y - POP_TIMING.rise;
  if (t < path.popIn) {
    const k = t / path.popIn;
    f.x = path.from.x;
    f.y = lerp(path.from.y, startY, easeOutCubic(k));
    f.scale = lerp(0.3, 1, popInScale(k));
    f.opacity = progress(k, 0, 0.35);
    return f;
  }
  if (t < path.popIn + path.hang) {
    f.x = path.from.x;
    f.y = startY;
    f.scale = 1;
    f.opacity = 1;
    return f;
  }
  const k = progress(t, path.popIn + path.hang, path.duration);
  const e = flightEase(k);
  const u = 1 - e;
  const { control, to } = path;
  f.x = u * u * path.from.x + 2 * u * e * control.x + e * e * to.x;
  f.y = u * u * startY + 2 * u * e * control.y + e * e * to.y;
  f.scale = lerp(1, POP_TIMING.landScale, easeOutCubic(k));
  f.opacity = 1 - progress(k, POP_TIMING.fadeFrom, 1);
  return f;
}

/** Bigger wins read bigger: one step per order of magnitude, capped so a jackpot still fits. */
export function popFontSize(value: number): number {
  const magnitude = Math.log10(Math.max(1, Math.abs(value)));
  return Math.round(Math.min(64, 22 + magnitude * 6));
}
