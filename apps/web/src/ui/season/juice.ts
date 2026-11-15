import type { FeedbackKind } from '../../app/state.ts';
import type { AudioEngine } from '../../audio/index.ts';
import type { HapticPattern } from '../../vfx/haptics.ts';
import { feedback, type UiContext } from '../context.ts';
import type { ChimeStep, JuiceChannel } from '../inventory/juice.ts';

export type SeasonCue = 'open' | 'tab' | 'claim' | 'already' | 'failed';

export interface SeasonCuePlan {
  /** Played on the UI bus, which carries the press sound and haptic. */
  readonly feedback: FeedbackKind;
  /** A heavier pattern on top of the bus cue, for the moments that earn one. */
  readonly haptic: HapticPattern | null;
  readonly chime: readonly ChimeStep[];
  readonly sparks: number;
  /** Hit-stop before the stamp lands, in ms. */
  readonly hold: number;
  /** `sweep` runs the gold sheen across the card; `glow` fades it in place. */
  readonly light: 'sweep' | 'glow' | null;
  /** Reward amounts float up off the card, or the panel's figure pops in place. */
  readonly pop: 'float' | 'pulse' | null;
  readonly channels: readonly JuiceChannel[];
}

/** Hit-stop before the claim stamp lands: the 40–80 ms band of 03-ART-AUDIO-JUICE item 7. */
export const CLAIM_HOLD_MS = 80;

/** The claim: a brass stamp, then a rising run of coin strikes, then a bright brass close. */
const CLAIM_CHIME: readonly ChimeStep[] = [
  { at: 0, impact: { material: 'metal', velocity: 1.4 } },
  { at: 110, impact: { material: 'coin', velocity: 0.6, pan: -0.3 } },
  { at: 180, impact: { material: 'coin', velocity: 0.85, pan: 0.3 } },
  { at: 250, impact: { material: 'coin', velocity: 1.1, pan: -0.2 } },
  { at: 320, impact: { material: 'coin', velocity: 1.35, pan: 0.2 } },
  { at: 430, impact: { material: 'metal', velocity: 2 } },
];

/** One soft strike: the stamp was already there. */
const ALREADY_CHIME: readonly ChimeStep[] = [
  { at: 0, impact: { material: 'metal', velocity: 0.7 } },
];

/**
 * What each season moment plays. Reduced motion keeps sound, haptics, light (the sheen glows
 * in place instead of sweeping) and the number pop, and drops particles, squash and hit-stop,
 * still clearing the four-channel bar of 03-ART-AUDIO-JUICE. A tab's only sound is its press
 * cue on the bus, so one press is one cue.
 */
export function seasonCuePlan(cue: SeasonCue, reduced: boolean): SeasonCuePlan {
  const calm: readonly JuiceChannel[] = ['sound', 'haptic', 'light', 'numberPop'];
  switch (cue) {
    case 'open':
      return {
        feedback: 'open',
        haptic: null,
        chime: [],
        sparks: 0,
        hold: 0,
        light: reduced ? 'glow' : 'sweep',
        pop: 'pulse',
        channels: reduced ? calm : ['sound', 'haptic', 'squash', 'light', 'numberPop'],
      };
    case 'tab':
      return {
        feedback: 'toggle',
        haptic: null,
        chime: [],
        sparks: 0,
        hold: 0,
        light: 'glow',
        pop: 'pulse',
        channels: reduced ? calm : ['sound', 'haptic', 'squash', 'light', 'numberPop'],
      };
    case 'claim':
      return {
        feedback: 'confirm',
        haptic: 'fanfare',
        chime: CLAIM_CHIME,
        sparks: reduced ? 0 : 16,
        hold: reduced ? 0 : CLAIM_HOLD_MS,
        light: reduced ? 'glow' : 'sweep',
        pop: reduced ? 'pulse' : 'float',
        channels: reduced
          ? calm
          : ['sound', 'haptic', 'particles', 'squash', 'light', 'numberPop', 'timeManipulation'],
      };
    case 'already':
      return {
        feedback: 'tick',
        haptic: 'tap',
        chime: ALREADY_CHIME,
        sparks: 0,
        hold: 0,
        light: 'glow',
        pop: 'pulse',
        channels: reduced ? calm : ['sound', 'haptic', 'squash', 'light', 'numberPop'],
      };
    case 'failed':
      return {
        feedback: 'deny',
        haptic: 'thud',
        chime: [],
        sparks: 0,
        hold: 0,
        light: 'glow',
        pop: 'pulse',
        channels: reduced ? calm : ['sound', 'haptic', 'squash', 'light', 'numberPop'],
      };
  }
}

export interface SeasonCuePorts {
  readonly haptics?: { pulse(pattern: HapticPattern): boolean } | null;
  readonly audio?: Pick<AudioEngine, 'playImpact'> | null;
  /** Schedules each chime strike; the panel passes one that is cancelled on close. */
  readonly later: (ms: number, run: () => void) => void;
}

/**
 * Plays a plan's sound and haptics. `withBus` is false when a pressable already sent the bus
 * cue on touch-down, so the press sound and haptic never play twice for one press.
 */
export function playSeasonCue(
  ctx: UiContext,
  plan: SeasonCuePlan,
  withBus: boolean,
  ports: SeasonCuePorts,
): void {
  if (withBus) feedback(ctx, plan.feedback);
  if (plan.haptic) ports.haptics?.pulse(plan.haptic);
  const audio = ports.audio ?? null;
  if (!audio) return;
  for (const step of plan.chime) {
    ports.later(step.at, () => {
      audio.playImpact(step.impact);
    });
  }
}

export interface SeasonFailureTargets<T> {
  /** The quest card: the deny glow, and the shake when motion is allowed. */
  readonly card: T;
  /** The "Try again" button, which pops in place. */
  readonly action: T;
  /** The inline error note under the card, which flashes. */
  readonly note: T | null;
}

/** Paints a failed claim's light, pop and squash, exactly the channels its plan declares. */
export function paintSeasonFailure<T>(
  targets: SeasonFailureTargets<T>,
  plan: SeasonCuePlan,
  restart: (el: T, className: string) => void,
): void {
  if (plan.light) {
    restart(targets.card, 'is-deny-glowing');
    if (targets.note) restart(targets.note, 'is-flashing');
  }
  if (plan.pop) restart(targets.action, 'is-popping');
  if (plan.channels.includes('squash')) restart(targets.card, 'is-denied');
}
