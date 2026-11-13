import { RARITIES, type Rarity } from '@coinposh/shared';
import type { ImpactEvent } from '../../audio/index.ts';
import type { FeedbackKind } from '../../app/state.ts';
import type { HapticPattern } from '../../vfx/haptics.ts';
import { backCount, type ItemStack } from './model.ts';

/** The juice checklist of 03-ART-AUDIO-JUICE, one entry per channel an interaction lights up. */
export type JuiceChannel =
  | 'sound'
  | 'haptic'
  | 'particles'
  | 'squash'
  | 'light'
  | 'numberPop'
  | 'timeManipulation'
  | 'camera';

export type InventoryCue = 'open' | 'flip' | 'levelUp';

export interface ChimeStep {
  readonly at: number;
  readonly impact: ImpactEvent;
}

export interface CuePlan {
  /** Played on the UI bus, which carries the press sound and haptic. */
  readonly feedback: FeedbackKind;
  /** A heavier pattern on top of the bus cue, for the moments that earn one. */
  readonly haptic: HapticPattern | null;
  readonly chime: readonly ChimeStep[];
  readonly sparks: number;
  /** Hit-stop before the pop, in ms. */
  readonly hold: number;
  readonly channels: readonly JuiceChannel[];
}

function weight(rarity: Rarity | null): number {
  return rarity === null ? 0 : RARITIES.indexOf(rarity);
}

/** A rising run of coin strikes under a brass hit; rarer charms ring longer. */
function levelChime(rarity: Rarity | null): readonly ChimeStep[] {
  const notes = 3 + Math.min(weight(rarity), 3);
  const steps: ChimeStep[] = [{ at: 0, impact: { material: 'metal', velocity: 1.4 } }];
  for (let i = 0; i < notes; i++) {
    steps.push({
      at: 90 + i * 70,
      impact: { material: 'coin', velocity: 0.5 + i * 0.28, pan: i % 2 === 0 ? -0.25 : 0.25 },
    });
  }
  return steps;
}

export type CueItem = Pick<ItemStack, 'kind' | 'rarity' | 'level' | 'copies'>;

/**
 * What each inventory moment plays for `item` (none for opening the panel). Reduced motion keeps
 * sound, haptics, light and the number pop (all fades, no travel) and drops particles, squash and
 * hit-stop, still clearing four. A flip pops a number only where the back has one to roll.
 */
export function cuePlan(cue: InventoryCue, item: CueItem | null, reduced: boolean): CuePlan {
  const rarity = item?.rarity ?? null;
  switch (cue) {
    case 'open':
      return {
        feedback: 'open',
        haptic: null,
        chime: [],
        sparks: 0,
        hold: 0,
        channels: reduced
          ? ['sound', 'haptic', 'light', 'numberPop']
          : ['sound', 'haptic', 'squash', 'light', 'numberPop'],
      };
    case 'flip': {
      const pop: readonly JuiceChannel[] = item && backCount(item).value > 0 ? ['numberPop'] : [];
      return {
        feedback: 'toggle',
        haptic: null,
        chime: [],
        sparks: 0,
        hold: 0,
        channels: reduced
          ? ['sound', 'haptic', 'light', ...pop]
          : ['sound', 'haptic', 'squash', 'light', ...pop],
      };
    }
    case 'levelUp':
      return {
        feedback: 'confirm',
        haptic: 'fanfare',
        chime: levelChime(rarity),
        sparks: reduced ? 0 : 14 + weight(rarity) * 4,
        hold: reduced ? 0 : 110,
        channels: reduced
          ? ['sound', 'haptic', 'light', 'numberPop']
          : ['sound', 'haptic', 'particles', 'squash', 'light', 'numberPop', 'timeManipulation'],
      };
  }
}
