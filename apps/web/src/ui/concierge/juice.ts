import type { ConciergeExpression, ConciergeLineKind } from '../../game/concierge/index.ts';
import type { HapticPattern } from '../../vfx/haptics.ts';
import type { JuiceChannel } from '../inventory/juice.ts';

/** What the portrait and the card do as a line appears. */
export interface ConciergeCuePlan {
  /** The voice bark for the face (T-14.04); a locked or muted voice stays quiet. */
  readonly bark: ConciergeExpression;
  readonly haptic: HapticPattern;
  /** `sweep` runs the gold sheen across the card; `glow` warms it in place. */
  readonly light: 'sweep' | 'glow';
  /** Glints around the medallion; under reduced motion they twinkle in place instead of flying. */
  readonly glints: number;
  readonly glintMotion: 'burst' | 'twinkle';
  /** The card springs out of the medallion with an overshoot, and the portrait hops. */
  readonly squash: boolean;
  /** Words fade in one after another, or the whole line at once. */
  readonly reveal: 'words' | 'whole';
  readonly channels: readonly JuiceChannel[];
}

const HAPTIC: Readonly<Record<ConciergeExpression, HapticPattern>> = {
  pleased: 'tap',
  wry: 'tick',
  scandalised: 'thud',
};

const GLINTS: Readonly<Record<ConciergeExpression, number>> = {
  pleased: 7,
  wry: 3,
  scandalised: 10,
};

/**
 * Every line arrives with a bark, a haptic, light on the card and glints on the medallion, so
 * even the calm variant clears the four-channel bar of 03-ART-AUDIO-JUICE. Reduced motion drops
 * the spring, the flying glints and the word cascade, and keeps the rest still.
 */
export function conciergeCuePlan(
  expression: ConciergeExpression,
  kind: ConciergeLineKind,
  reduced: boolean,
): ConciergeCuePlan {
  const glints = GLINTS[expression] + (kind === 'tip' ? 2 : 0);
  if (reduced) {
    return {
      bark: expression,
      haptic: HAPTIC[expression],
      light: 'glow',
      glints: Math.ceil(glints / 2),
      glintMotion: 'twinkle',
      squash: false,
      reveal: 'whole',
      channels: ['sound', 'haptic', 'light', 'particles'],
    };
  }
  return {
    bark: expression,
    haptic: HAPTIC[expression],
    light: 'sweep',
    glints,
    glintMotion: 'burst',
    squash: true,
    reveal: 'words',
    channels: ['sound', 'haptic', 'particles', 'squash', 'light'],
  };
}
