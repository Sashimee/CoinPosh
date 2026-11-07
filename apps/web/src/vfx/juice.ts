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
  /** When the call delivers fewer items than `items`, and why that is still enough. */
  readonly scope?: string;
  /** What survives `prefers-reduced-motion`. */
  readonly reduced: string;
}

/**
 * What each effect contributes to the checklist. The facade test (index.test.ts) fires
 * each effect and checks every listed item actually happens and that at least 4 do
 * without counting sound, so an interaction stays juicy even with audio muted.
 */
export const EFFECT_JUICE: Readonly<Record<VfxEffect, EffectJuice>> = {
  dropTrail: {
    items: ['particles', 'squashOvershoot', 'lightResponse', 'hapticOrShake'],
    reduced: 'Static tier-coloured motes along the path, no streaks or swirl, a lighter flash.',
  },
  contactSparks: {
    items: ['particles', 'lightResponse', 'hapticOrShake', 'squashOvershoot'],
    scope:
      'Strength above 0.45 only. Softer contacts are particles alone: the texture of the drop or push they belong to, which carries its own juice.',
    reduced:
      'A third of the sparks as slow glints, a flash that brightens without its scale pop, a haptic tick at most.',
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
    scope: 'The camera shiver starts at OPULENT; CHIC and LAVISH deliver the other four.',
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
