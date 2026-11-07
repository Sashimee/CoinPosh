/** The numbered checklist in 03-ART-AUDIO-JUICE.md. Sound (1) is the audio engine's half. */
export const JUICE_ITEMS = {
  sound: 1,
  hapticOrShake: 2,
  particles: 3,
  squashOvershoot: 4,
  lightResponse: 5,
  numberPop: 6,
  timeManipulation: 7,
  camera: 8,
} as const;

export type JuiceItem = keyof typeof JUICE_ITEMS;

export type VfxEffect =
  'dropTrail' | 'contactSparks' | 'fusion' | 'cascade' | 'obscene' | 'numberPop';

export interface EffectJuice {
  /** Items this module delivers on its own, before T-1.10 adds the sound. */
  readonly items: readonly JuiceItem[];
  /** What survives `prefers-reduced-motion`. */
  readonly reduced: string;
}

/**
 * What each effect contributes to the checklist. A unit test holds every row to ≥ 4
 * items without counting sound, so an interaction stays juicy even with audio muted.
 */
export const EFFECT_JUICE: Readonly<Record<VfxEffect, EffectJuice>> = {
  dropTrail: {
    items: ['particles', 'squashOvershoot', 'lightResponse', 'hapticOrShake'],
    reduced: 'Static tier-coloured motes along the path, no streaks or swirl, a lighter flash.',
  },
  contactSparks: {
    items: ['particles', 'lightResponse', 'hapticOrShake', 'squashOvershoot'],
    reduced: 'A third of the sparks as slow glints, no flash pop, haptic tick only.',
  },
  fusion: {
    items: [
      'particles',
      'lightResponse',
      'squashOvershoot',
      'timeManipulation',
      'camera',
      'hapticOrShake',
    ],
    reduced:
      'Particles drift in instead of spiralling, the ring blooms in place, no shake or FOV kick; the hit-stop stays.',
  },
  cascade: {
    items: ['particles', 'lightResponse', 'squashOvershoot', 'hapticOrShake', 'camera'],
    reduced: 'Fewer, slower fizz motes and a softer bloom; no camera shake.',
  },
  obscene: {
    items: [
      'particles',
      'lightResponse',
      'timeManipulation',
      'camera',
      'hapticOrShake',
      'squashOvershoot',
    ],
    reduced: 'A light drift of confetti with no cannons, no slow-mo or shake, a long soft glow.',
  },
  numberPop: {
    items: ['numberPop', 'squashOvershoot', 'lightResponse', 'particles'],
    reduced: 'The value fades in and out where it was earned; no arc, burst or prism animation.',
  },
};
