import type { FeedbackKind } from '../../app/state.ts';
import type { HapticPattern } from '../../vfx/haptics.ts';
import type { ChimeStep, JuiceChannel } from '../inventory/juice.ts';

export type AlbumCue = 'open' | 'lore' | 'fanfare';

export interface AlbumCuePlan {
  /** Played on the UI bus, which carries the press sound and haptic. */
  readonly feedback: FeedbackKind;
  /** A heavier pattern on top of the bus cue, for the moments that earn one. */
  readonly haptic: HapticPattern | null;
  readonly chime: readonly ChimeStep[];
  readonly sparks: number;
  /** Hit-stop before the stamp lands, in ms. */
  readonly hold: number;
  /** `sweep` runs the gold foil across the page; `glow` fades it in place. */
  readonly foil: 'sweep' | 'glow' | null;
  readonly channels: readonly JuiceChannel[];
}

/** Two soft strikes as a page of the album turns to a story. */
const LORE_CHIME: readonly ChimeStep[] = [
  { at: 0, impact: { material: 'coin', velocity: 0.45, pan: -0.15 } },
  { at: 120, impact: { material: 'coin', velocity: 0.7, pan: 0.15 } },
];

/**
 * The completion fanfare: the stamp's brass hit, a rising run of coin strikes that grows with
 * the bonus, then a ringing brass close once the last coin settles.
 */
function fanfareChime(bonus: number): readonly ChimeStep[] {
  const notes = 5 + Math.min(3, Math.floor(Math.round(bonus * 100) / 5));
  const steps: ChimeStep[] = [{ at: 0, impact: { material: 'metal', velocity: 1.6 } }];
  for (let i = 0; i < notes; i++) {
    steps.push({
      at: 120 + i * 72,
      impact: { material: 'coin', velocity: 0.5 + i * 0.24, pan: i % 2 === 0 ? -0.3 : 0.3 },
    });
  }
  steps.push({ at: 120 + notes * 72 + 90, impact: { material: 'metal', velocity: 2.2 } });
  return steps;
}

/**
 * What each album moment plays. Reduced motion keeps sound, haptics, light (the foil glows
 * in place instead of sweeping) and the number pop, and drops particles, squash and hit-stop,
 * still clearing the four-channel bar of 03-ART-AUDIO-JUICE. `bonus` is the completed set's
 * coin value bonus (0.05 = +5 %); a richer set rings longer and throws more sparks.
 */
export function albumCuePlan(cue: AlbumCue, reduced: boolean, bonus = 0): AlbumCuePlan {
  const calm: readonly JuiceChannel[] = ['sound', 'haptic', 'light', 'numberPop'];
  switch (cue) {
    case 'open':
      return {
        feedback: 'open',
        haptic: null,
        chime: [],
        sparks: 0,
        hold: 0,
        foil: null,
        channels: reduced ? calm : ['sound', 'haptic', 'squash', 'light', 'numberPop'],
      };
    case 'lore':
      return {
        feedback: 'open',
        haptic: null,
        chime: LORE_CHIME,
        sparks: 0,
        hold: 0,
        foil: reduced ? 'glow' : 'sweep',
        channels: reduced ? calm : ['sound', 'haptic', 'squash', 'light', 'numberPop'],
      };
    case 'fanfare':
      return {
        feedback: 'confirm',
        haptic: 'fanfare',
        chime: fanfareChime(bonus),
        sparks: reduced ? 0 : 18 + Math.min(14, Math.round(bonus * 100)),
        hold: reduced ? 0 : 140,
        foil: reduced ? 'glow' : 'sweep',
        channels: reduced
          ? calm
          : ['sound', 'haptic', 'particles', 'squash', 'light', 'numberPop', 'timeManipulation'],
      };
  }
}
