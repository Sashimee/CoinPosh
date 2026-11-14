import type { FeedbackKind } from '../../app/state.ts';
import type { HapticPattern } from '../../vfx/haptics.ts';
import type { ChimeStep, JuiceChannel } from '../inventory/juice.ts';

export type FairCue = 'open' | 'tab' | 'source' | 'step' | 'rotate' | 'match' | 'mismatch';

export interface FairCuePlan {
  /** Played on the UI bus, which carries the press sound and haptic. */
  readonly feedback: FeedbackKind;
  /** A heavier pattern on top of the bus cue, for the moments that earn one. */
  readonly haptic: HapticPattern | null;
  readonly chime: readonly ChimeStep[];
  readonly sparks: number;
  /** Hit-stop before the stamp lands, in ms. */
  readonly hold: number;
  readonly channels: readonly JuiceChannel[];
}

/** A rising run of coin strikes over a brass hit: the seal of a check that came out clean. */
const MATCH_CHIME: readonly ChimeStep[] = [
  { at: 0, impact: { material: 'metal', velocity: 1.5 } },
  ...[0, 1, 2, 3, 4].map((i) => ({
    at: 110 + i * 65,
    impact: { material: 'coin' as const, velocity: 0.55 + i * 0.3, pan: i % 2 === 0 ? -0.3 : 0.3 },
  })),
];

/** Two dull knocks on the lacquer, the second softer. */
const MISMATCH_CHIME: readonly ChimeStep[] = [
  { at: 0, impact: { material: 'wood', velocity: 1.2 } },
  { at: 120, impact: { material: 'wood', velocity: 0.7 } },
];

const ROTATE_CHIME: readonly ChimeStep[] = [
  { at: 0, impact: { material: 'metal', velocity: 0.9, pan: -0.2 } },
  { at: 140, impact: { material: 'coin', velocity: 1.1, pan: 0.2 } },
];

/**
 * What each Certified Fair moment plays. Reduced motion keeps sound, haptics, light and the
 * number pop (fades and rolling digits that do not travel) and drops particles, squash and
 * hit-stop, still clearing the four-channel bar of 03-ART-AUDIO-JUICE.
 */
export function fairCuePlan(cue: FairCue, reduced: boolean): FairCuePlan {
  const calm: readonly JuiceChannel[] = ['sound', 'haptic', 'light', 'numberPop'];
  const base = { haptic: null, chime: [], sparks: 0, hold: 0 } as const;
  switch (cue) {
    case 'open':
      return {
        ...base,
        feedback: 'open',
        channels: reduced ? calm : ['sound', 'haptic', 'squash', 'light', 'numberPop'],
      };
    case 'tab':
      return {
        ...base,
        feedback: 'toggle',
        channels: reduced ? calm : ['sound', 'haptic', 'squash', 'light', 'numberPop'],
      };
    case 'source':
    case 'step':
      return {
        ...base,
        feedback: 'tick',
        channels: reduced ? calm : ['sound', 'haptic', 'squash', 'light', 'numberPop'],
      };
    case 'rotate':
      return {
        ...base,
        feedback: 'open',
        haptic: 'thud',
        chime: ROTATE_CHIME,
        sparks: reduced ? 0 : 10,
        channels: reduced ? calm : ['sound', 'haptic', 'particles', 'squash', 'light', 'numberPop'],
      };
    case 'match':
      return {
        feedback: 'confirm',
        haptic: 'fanfare',
        chime: MATCH_CHIME,
        sparks: reduced ? 0 : 22,
        hold: reduced ? 0 : 120,
        channels: reduced
          ? calm
          : ['sound', 'haptic', 'particles', 'squash', 'light', 'numberPop', 'timeManipulation'],
      };
    case 'mismatch':
      return {
        feedback: 'deny',
        haptic: 'thud',
        chime: MISMATCH_CHIME,
        sparks: 0,
        hold: reduced ? 0 : 90,
        channels: reduced
          ? calm
          : ['sound', 'haptic', 'squash', 'light', 'numberPop', 'timeManipulation'],
      };
  }
}
