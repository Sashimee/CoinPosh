import { CASCADE_TIERS, type BossKind, type BossStatus, type CascadeTier } from '@coinposh/shared';

/**
 * How the figure behind the back wall feels about the table, kept free of three.js so it can be
 * tested on its own: a reducer over the cascade and boss events, and the pose each mood takes
 * at a given time.
 *
 * - `idle`: peeks over the wall, breathing, glancing about; the Inspector writes in his ledger
 *   now and then, the tycoon checks his watch.
 * - `watch`: a cascade has reached WATCH_RANK, so the figure rises and leans in over the wall.
 * - `shock`: a big cascade (SHOCK_RANK and up) throws the figure back: it jumps, the hat pops,
 *   the lenses flash. Each higher tier in the same chain shocks it again, harder.
 * - `flinch`: a banked hit on the boss, a short wince.
 * - `defeated` / `escaped`: the week is over; the figure sinks behind the wall and stays there.
 */
export type BossMood = 'idle' | 'watch' | 'shock' | 'flinch' | 'defeated' | 'escaped';

export interface BossReaction {
  readonly mood: BossMood;
  /** Seconds on the presence clock when `mood` began. */
  readonly since: number;
  /** 0 to 1: how hard the current shock or flinch landed. */
  readonly strength: number;
  /** A cascade is running. */
  readonly chain: boolean;
  /** Highest cascade rank this chain has reached, 0 before the first tier. */
  readonly rank: number;
  /** Highest rank this chain has already shocked the figure at. */
  readonly shockedRank: number;
  /** When the last chain ended, for the watch to linger after it; null while one runs. */
  readonly endedAt: number | null;
}

export type BossInput =
  | { readonly kind: 'cascadeStep'; readonly count: number; readonly rank: number }
  | { readonly kind: 'cascadeTier'; readonly rank: number }
  | { readonly kind: 'cascadeEnd' }
  /** `share` is the hit's damage over the boss's max health. */
  | { readonly kind: 'hit'; readonly share: number }
  | { readonly kind: 'status'; readonly status: BossStatus };

/** The rank the game bus gives a cascade tier: its 1-based place on the ladder, 0 for none. */
export function cascadeRank(tier: CascadeTier | null): number {
  return tier === null ? 0 : CASCADE_TIERS.indexOf(tier) + 1;
}

/** A cascade this high makes the figure lean in over the wall to watch. */
export const WATCH_RANK = cascadeRank('lavish');
/** A cascade this high is a big one: it shocks the figure. */
export const SHOCK_RANK = cascadeRank('opulent');
/** How hard each big tier shocks the figure; the top of the ladder knocks the monocle out. */
export const SHOCK_STRENGTH: Readonly<Partial<Record<CascadeTier, number>>> = {
  opulent: 0.45,
  decadent: 0.72,
  obscene: 1,
};

export const REACTION_SECONDS = {
  /** A shock plays out, then the figure goes back to watching (or to idle once the chain ends). */
  shock: 1.7,
  flinch: 0.55,
  /** The figure keeps watching this long after a chain it was watching ends. */
  watchLinger: 1.4,
  /** Sinking behind the wall at the end of the week. */
  exit: 1.6,
} as const;

/** A hit this share of the boss's health or more is a full-strength flinch. */
const FULL_FLINCH_SHARE = 0.02;
const MIN_FLINCH = 0.3;

export const RESTING: BossReaction = {
  mood: 'idle',
  since: 0,
  strength: 0,
  chain: false,
  rank: 0,
  shockedRank: 0,
  endedAt: null,
};

function shockStrength(rank: number): number {
  const top = CASCADE_TIERS[CASCADE_TIERS.length - 1] ?? 'obscene';
  const tier = CASCADE_TIERS[Math.min(rank, CASCADE_TIERS.length) - 1] ?? top;
  return SHOCK_STRENGTH[tier] ?? 0;
}

function finished(state: BossReaction): boolean {
  return state.mood === 'defeated' || state.mood === 'escaped';
}

function climb(state: BossReaction, rank: number, now: number): BossReaction {
  const reached = Math.max(state.rank, rank);
  const next = { ...state, chain: true, rank: reached, endedAt: null };
  if (reached >= SHOCK_RANK && reached > state.shockedRank) {
    return {
      ...next,
      mood: 'shock',
      since: now,
      strength: shockStrength(reached),
      shockedRank: reached,
    };
  }
  if (reached >= WATCH_RANK && (state.mood === 'idle' || state.mood === 'flinch')) {
    return { ...next, mood: 'watch', since: now, strength: 0 };
  }
  return next;
}

/** The reaction after `input` arrives at `now` seconds. Pure: the same inputs give the same state. */
export function react(state: BossReaction, input: BossInput, now: number): BossReaction {
  const current = settle(state, now);
  if (input.kind === 'status') {
    if (input.status === 'active') return finished(current) ? { ...RESTING, since: now } : current;
    if (current.mood === input.status) return current;
    return { ...RESTING, mood: input.status, since: now };
  }
  if (finished(current)) return current;
  switch (input.kind) {
    case 'cascadeStep':
      return input.rank > 0 ? climb(current, input.rank, now) : { ...current, chain: true };
    case 'cascadeTier':
      return climb(current, input.rank, now);
    case 'cascadeEnd':
      return { ...current, chain: false, rank: 0, shockedRank: 0, endedAt: now };
    case 'hit': {
      if (current.mood !== 'idle' && current.mood !== 'watch') return current;
      const share = Number.isFinite(input.share) ? Math.max(input.share, 0) : 0;
      const strength = MIN_FLINCH + (1 - MIN_FLINCH) * Math.min(share / FULL_FLINCH_SHARE, 1);
      return { ...current, mood: 'flinch', since: now, strength };
    }
  }
}

/** Plays out the timed moods up to `now`: shocks and flinches end, a lingering watch lapses. */
export function settle(state: BossReaction, now: number): BossReaction {
  let s = state;
  if (s.mood === 'shock' && now - s.since >= REACTION_SECONDS.shock) {
    const end = s.since + REACTION_SECONDS.shock;
    s = s.chain
      ? { ...s, mood: 'watch', since: end, strength: 0 }
      : { ...s, mood: 'watch', since: end, strength: 0, endedAt: Math.max(s.endedAt ?? end, end) };
  }
  if (s.mood === 'flinch' && now - s.since >= REACTION_SECONDS.flinch) {
    const end = s.since + REACTION_SECONDS.flinch;
    s = { ...s, mood: s.chain && s.rank >= WATCH_RANK ? 'watch' : 'idle', since: end, strength: 0 };
    if (s.mood === 'watch' && !s.chain) s = { ...s, endedAt: end };
  }
  if (s.mood === 'watch' && !s.chain) {
    const ended = s.endedAt ?? s.since;
    const lapse = Math.max(ended, s.since) + REACTION_SECONDS.watchLinger;
    if (now >= lapse) s = { ...s, mood: 'idle', since: lapse, endedAt: null };
  }
  return s;
}

/**
 * Where every animated part of a figure sits. Distances are metres in the figure's own frame,
 * angles radians; `lean` and `headPitch` are positive towards the table.
 */
export interface BossPose {
  /** Height over the resting peek. */
  readonly rise: number;
  readonly lean: number;
  readonly sway: number;
  /** Torso stretch along its height: over 1 on the jump, under 1 on landing. */
  readonly stretch: number;
  readonly headPitch: number;
  readonly headYaw: number;
  readonly headRoll: number;
  readonly hatLift: number;
  readonly hatTilt: number;
  /** 0 is the prop arm at rest, 1 the prop raised to the face. */
  readonly arm: number;
  /** Fast arm motion on top of `arm`: the pen scribbling, the watch being shaken. */
  readonly armJitter: number;
  /** 0 to 1: the monocle has dropped from the eye. */
  readonly eyewearDrop: number;
  /** Lens and gold flash, a multiple of the resting glint. */
  readonly glint: number;
  /** 0 to 1: the backlight behind the figure. */
  readonly halo: number;
}

export const REST_POSE: BossPose = {
  rise: 0,
  lean: 0,
  sway: 0,
  stretch: 1,
  headPitch: 0,
  headYaw: 0,
  headRoll: 0,
  hatLift: 0,
  hatTilt: 0,
  arm: 0,
  armJitter: 0,
  eyewearDrop: 0,
  glint: 0,
  halo: 0,
};

const TAU = Math.PI * 2;

function clamp01(x: number): number {
  return Math.min(Math.max(x, 0), 1);
}

function smooth(x: number): number {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}

/** An underdamped spring from 0 settling on 1: overshoots once, then rings down. */
function spring(t: number, frequency: number, damping: number): number {
  if (t <= 0) return 0;
  return 1 - Math.exp(-damping * t) * Math.cos(TAU * frequency * t);
}

/** A strike that peaks fast at `t` = `peak` and decays back to 0 by `length`. */
function strike(t: number, peak: number, length: number): number {
  if (t <= 0 || t >= length) return 0;
  if (t < peak) return Math.sin((t / peak) * (Math.PI / 2));
  const u = (t - peak) / (length - peak);
  return (1 - u) * (1 - u) * (1 + 2 * u) * Math.cos(u * Math.PI * 1.5) ** 2;
}

/** 0 to 1 over a periodic gesture of `length` seconds that starts every `period` seconds. */
function gesture(now: number, period: number, offset: number, length: number): number {
  const t = (((now + offset) % period) + period) % period;
  if (t > length) return 0;
  return Math.sin((t / length) * Math.PI) ** 2;
}

/** A pose the presence owns and rewrites every frame, so a running figure allocates nothing. */
export type MutableBossPose = { -readonly [K in keyof BossPose]: number };

const POSE_KEYS = Object.keys(REST_POSE) as readonly (keyof BossPose)[];

/** A fresh pose to write into, at rest. */
export function restingPose(): MutableBossPose {
  return { ...REST_POSE };
}

/** Copies `from` into `out` and returns `out`. */
export function copyPose(out: MutableBossPose, from: BossPose): MutableBossPose {
  for (const key of POSE_KEYS) out[key] = from[key];
  return out;
}

function blendInto(
  out: MutableBossPose,
  a: BossPose,
  b: BossPose,
  t: number,
  clamped = true,
): MutableBossPose {
  const k = clamped ? clamp01(t) : t;
  for (const key of POSE_KEYS) out[key] = a[key] + (b[key] - a[key]) * k;
  return out;
}

/** The figure's idle life: breathing, glances and its kind's habit. */
function idle(kind: BossKind, now: number, out: MutableBossPose): MutableBossPose {
  const breathe = Math.sin(now * TAU * 0.24);
  const habit = kind === 'taxInspector' ? gesture(now, 7.5, 2.2, 2.6) : gesture(now, 9.5, 5.4, 2.2);
  const glance = Math.sin(now * 0.37) * 0.2 + Math.sin(now * 0.91 + 1.3) * 0.08;
  copyPose(out, REST_POSE);
  out.rise = breathe * 0.0012;
  out.stretch = 1 + breathe * 0.008;
  out.sway = Math.sin(now * 0.53) * 0.025;
  out.headYaw = glance * (1 - habit);
  out.headRoll = Math.sin(now * 0.29 + 0.6) * 0.05;
  out.headPitch = habit * (kind === 'taxInspector' ? 0.42 : 0.3);
  out.arm = habit;
  out.armJitter =
    kind === 'taxInspector' ? habit * Math.sin(now * TAU * 3.1) * Math.sin(now * TAU * 0.9) : 0;
  out.glint = habit * 0.25;
  return out;
}

const WATCH = {
  rise: 0.012,
  lean: 0.2,
  headPitch: 0.3,
  headRoll: 0,
  halo: 0.25,
  glint: 0.4,
} as const;

function watching(kind: BossKind, now: number, out: MutableBossPose): MutableBossPose {
  idle(kind, now, out);
  out.rise = WATCH.rise;
  out.lean = WATCH.lean * (kind === 'rivalTycoon' ? 1.15 : 1);
  out.headPitch = WATCH.headPitch;
  out.headRoll = WATCH.headRoll;
  out.halo = WATCH.halo;
  out.glint = WATCH.glint;
  out.arm = kind === 'taxInspector' ? 0.55 : 0.15;
  out.armJitter = kind === 'taxInspector' ? Math.sin(now * TAU * 4.2) * 0.6 : 0;
  out.headYaw = Math.sin(now * TAU * 0.6) * 0.06;
  return out;
}

/** Scratch for the pose a shock or flinch plays over; never handed out of this module. */
const UNDER = restingPose();

/** The shock at `t` seconds in, of strength `s`. Each kind has its own take on a big win. */
function shocked(
  kind: BossKind,
  t: number,
  s: number,
  now: number,
  out: MutableBossPose,
): MutableBossPose {
  const watch = watching(kind, now, UNDER);
  const jump = strike(t, 0.1, 0.7);
  const recoil = strike(t, 0.14, 1.25);
  const land = strike(t - 0.55, 0.08, 0.5);
  const hatT = t - 0.04;
  const hatUp = hatT > 0 && hatT < 0.62 ? 4 * (hatT / 0.62) * (1 - hatT / 0.62) : 0;
  const hatSettle = hatT >= 0.62 ? strike(hatT - 0.62, 0.05, 0.4) * 0.12 : 0;
  const settleBack = smooth((t - 0.9) / (REACTION_SECONDS.shock - 0.9));
  const flash = strike(t, 0.05, 0.9);
  const inspector = kind === 'taxInspector';
  out.rise = watch.rise + s * (0.026 * jump - 0.008 * land);
  out.lean = watch.lean - s * (inspector ? 0.5 : 0.28) * recoil;
  out.sway = watch.sway + s * 0.12 * Math.sin(t * TAU * 2.2) * recoil;
  out.stretch = 1 + s * (0.075 * jump - 0.06 * land);
  out.headPitch = watch.headPitch - s * (inspector ? 0.55 : 0.4) * recoil;
  out.headYaw = inspector ? Math.sin(t * TAU * 3.4) * 0.2 * s * recoil : watch.headYaw;
  out.headRoll = s * (inspector ? 0.1 : -0.16) * recoil;
  out.hatLift = s * (0.05 * hatUp + 0.006 * hatSettle);
  out.hatTilt = s * (inspector ? -0.35 : 0.5) * hatUp;
  out.arm = inspector ? 0.55 + 0.45 * recoil : 0.15 + 0.85 * smooth(t / 0.25) * (1 - settleBack);
  out.armJitter = inspector
    ? Math.sin(t * TAU * 6) * recoil
    : Math.sin(t * TAU * 5) * 0.8 * recoil * s;
  out.eyewearDrop = inspector ? 0 : s >= 1 ? smooth((t - 0.08) / 0.3) * (1 - settleBack) : 0;
  out.glint = watch.glint + s * 2.5 * flash;
  out.halo = watch.halo + s * 0.9 * smooth(t / 0.08) * (1 - smooth((t - 0.2) / 1.3));
  return blendInto(out, out, watch, settleBack * 0.6);
}

function flinched(
  kind: BossKind,
  t: number,
  s: number,
  now: number,
  out: MutableBossPose,
): MutableBossPose {
  const from = idle(kind, now, UNDER);
  const hit = strike(t, 0.06, REACTION_SECONDS.flinch);
  copyPose(out, from);
  out.rise = from.rise - 0.008 * s * hit;
  out.lean = from.lean - 0.12 * s * hit;
  out.headPitch = from.headPitch - 0.2 * s * hit;
  out.headRoll = from.headRoll + (kind === 'taxInspector' ? 0.12 : -0.12) * s * hit;
  out.stretch = from.stretch - 0.04 * s * hit;
  out.glint = from.glint + 1.6 * s * hit;
  out.halo = Math.max(from.halo, 0.4 * s * hit);
  out.armJitter = from.armJitter + Math.sin(now * TAU * 7) * 0.3 * s * hit;
  return out;
}

/** How far below the resting peek the figure has sunk by the end of the week. */
export const EXIT_DEPTH = 0.2;

function exited(
  kind: BossKind,
  mood: 'defeated' | 'escaped',
  t: number,
  out: MutableBossPose,
): MutableBossPose {
  const u = smooth(t / REACTION_SECONDS.exit);
  const defeated = mood === 'defeated';
  const beat = strike(t, 0.12, 0.9);
  copyPose(out, REST_POSE);
  out.rise = -EXIT_DEPTH * u + (defeated ? 0 : 0.012 * beat);
  out.lean = defeated ? -0.3 * beat : 0.1 * beat;
  out.headPitch = defeated ? -0.3 * beat : 0.25 * beat;
  out.hatLift = defeated ? 0.03 * beat : 0;
  out.hatTilt = defeated ? -0.4 * beat : 0.6 * beat;
  out.arm = defeated ? 0 : beat;
  out.eyewearDrop = defeated && kind === 'rivalTycoon' ? smooth(t / 0.3) : 0;
  out.glint = 1.5 * beat;
  return out;
}

/**
 * Light-only reactions for reduced motion: the figure holds still at its resting peek (no
 * breathing, no jumps), and moods read through the lens flash and the backlight alone. The end
 * of the week fades it below the wall over the same time, without the flourish.
 */
function reducedPose(reaction: BossReaction, t: number, out: MutableBossPose): MutableBossPose {
  copyPose(out, REST_POSE);
  switch (reaction.mood) {
    case 'idle':
      return out;
    case 'watch':
      out.halo = 0.25;
      out.glint = 0.4;
      return out;
    case 'shock': {
      const glow = 1 - smooth(t / REACTION_SECONDS.shock);
      out.glint = 0.4 + reaction.strength * 2.5 * glow;
      out.halo = 0.25 + reaction.strength * 0.75 * glow;
      return out;
    }
    case 'flinch':
      out.glint = reaction.strength * (1 - smooth(t / REACTION_SECONDS.flinch));
      return out;
    case 'defeated':
    case 'escaped':
      out.rise = -EXIT_DEPTH * smooth(t / REACTION_SECONDS.exit);
      return out;
  }
}

/**
 * The pose a `kind` figure aims for at `now` seconds in `reaction` (settle it first), written
 * into `out` (a fresh pose by default). The presence eases into it from the pose the last mood
 * left over `MOOD_EASE`, so nothing snaps.
 */
export function poseAt(
  kind: BossKind,
  reaction: BossReaction,
  now: number,
  reducedMotion: boolean,
  out: MutableBossPose = restingPose(),
): MutableBossPose {
  const t = Math.max(now - reaction.since, 0);
  if (reducedMotion) return reducedPose(reaction, t, out);
  switch (reaction.mood) {
    case 'idle':
      return idle(kind, now, out);
    case 'watch':
      return watching(kind, now, out);
    case 'shock':
      return shocked(kind, t, reaction.strength, now, out);
    case 'flinch':
      return flinched(kind, t, reaction.strength, now, out);
    case 'defeated':
    case 'escaped':
      return exited(kind, reaction.mood, t, out);
  }
}

/** Seconds a mood takes to take over from the pose the last one left: attacks land at once. */
export const MOOD_EASE: Readonly<Record<BossMood, number>> = {
  idle: 0.9,
  watch: 0.45,
  shock: 0.06,
  flinch: 0.05,
  defeated: 0.3,
  escaped: 0.3,
};

/**
 * `to` taking over from `from` `t` seconds into a mood that eases in over `seconds`, on an
 * underdamped spring so a lean-in overshoots a touch and settles, written into `out` (a fresh
 * pose by default). Reduced motion eases without the overshoot.
 */
export function crossfade(
  from: BossPose,
  to: BossPose,
  t: number,
  seconds: number,
  reducedMotion: boolean,
  out: MutableBossPose = restingPose(),
): MutableBossPose {
  if (t >= seconds * 2.5 || seconds <= 0) return copyPose(out, to);
  const u = t / seconds;
  const k = reducedMotion ? smooth(u) : Math.min(spring(u, 0.55, 4.5), 1.08);
  return blendInto(out, from, to, k, false);
}
