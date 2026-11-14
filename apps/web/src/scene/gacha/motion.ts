/**
 * The machine's cosmetic motion, kept free of three.js so it can be tested on its own: the
 * crank's detented resistance and the timings of the dispense and pop sequences.
 */

/** Clicks per full turn of the crank. */
export const CRANK_DETENTS = 8;

/**
 * Share of each click the pawl holds the crank back for: the handle lags the hand through this
 * much of the click, then the spring behind the pawl lets go and it snaps onto the next tooth.
 */
export const DETENT_HOLD = 0.72;
/** How far the crank creeps while the pawl holds, as a share of a click. */
export const DETENT_CREEP = 0.22;

/**
 * The crank angle, in turns, the handle is pulled towards for a crank `progress` (0 to 1 is one
 * turn): it creeps through the first DETENT_HOLD of each click against the pawl and catches up
 * through the rest, so the handle feels heavy and clicks onto each tooth.
 */
export function detentTurns(progress: number): number {
  const clicks = Math.max(0, progress) * CRANK_DETENTS;
  const tooth = Math.floor(clicks);
  const f = clicks - tooth;
  const held =
    f < DETENT_HOLD
      ? (f / DETENT_HOLD) * DETENT_CREEP
      : DETENT_CREEP + ((f - DETENT_HOLD) / (1 - DETENT_HOLD)) ** 2 * (1 - DETENT_CREEP);
  return (tooth + held) / CRANK_DETENTS;
}

/** The click a crank `progress` has reached: 0 before the first tooth, CRANK_DETENTS at a full turn. */
export function detentIndex(progress: number): number {
  return Math.floor(Math.max(0, progress) * CRANK_DETENTS + 1e-9);
}

export interface DispenseTiming {
  /** The capsule leaves the globe and drops into the port. */
  readonly drop: number;
  /** End of the roll down the chute, from the end of `drop`. */
  readonly roll: number;
  /** End of the bounce into the tray. */
  readonly bounce: number;
  /** End of the rock as it settles on the velvet; `dispense` resolves here. */
  readonly settle: number;
}

/** Cumulative seconds of each dispense stage. */
export const DISPENSE: DispenseTiming = { drop: 0.16, roll: 1.06, bounce: 1.46, settle: 1.62 };
/** Reduced motion: the capsule fades in on the velvet, no roll and no spin. */
export const DISPENSE_REDUCED = { fade: 0.45 } as const;

export interface PopTiming {
  /** The capsule lifts from the tray to the opening point and turns its seam level. */
  readonly lift: number;
  /** First quarter-twist of the top shell, with a shudder. */
  readonly twist1: number;
  readonly twist2Start: number;
  /** Second twist: light leaks from the seam. */
  readonly twist2: number;
  /** The top shell springs off and the glow bursts. */
  readonly burst: number;
  /** The glow and the shells settle; `pop` resolves here. */
  readonly settle: number;
}

export const POP: PopTiming = {
  lift: 0.3,
  twist1: 0.46,
  twist2Start: 0.54,
  twist2: 0.72,
  burst: 0.9,
  settle: 1.3,
};
/** Reduced motion: the closed capsule fades out and the opened one fades in with the glow. */
export const POP_REDUCED = { out: 0.2, in: 0.55 } as const;

/** Seconds into the roll (share of the chute) where the capsule knocks the tube wall at a bend. */
export const CHUTE_KNOCKS = [0.3, 0.62] as const;

/**
 * Share of the chute covered `t` seconds into a roll of `duration`: it leaves the port slowly and
 * gathers speed under gravity, as a ball does down a slope.
 */
export function rollShare(t: number, duration: number): number {
  const u = Math.min(Math.max(t / duration, 0), 1);
  return 0.3 * u + 0.7 * u * u;
}

/**
 * Height over the rest point of a capsule `t` seconds after it drops out of the chute mouth: a
 * fall onto the velvet, then two hops each a third of the last.
 */
export function bounceHeight(t: number, duration: number, drop: number): number {
  const u = Math.min(Math.max(t / duration, 0), 1);
  const fall = 0.28;
  if (u < fall) return drop * (1 - (u / fall) ** 2);
  const hops = [
    { from: fall, to: 0.66, height: drop * 0.32 },
    { from: 0.66, to: 0.92, height: drop * 0.1 },
  ];
  for (const hop of hops) {
    if (u < hop.to) {
      const k = (u - hop.from) / (hop.to - hop.from);
      return hop.height * 4 * k * (1 - k);
    }
  }
  return 0;
}

/** Seconds into the bounce at which the capsule meets the velvet. */
export function bounceContacts(duration: number): number[] {
  return [0.28, 0.66, 0.92].map((u) => u * duration);
}

/** Glow size and strength per rarity: a common glints, a legendary floods the frame with light. */
export const RARITY_GLOW = {
  common: { size: 0.085, intensity: 1.1, rays: 0.25 },
  fine: { size: 0.1, intensity: 1.35, rays: 0.4 },
  rare: { size: 0.118, intensity: 1.6, rays: 0.55 },
  exquisite: { size: 0.135, intensity: 1.9, rays: 0.7 },
  legendary: { size: 0.16, intensity: 2.3, rays: 0.9 },
  heirloom: { size: 0.18, intensity: 2.6, rays: 1 },
} as const;

/** Glow strength over the pop, as a multiple of the rarity's, for seconds `t` into the pop. */
export function popGlow(t: number): number {
  if (t < POP.twist1) return 0;
  if (t < POP.twist2) return 0.12 * ((t - POP.twist1) / (POP.twist2 - POP.twist1));
  const since = t - POP.twist2;
  const flash = since < 0.06 ? 0.12 + (since / 0.06) * 2.9 : 3.02 * Math.exp(-(since - 0.06) * 5);
  return Math.max(flash, 0.62);
}
