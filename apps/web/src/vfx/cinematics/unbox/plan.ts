import { RARITIES, type Rarity } from '@coinposh/shared';
import {
  easeInCubic,
  easeInOutCubic,
  easeInQuad,
  easeOutBack,
  easeOutCubic,
  progress,
} from '../../easing.ts';
import type { HapticPattern } from '../../haptics.ts';
import type { JuiceItem } from '../../juice.ts';
import { HEIRLOOM_PRISM, RARITY_COLORS } from '../../palette.ts';

/** Beats of the unbox, in ms from the crate entering the tray. */
export interface UnboxTimeline {
  readonly landMs: number;
  readonly dollyMs: number;
  readonly shudderAtMs: readonly [number, number, number];
  readonly shudderMs: number;
  readonly raysAtMs: number;
  readonly burstAtMs: number;
  readonly pedestalMs: number;
  /** The reward card comes up; the cinematic then holds until the player collects. */
  readonly revealAtMs: number;
  /** Item flight into the inventory and the camera's return, after Collect. */
  readonly flyMs: number;
}

/**
 * 03-ART-AUDIO-JUICE.md: the crate lands in the tray, the camera dollies in, the lid shudders
 * three times on a rising rumble, rarity god-rays leak through the seams, then the burst puts
 * the item on a spinning velvet pedestal. About 2.4 s to the reveal, so it stays a treat.
 */
export const FULL_UNBOX: UnboxTimeline = {
  landMs: 360,
  dollyMs: 900,
  shudderAtMs: [700, 1_120, 1_540],
  shudderMs: 300,
  raysAtMs: 860,
  burstAtMs: 2_000,
  pedestalMs: 620,
  revealAtMs: 2_380,
  flyMs: 520,
};

/**
 * Reduced motion: no fall, dolly, shake or spin. The three beats stay as light pulses and
 * rumbles, the rays fade up, and the item appears on its pedestal in under a second.
 */
export const REDUCED_UNBOX: UnboxTimeline = {
  landMs: 0,
  dollyMs: 0,
  shudderAtMs: [100, 300, 500],
  shudderMs: 180,
  raysAtMs: 100,
  burstAtMs: 720,
  pedestalMs: 0,
  revealAtMs: 820,
  flyMs: 0,
};

export function unboxTimeline(reducedMotion: boolean): UnboxTimeline {
  return reducedMotion ? REDUCED_UNBOX : FULL_UNBOX;
}

export type UnboxBeatKind = 'land' | 'shudder' | 'rays' | 'burst' | 'reveal';

export interface UnboxBeat {
  readonly kind: UnboxBeatKind;
  readonly atMs: number;
  /** 1..3 for the shudders, rising; 0 otherwise. */
  readonly step: number;
}

export function unboxBeats(timeline: UnboxTimeline): readonly UnboxBeat[] {
  const beats: UnboxBeat[] = [
    { kind: 'land', atMs: timeline.landMs, step: 0 },
    ...timeline.shudderAtMs.map((atMs, i) => ({ kind: 'shudder' as const, atMs, step: i + 1 })),
    { kind: 'rays', atMs: timeline.raysAtMs, step: 0 },
    { kind: 'burst', atMs: timeline.burstAtMs, step: 0 },
    { kind: 'reveal', atMs: timeline.revealAtMs, step: 0 },
  ];
  return beats.sort((a, b) => a.atMs - b.atMs);
}

/** Everything the stage needs to draw one frame of the unbox. */
export interface UnboxPose {
  /** 0 hanging over the tray, 1 landed. */
  readonly drop: number;
  /** Vertical scale of the crate; under 1 while it squashes on landing. */
  readonly squash: number;
  readonly lidLift: number;
  /** Lid roll in radians while it shudders. */
  readonly lidShake: number;
  /** 0..1, how hard the current shudder rumbles; drives the seam glow. */
  readonly rumble: number;
  /** 0..1 god-ray brightness. */
  readonly rays: number;
  /** 0..1 god-ray reach. */
  readonly rayReach: number;
  /** 0..1 burst flash envelope. */
  readonly burst: number;
  /** 0 shut, 1 blown clear. */
  readonly lidOpen: number;
  /** 0 hidden in the crate, 1 risen; overshoots on the way. */
  readonly pedestal: number;
  readonly itemSpin: number;
  /** 0 at the venue framing, 1 fully dollied in on the crate. */
  readonly dolly: number;
  /** 0..1, the item's flight into the inventory after Collect. */
  readonly fly: number;
}

const LAND_SQUASH = 0.22;
const SQUASH_MS = 240;
const SHUDDER_LIFT = 0.007;
const SHUDDER_ROLL = 0.09;
const SHUDDER_WIGGLES = 6;
const BURST_ATTACK_MS = 60;
const BURST_DECAY_MS = 520;
const LID_CLEAR_MS = 360;
const PEDESTAL_DELAY_MS = 80;
const SPIN_RAD_PER_S = 2.6;
const RAYS_AFTER_BURST = 0.7;

/**
 * Samples the unbox at `ms`. `flyMs` is the time since Collect, or null before it. Pure, so
 * the choreography is tested frame by frame without a GPU.
 */
export function unboxPose(
  ms: number,
  timeline: UnboxTimeline,
  reducedMotion: boolean,
  flyMs: number | null = null,
): UnboxPose {
  const t = Math.max(0, ms);
  const drop = reducedMotion ? 1 : easeInQuad(progress(t, 0, timeline.landMs));
  const settle = progress(t, timeline.landMs, timeline.landMs + SQUASH_MS);
  const squash =
    reducedMotion || settle <= 0 || settle >= 1
      ? 1
      : 1 - LAND_SQUASH * Math.sin(Math.PI * settle) * (1 - settle);

  let lidLift = 0;
  let lidShake = 0;
  let rumble = 0;
  timeline.shudderAtMs.forEach((at, i) => {
    const local = progress(t, at, at + timeline.shudderMs);
    if (local <= 0 || local >= 1) return;
    const strength = (i + 1) / timeline.shudderAtMs.length;
    const envelope = Math.sin(Math.PI * local);
    rumble = Math.max(rumble, strength * envelope);
    if (reducedMotion) return;
    lidLift = Math.max(lidLift, strength * SHUDDER_LIFT * envelope);
    lidShake = strength * SHUDDER_ROLL * Math.sin(local * Math.PI * SHUDDER_WIGGLES) * (1 - local);
  });

  const leak = easeInCubic(progress(t, timeline.raysAtMs, timeline.burstAtMs));
  const sinceBurst = t - timeline.burstAtMs;
  const burst =
    sinceBurst < 0
      ? 0
      : sinceBurst < BURST_ATTACK_MS
        ? sinceBurst / BURST_ATTACK_MS
        : 1 - easeOutCubic(progress(sinceBurst, BURST_ATTACK_MS, BURST_ATTACK_MS + BURST_DECAY_MS));
  const afterBurst = sinceBurst < 0 ? 0 : progress(sinceBurst, 0, BURST_DECAY_MS);
  const rays = sinceBurst < 0 ? leak * 0.8 : 1 - (1 - RAYS_AFTER_BURST) * afterBurst;
  const rayReach = sinceBurst < 0 ? 0.25 + 0.5 * leak : 0.75 + 0.25 * afterBurst;

  const lidOpen =
    sinceBurst < 0 ? 0 : reducedMotion ? 1 : easeOutCubic(progress(sinceBurst, 0, LID_CLEAR_MS));
  const pedestal =
    sinceBurst < 0
      ? 0
      : reducedMotion
        ? 1
        : easeOutBack(1.9)(
            progress(sinceBurst, PEDESTAL_DELAY_MS, PEDESTAL_DELAY_MS + timeline.pedestalMs),
          );
  const itemSpin =
    reducedMotion || sinceBurst < 0
      ? 0
      : (sinceBurst / 1000) * SPIN_RAD_PER_S + 0.6 * easeOutCubic(afterBurst);

  const fly =
    flyMs === null ? 0 : reducedMotion ? 1 : easeInOutCubic(progress(flyMs, 0, timeline.flyMs));
  const dollyIn = reducedMotion ? 0 : easeInOutCubic(progress(t, 0, timeline.dollyMs));
  return {
    drop,
    squash,
    lidLift,
    lidShake,
    rumble,
    rays: rays * (1 - fly),
    rayReach,
    burst,
    lidOpen,
    pedestal,
    itemSpin,
    dolly: dollyIn * (1 - fly),
    fly,
  };
}

export interface RayStyle {
  /** Colours handed round the fan; heirloom cycles the prism. */
  readonly colors: readonly string[];
  readonly count: number;
  /** HDR peak of each ray; above 1 blooms. */
  readonly intensity: number;
  /** Fan half-angle in radians. */
  readonly spread: number;
  /** Fan rotation speed in rad/s; heirloom's prism wheels round. */
  readonly swirl: number;
}

/** Rarer crates leak more, brighter, wider rays. */
export function rayStyle(rarity: Rarity): RayStyle {
  const rank = RARITIES.indexOf(rarity);
  if (rank < 0) throw new RangeError(`Unknown rarity "${rarity}" for the unbox god-rays`);
  return {
    colors: rarity === 'heirloom' ? HEIRLOOM_PRISM : [RARITY_COLORS[rarity]],
    count: 4 + rank * 2 + (rarity === 'heirloom' ? 2 : 0),
    intensity: 1.2 + rank * 0.55,
    spread: 0.35 + rank * 0.07,
    swirl: rarity === 'heirloom' ? 0.9 : 0.12 + rank * 0.04,
  };
}

export interface BurstStyle {
  readonly hitStopMs: number;
  /** Camera trauma at the burst, 0..1. */
  readonly shake: number;
  readonly fovKick: number;
  readonly haptic: HapticPattern;
  readonly confetti: boolean;
  /** Bloom surge peak at the burst. */
  readonly glow: number;
}

/** The burst escalates with rarity: hit-stop from Rare, confetti from Legendary. */
export function burstStyle(rarity: Rarity): BurstStyle {
  const rank = RARITIES.indexOf(rarity);
  if (rank < 0) throw new RangeError(`Unknown rarity "${rarity}" for the unbox burst`);
  return {
    hitStopMs: rank >= 2 ? Math.min(80, 40 + (rank - 2) * 13) : 0,
    shake: 0.12 + rank * 0.07,
    fovKick: 0.8 + rank * 0.45,
    haptic: rank >= 4 ? 'fanfare' : rank >= 2 ? 'thud' : 'tap',
    confetti: rank >= 4,
    glow: 0.5 + rank * 0.3,
  };
}

/** What the unbox delivers on the juice checklist; sound comes through the crate stingers. */
export const UNBOX_JUICE: {
  readonly items: readonly JuiceItem[];
  readonly reduced: string;
} = {
  items: [
    'sound',
    'hapticOrShake',
    'particles',
    'squashOvershoot',
    'lightResponse',
    'numberPop',
    'timeManipulation',
    'camera',
  ],
  reduced:
    'No fall, dolly, lid shake, spin or flight: the shudders stay as rumbles and seam glow, the rays fade up, and the item appears on its pedestal with its rewards.',
};
