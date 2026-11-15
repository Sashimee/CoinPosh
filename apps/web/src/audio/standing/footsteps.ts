import type { StaffRole } from '@coinposh/shared';
import type { PitchVariator } from '../collecting/variation.ts';
import { clamp, lerp, type Rng } from '../rng.ts';
import { MAX_IMPACT_PAN } from '../synth/impactSpec.ts';
import { nyquistCeiling } from './fanfare.ts';
import { signedSpread } from '../collecting/variation.ts';

export interface StepNoise {
  readonly filter: BiquadFilterType;
  readonly frequency: number;
  readonly q: number;
  readonly gain: number;
  readonly t60: number;
  /** Seconds after the footfall: the heel lands first, then the toe rolls down. */
  readonly delay: number;
}

export interface StepBody {
  /** The floorboard's thump, gliding down as the weight settles. */
  readonly frequency: number;
  readonly endFrequency: number;
  readonly gain: number;
  readonly t60: number;
}

/** What a role carries and how it answers some steps: a bottle's clink, a key fob's jingle. */
export interface StepTrinket {
  readonly chance: number;
  readonly frequency: number;
  readonly ratios: readonly number[];
  readonly gain: number;
  readonly t60: number;
  readonly delay: number;
}

export interface FootstepProfile {
  /** Seconds between footfalls at a walk. */
  readonly cadence: number;
  readonly level: number;
  readonly heel: StepNoise;
  readonly toe: StepNoise;
  readonly body: StepBody;
  readonly trinket: StepTrinket | null;
}

/**
 * 03-ART asks for soft footsteps. The Butler walks measured, leather soles on parquet; the Valet
 * is brisk and light, the car keys at his belt jingling now and then; the Sommelier pads slowly
 * on soft soles while a bottle clinks in the cradle on his arm.
 */
export const FOOTSTEP_PROFILES: Readonly<Record<StaffRole, FootstepProfile>> = {
  butler: {
    cadence: 0.56,
    level: 0.16,
    heel: { filter: 'bandpass', frequency: 1400, q: 1.2, gain: 0.55, t60: 0.05, delay: 0 },
    toe: { filter: 'bandpass', frequency: 2600, q: 1.5, gain: 0.28, t60: 0.035, delay: 0.045 },
    body: { frequency: 110, endFrequency: 72, gain: 0.35, t60: 0.09 },
    trinket: null,
  },
  valet: {
    cadence: 0.42,
    level: 0.14,
    heel: { filter: 'bandpass', frequency: 1900, q: 1.4, gain: 0.5, t60: 0.04, delay: 0 },
    toe: { filter: 'bandpass', frequency: 3200, q: 1.6, gain: 0.3, t60: 0.03, delay: 0.035 },
    body: { frequency: 130, endFrequency: 88, gain: 0.26, t60: 0.07 },
    trinket: {
      chance: 0.22,
      frequency: 3100,
      ratios: [1, 1.37, 1.93],
      gain: 0.12,
      t60: 0.16,
      delay: 0.02,
    },
  },
  sommelier: {
    cadence: 0.62,
    level: 0.12,
    heel: { filter: 'lowpass', frequency: 900, q: 0.8, gain: 0.6, t60: 0.07, delay: 0 },
    toe: { filter: 'bandpass', frequency: 1500, q: 1, gain: 0.25, t60: 0.05, delay: 0.06 },
    body: { frequency: 95, endFrequency: 64, gain: 0.4, t60: 0.11 },
    trinket: {
      chance: 0.3,
      frequency: 2050,
      ratios: [1, 2.71],
      gain: 0.1,
      t60: 0.35,
      delay: 0.05,
    },
  },
};

export type Foot = 'left' | 'right';

export interface FootstepHit {
  readonly at: number;
  readonly foot: Foot;
  /** Pitch factor from the ±6 % variator, so no two footfalls sound the same. */
  readonly pitch: number;
  readonly level: number;
  readonly pan: number;
  /** Where in the shared noise buffer this footfall reads, 0..1. */
  readonly heelOffset: number;
  readonly toeOffset: number;
  readonly trinket: boolean;
}

export interface StaffWalkSpec {
  readonly role: StaffRole;
  readonly profile: FootstepProfile;
  readonly steps: readonly FootstepHit[];
  readonly gain: number;
  readonly duration: number;
  readonly priority: number;
}

export interface StaffWalk {
  /** Footfalls to play, 1..{@link MAX_WALK_STEPS}. */
  readonly steps: number;
  /** Where the walk starts and ends in the stereo field, so the figure crossing the table is heard crossing. */
  readonly fromPan?: number;
  readonly toPan?: number;
  /** Which foot lands first; defaults to the left. */
  readonly firstFoot?: Foot;
}

/** Quiet: footsteps are the first thing to give way when the pool is full. */
export const FOOTSTEP_PRIORITY = 20;
export const MAX_WALK_STEPS = 16;
const GAIT_JITTER = 0.03;
const LEVEL_SPREAD = 0.12;
/** A body's weight never falls evenly: the trailing foot lands a touch softer. */
const TRAILING_FOOT_LEVEL = 0.88;
const FOOT_PAN_OFFSET = 0.04;
const TAIL = 0.01;

export function assertWalk(walk: StaffWalk): void {
  if (!Number.isInteger(walk.steps) || walk.steps < 1 || walk.steps > MAX_WALK_STEPS) {
    throw new RangeError(
      `A staff walk has 1..${MAX_WALK_STEPS} whole steps, got ${walk.steps}; split a longer walk into several calls.`,
    );
  }
  for (const pan of [walk.fromPan, walk.toPan]) {
    if (pan !== undefined && !Number.isFinite(pan)) {
      throw new RangeError(`Staff walk pan must be a finite number, got ${pan}`);
    }
  }
}

function stepRing(profile: FootstepProfile): number {
  const { heel, toe, body, trinket } = profile;
  return Math.max(
    heel.delay + heel.t60,
    toe.delay + toe.t60,
    body.t60,
    trinket ? trinket.delay + trinket.t60 : 0,
  );
}

export function buildStaffWalk(
  role: StaffRole,
  walk: StaffWalk,
  pitch: PitchVariator<StaffRole>,
  rng: Rng,
): StaffWalkSpec {
  assertWalk(walk);
  const profile = FOOTSTEP_PROFILES[role];
  const fromPan = clamp(walk.fromPan ?? 0, -MAX_IMPACT_PAN, MAX_IMPACT_PAN);
  const toPan = clamp(walk.toPan ?? fromPan, -MAX_IMPACT_PAN, MAX_IMPACT_PAN);
  const first = walk.firstFoot ?? 'left';
  const steps: FootstepHit[] = [];
  let at = 0;
  for (let i = 0; i < walk.steps; i++) {
    const leading = i % 2 === 0;
    const foot: Foot = leading === (first === 'left') ? 'left' : 'right';
    const along = walk.steps === 1 ? 0 : i / (walk.steps - 1);
    const side = foot === 'left' ? -FOOT_PAN_OFFSET : FOOT_PAN_OFFSET;
    steps.push({
      at,
      foot,
      pitch: pitch.next(role),
      level: signedSpread(rng, LEVEL_SPREAD) * (leading ? 1 : TRAILING_FOOT_LEVEL),
      pan: clamp(lerp(fromPan, toPan, along) + side, -MAX_IMPACT_PAN, MAX_IMPACT_PAN),
      heelOffset: rng(),
      toeOffset: rng(),
      trinket: profile.trinket !== null && rng() < profile.trinket.chance,
    });
    at += profile.cadence * signedSpread(rng, GAIT_JITTER);
  }
  const last = steps.at(-1)?.at ?? 0;
  return {
    role,
    profile,
    steps,
    gain: profile.level,
    duration: last + stepRing(profile) + TAIL,
    priority: FOOTSTEP_PRIORITY,
  };
}

export function trinketRatios(
  profile: FootstepProfile,
  pitch: number,
  sampleRate: number,
): number[] {
  const { trinket } = profile;
  if (!trinket) return [];
  const ceiling = nyquistCeiling(sampleRate);
  return trinket.ratios.filter((ratio) => trinket.frequency * ratio * pitch < ceiling);
}

/** Heel and toe noise plus the body thump per footfall, and a partial per trinket ratio that rings. */
export function staffWalkCost(spec: StaffWalkSpec, sampleRate: number): number {
  return spec.steps.reduce(
    (sum, step) =>
      sum + 3 + (step.trinket ? trinketRatios(spec.profile, step.pitch, sampleRate).length : 0),
    0,
  );
}
