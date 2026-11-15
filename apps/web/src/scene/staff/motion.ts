import type { StaffRole } from '@coinposh/shared';
import { Vector3 } from 'three/webgpu';
import { clamp01, easeInOutCubic, easeOutBack, easeOutCubic, progress } from '../../vfx/easing.ts';
import { BOTTLE_MOUTH, BOWL_TARGET, STREAM_LENGTH } from './figures.ts';
import {
  add,
  BONE_INDEX,
  type BoneName,
  CHANNELS,
  mixPose,
  type Pose,
  restPose,
  type Rig,
} from './rig.ts';
import { GLINT_PARKED } from './materials.ts';

/** Seconds each role's action plays before the figure is back at idle. */
export const ACTION_SECONDS: Readonly<Record<StaffRole, number>> = {
  butler: 3,
  valet: 3.1,
  sommelier: 3.5,
};

/** Seconds to sit down on the trunk when sent on leave, and to stand back up. */
export const LEAVE_SECONDS = 0.9;

export interface Clock {
  /** Idle time, seconds; already offset by the figure's phase. */
  readonly t: number;
  /** Seconds into the action, or a negative number when none plays. */
  readonly action: number;
  /** 0 standing at work, 1 seated on leave; eased by the caller. */
  readonly leave: number;
  readonly reduced: boolean;
}

/** What the material and the props need besides the bones. */
export interface Cues {
  glint: number;
  /** 0..1, how much of the sommelier's pour is in the air. */
  pour: number;
}

/**
 * 0 before `a`, eased up to 1 by `b`, held until `c`, eased back to 0 by `d`. The core of every
 * gesture: each beat of an action is one envelope over its seconds.
 */
export function env(s: number, a: number, b: number, c: number, d: number): number {
  if (s <= a || s >= d) return 0;
  if (s < b) return easeInOutCubic(progress(s, a, b));
  if (s <= c) return 1;
  return 1 - easeInOutCubic(progress(s, c, d));
}

/** A cheap deterministic hash of an integer into [0, 1). */
function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Every few seconds the figure looks off to one side and back. */
function glance(t: number): number {
  const period = 6.5;
  const k = Math.floor(t / period);
  const s = t - k * period;
  const side = hash(k) < 0.5 ? -1 : 1;
  return side * (0.25 + hash(k + 17) * 0.3) * env(s, 3.6, 4.2, 5.2, 5.9);
}

function breathe(pose: Pose, t: number, amount: number): void {
  const b = Math.sin(t * 1.7) * amount;
  add(pose, 'spine', { py: b * 0.00018, rx: -b * 0.012 });
  add(pose, 'chest', { rx: -b * 0.015 });
  add(pose, 'shoulderL', { rz: b * 0.01 });
  add(pose, 'shoulderR', { rz: -b * 0.01 });
  add(pose, 'head', { rx: b * 0.02 });
}

function shiftWeight(pose: Pose, t: number): void {
  const w = Math.sin(t * 0.45);
  add(pose, 'pelvis', { px: w * 0.0004, rz: -w * 0.018 });
  add(pose, 'spine', { rz: w * 0.022 });
  add(pose, 'hipL', { rz: w * 0.018 });
  add(pose, 'hipR', { rz: w * 0.018 });
}

function idle(role: StaffRole, pose: Pose, t: number, alive: boolean): void {
  restPose(pose);
  add(pose, 'stream', { s: 0 });
  add(pose, 'trunk', { s: 0 });
  add(pose, 'fill', { s: 0.55 });
  add(pose, 'shoulderL', { rz: 0.06 });
  add(pose, 'shoulderR', { rz: -0.06 });
  add(pose, 'hipL', { rz: 0.02 });
  add(pose, 'hipR', { rz: -0.02 });
  switch (role) {
    case 'butler':
      add(pose, 'shoulderL', { rx: -0.3, rz: 0.08 });
      add(pose, 'elbowL', { rx: -1.28 });
      add(pose, 'shoulderR', { rx: 0.3, rz: 0.1 });
      add(pose, 'elbowR', { rx: -0.25, rz: 1.25, ry: 0.4 });
      add(pose, 'chest', { rx: -0.04 });
      add(pose, 'head', { rx: -0.06 });
      break;
    case 'valet':
      add(pose, 'shoulderR', { rz: -0.16, rx: -0.06 });
      add(pose, 'elbowR', { rx: -0.12 });
      add(pose, 'shoulderL', { rx: 0.04, rz: 0.04 });
      add(pose, 'elbowL', { rx: -0.2 });
      add(pose, 'spine', { rz: 0.04 });
      break;
    case 'sommelier':
      add(pose, 'shoulderL', { rx: -0.26, rz: -0.1 });
      add(pose, 'elbowL', { rx: -1.15, ry: -0.35 });
      add(pose, 'shoulderR', { rx: -0.18, rz: -0.08 });
      add(pose, 'elbowR', { rx: -0.95, ry: 0.5 });
      add(pose, 'head', { rx: 0.04 });
      break;
  }
  if (!alive) return;
  breathe(pose, t, 1);
  shiftWeight(pose, t);
  add(pose, 'head', { ry: glance(t) });
  if (role === 'butler') add(pose, 'shoulderL', { rx: Math.sin(t * 0.9 + 1) * 0.012 });
  if (role === 'valet') add(pose, 'hat', { rz: Math.sin(t * 0.6) * 0.03 });
}

/** Moves a bone's rotation towards an absolute target by `w`, whatever the idle had it at. */
function blendTo(
  pose: Pose,
  bone: BoneName,
  target: { rx: number; ry: number; rz: number },
  w: number,
) {
  const o = BONE_INDEX[bone] * CHANNELS;
  const to = [target.rx, target.ry, target.rz];
  for (let c = 0; c < 3; c += 1) {
    const from = pose[o + c] ?? 0;
    pose[o + c] = from + ((to[c] ?? 0) - from) * w;
  }
}

function bow(pose: Pose, s: number): Cues {
  const hand = env(s, 0.1, 0.55, 2.3, 2.85);
  blendTo(pose, 'shoulderR', { rx: -0.35, ry: 0, rz: -0.1 }, hand);
  blendTo(pose, 'elbowR', { rx: -1.7, ry: -0.25, rz: 1 }, hand);
  const b = env(s, 0.45, 1.05, 1.65, 2.4);
  add(pose, 'spine', { rx: 0.3 * b });
  add(pose, 'chest', { rx: 0.34 * b });
  add(pose, 'head', { rx: 0.28 * b });
  add(pose, 'hipL', { rx: -0.08 * b });
  add(pose, 'hipR', { rx: -0.08 * b });
  add(pose, 'shoulderL', { rx: -0.25 * b });
  const lid =
    s < 1.9
      ? easeOutBack(1.4)(progress(s, 0.95, 1.45))
      : 1 - easeInOutCubic(progress(s, 2.15, 2.75));
  add(pose, 'lid', { rx: -1.75 * lid });
  const sweep = progress(s, 1.2, 1.95);
  return { glint: sweep > 0 && sweep < 1 ? 0.02 + sweep * 0.06 : GLINT_PARKED, pour: 0 };
}

function carry(pose: Pose, s: number): Cues {
  const crouch = env(s, 0, 0.35, 0.5, 0.85) + env(s, 2.3, 2.5, 2.6, 2.85);
  add(pose, 'pelvis', { py: -0.0035 * crouch });
  add(pose, 'hipL', { rx: -0.55 * crouch });
  add(pose, 'hipR', { rx: -0.55 * crouch });
  add(pose, 'kneeL', { rx: 1.0 * crouch });
  add(pose, 'kneeR', { rx: 1.0 * crouch });
  add(pose, 'spine', { rx: 0.35 * crouch });
  add(pose, 'chest', { rx: 0.1 * crouch });
  const lift = env(s, 0.5, 0.95, 2.25, 2.65);
  add(pose, 'shoulderR', { rx: -0.25 * lift, rz: -0.2 * lift });
  add(pose, 'elbowR', { rx: -1.75 * lift, ry: -0.35 * lift });
  add(pose, 'spine', { rz: -0.07 * lift });
  const march = env(s, 0.95, 1.1, 2.0, 2.2);
  const step = Math.sin((s - 0.95) * Math.PI * 3.2);
  add(pose, 'hipL', { rx: -0.42 * march * Math.max(step, 0) });
  add(pose, 'kneeL', { rx: 0.8 * march * Math.max(step, 0) });
  add(pose, 'hipR', { rx: -0.42 * march * Math.max(-step, 0) });
  add(pose, 'kneeR', { rx: 0.8 * march * Math.max(-step, 0) });
  add(pose, 'pelvis', { py: 0.0006 * march * Math.abs(step), rz: 0.04 * march * step });
  add(pose, 'shoulderL', { rx: 0.35 * march * step });
  add(pose, 'root', { ry: 0.12 * march * Math.sin((s - 0.95) * Math.PI * 1.6) });
  const tip = env(s, 2.45, 2.75, 2.85, 3.1);
  add(pose, 'shoulderL', { rx: -2.3 * tip, rz: -0.35 * tip });
  add(pose, 'elbowL', { rx: -1.2 * tip, ry: 0.4 * tip });
  add(pose, 'head', { rx: 0.16 * tip });
  add(pose, 'hat', { rx: -0.3 * tip, py: 0.0008 * tip });
  return { glint: GLINT_PARKED, pour: 0 };
}

function pourAction(pose: Pose, s: number): Cues {
  const raise = env(s, 0.1, 0.6, 2.2, 2.75);
  add(pose, 'shoulderR', { rx: -0.62 * raise, rz: 0.69 * raise });
  add(pose, 'elbowR', { rx: -0.5 * raise, ry: -0.8 * raise });
  const offer = env(s, 0.15, 0.6, 2.1, 2.6);
  add(pose, 'shoulderL', { rx: -0.14 * offer, rz: -0.26 * offer });
  add(pose, 'elbowL', { rx: 0.1 * offer, ry: 0.65 * offer });
  add(pose, 'head', { rx: 0.22 * offer, ry: 0.12 * offer });
  add(pose, 'chest', { rx: 0.06 * offer });
  const fill = progress(s, 1.05, 1.95) - progress(s, 2.95, 3.3);
  add(pose, 'fill', { s: 1 + (1 / 0.55 - 1) * easeOutCubic(fill) });
  const sip = env(s, 2.6, 2.95, 3.1, 3.45);
  add(pose, 'shoulderL', { rx: -0.64 * sip, rz: -0.76 * sip });
  add(pose, 'elbowL', { rx: -0.6 * sip, ry: 0.95 * sip });
  add(pose, 'head', { rx: -0.2 * sip });
  return { glint: GLINT_PARKED, pour: env(s, 0.95, 1.05, 1.85, 1.98) };
}

function onLeave(pose: Pose, t: number, alive: boolean): void {
  restPose(pose);
  add(pose, 'stream', { s: 0 });
  add(pose, 'propL', { s: 0 });
  add(pose, 'propR', { s: 0 });
  add(pose, 'pelvis', { py: -0.0118, pz: -0.0036, rx: -0.05 });
  add(pose, 'hipL', { rx: -1.42, rz: 0.1 });
  add(pose, 'hipR', { rx: -1.42, rz: -0.1 });
  add(pose, 'kneeL', { rx: 1.38 });
  add(pose, 'kneeR', { rx: 1.38 });
  add(pose, 'spine', { rx: 0.18 });
  add(pose, 'chest', { rx: 0.14 });
  add(pose, 'head', { rx: 0.42, rz: 0.08 });
  add(pose, 'shoulderL', { rx: -0.58, rz: -0.02 });
  add(pose, 'shoulderR', { rx: -0.58, rz: 0.02 });
  add(pose, 'elbowL', { rx: -0.55, ry: -0.2 });
  add(pose, 'elbowR', { rx: -0.55, ry: 0.2 });
  if (!alive) return;
  const b = Math.sin(t * 0.9);
  add(pose, 'spine', { rx: -b * 0.02 });
  add(pose, 'chest', { rx: -b * 0.02 });
  add(pose, 'head', { rx: b * 0.03 });
}

const working = restPose();
const seated = restPose();
const key = restPose();
const ACTIONS: Readonly<Record<StaffRole, (pose: Pose, s: number) => Cues>> = {
  butler: bow,
  valet: carry,
  sommelier: pourAction,
};

/** How strongly a reduced-motion action shows: its key pose, faded in and out, never travelling. */
function reducedAction(role: StaffRole, s: number): number {
  return env(s, 0, 0.25, ACTION_SECONDS[role] - 0.25, ACTION_SECONDS[role]);
}

/**
 * The pose of a figure for a clock, written into `out`. A pure function of its inputs: the same
 * role and clock always give the same pose. Reduced motion holds the idle still and shows an
 * action as its key frame, faded in place.
 */
export function composePose(role: StaffRole, clock: Clock, out: Pose): Cues {
  const alive = !clock.reduced;
  idle(role, working, clock.t, alive);
  let cues: Cues = { glint: GLINT_PARKED, pour: 0 };
  const length = ACTION_SECONDS[role];
  if (clock.action >= 0 && clock.action < length) {
    if (alive) {
      cues = ACTIONS[role](working, clock.action);
    } else {
      idle(role, key, 0, false);
      ACTIONS[role](key, KEY_FRAME[role]);
      mixPose(working, working, key, reducedAction(role, clock.action));
    }
  }
  const leave = clamp01(clock.leave);
  if (leave <= 0) {
    out.set(working);
  } else {
    onLeave(seated, clock.t, alive);
    mixPose(out, working, seated, leave);
    const pop = easeOutBack(1.6)(progress(leave, 0, 0.55));
    out[BONE_INDEX.trunk * CHANNELS + 6] = Math.max(pop, 0);
    cues = { glint: cues.glint, pour: cues.pour * (1 - leave) };
  }
  return cues;
}

/** The moment of each action a reduced-motion figure holds instead of playing it. */
const KEY_FRAME: Readonly<Record<StaffRole, number>> = {
  butler: 1.4,
  valet: 1.6,
  sommelier: 1.6,
};

const mouth = new Vector3();
const bowl = new Vector3();
const toward = new Vector3();
const level = new Vector3(0, 1, 0);
/** Where the bottle aims, over the bowl, so the neck tips down onto the rim and not into it. */
const ABOVE_BOWL = new Vector3(0, 0.0095, -0.0035);

/**
 * Finishes a pose once it is on the bones: trays and glasses stay level, the valise hangs
 * plumb, the bottle tips toward the glass and the pour is stretched from its mouth to the bowl.
 */
export function settleProps(role: StaffRole, rig: Rig, clock: Clock, cues: Cues): void {
  const atWork = 1 - clamp01(clock.leave);
  const s = clock.action;
  switch (role) {
    case 'butler':
      rig.aim('propL', level, atWork);
      break;
    case 'valet':
      rig.aim('propR', level, atWork);
      break;
    case 'sommelier': {
      const swirl = clock.reduced ? 0 : env(s, 2.05, 2.25, 2.5, 2.7);
      const a = (s - 2.05) * Math.PI * 4;
      toward.set(Math.sin(a) * 0.16 * swirl, 1, Math.cos(a) * 0.16 * swirl);
      rig.aim('propL', toward, atWork);
      const tilt = clock.reduced ? 0 : env(s, 0.5, 0.95, 1.9, 2.35);
      if (tilt > 0) {
        rig.positionOf('fill', BOWL_TARGET, bowl);
        rig.positionOf('propR', [0, 0, 0], mouth);
        toward.subVectors(bowl.add(ABOVE_BOWL), mouth).normalize();
        toward.lerpVectors(level, toward, tilt);
      } else {
        toward.copy(level);
      }
      rig.aim('propR', toward, atWork);
      const stream = rig.bone('stream');
      if (cues.pour > 0) {
        rig.positionOf('propR', BOTTLE_MOUTH, mouth);
        rig.positionOf('fill', BOWL_TARGET, bowl);
        const fall = toward.subVectors(mouth, bowl);
        const length = fall.length();
        stream.position.copy(mouth);
        stream.quaternion.setFromUnitVectors(level, fall.normalize());
        stream.scale.set(cues.pour, length / STREAM_LENGTH, cues.pour);
      } else {
        stream.scale.setScalar(0);
      }
      stream.scale.max(SMALLEST);
      stream.updateMatrixWorld(true);
      break;
    }
  }
}

const SMALLEST = new Vector3(1e-4, 1e-4, 1e-4);
