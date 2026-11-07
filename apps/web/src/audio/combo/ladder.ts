import { elementAt } from '../rng.ts';
import { midiToHz, pentatonicMidi, type VenueKey } from '../music/theory.ts';

/** 0 = no combo, then Chic, Lavish, Opulent, Decadent, OBSCENE. */
export const COMBO_TIER_COUNT = 5;
/** The ladder climbs two octaves of pentatonic, then loops its top octave as a rising riff. */
export const LADDER_TOP_DEGREE = 10;
export const LADDER_LOOP_LENGTH = 5;
export const FLOURISH_NOTE_SPACING = 0.055;

export function assertComboTier(tier: number): void {
  if (!Number.isInteger(tier) || tier < 0 || tier > COMBO_TIER_COUNT) {
    throw new RangeError(`Combo tier must be an integer in 0..${COMBO_TIER_COUNT}, got ${tier}`);
  }
}

/** Step 1 is the first coin of a cascade. */
export function ladderDegree(step: number): number {
  if (!Number.isInteger(step) || step < 1) {
    throw new RangeError(`Combo step must be a positive integer, got ${step}`);
  }
  const index = step - 1;
  if (index <= LADDER_TOP_DEGREE) return index;
  const loopStart = LADDER_TOP_DEGREE - LADDER_LOOP_LENGTH + 1;
  return loopStart + ((index - LADDER_TOP_DEGREE - 1) % LADDER_LOOP_LENGTH);
}

export interface ComboTone {
  readonly frequency: number;
  readonly gain: number;
}

export interface ComboNote {
  readonly tones: readonly ComboTone[];
  /** 0..1: FM index scale, so higher tiers sparkle more. */
  readonly brightness: number;
  readonly t60: number;
}

/**
 * Each tier thickens the voicing: Lavish adds the octave below, Opulent a pentatonic harmony,
 * Decadent opens the brightness and sustain, OBSCENE adds the octave above.
 */
export function voiceComboDegree(degree: number, tier: number, key: VenueKey): ComboNote {
  assertComboTier(tier);
  const root = pentatonicMidi(key.ladderTonicMidi, degree);
  const tones: ComboTone[] = [{ frequency: midiToHz(root), gain: 1 }];
  if (tier >= 2) tones.push({ frequency: midiToHz(root - 12), gain: 0.4 });
  if (tier >= 3) {
    tones.push({
      frequency: midiToHz(pentatonicMidi(key.ladderTonicMidi, degree + 2)),
      gain: 0.32,
    });
  }
  if (tier >= 5) tones.push({ frequency: midiToHz(root + 12), gain: 0.22 });
  const total = tones.reduce((sum, tone) => sum + tone.gain, 0);
  return {
    tones: tones.map((tone) => ({ ...tone, gain: tone.gain / Math.sqrt(total) })),
    brightness: tier >= 4 ? 1 : 0.55 + 0.1 * tier,
    t60: tier >= 4 ? 1.6 : 1.1,
  };
}

export function comboStepNote(step: number, tier: number, key: VenueKey): ComboNote {
  return voiceComboDegree(ladderDegree(step), tier, key);
}

/** OBSCENE jumps to the upper tonic so its flourish lands on the top of the ladder. */
const FLOURISH_BASE: readonly number[] = [0, 1, 2, 3, 5];

/** Degrees of the rising arpeggio played when the cascade reaches a new tier. */
export function tierFlourishDegrees(tier: number): number[] {
  assertComboTier(tier);
  if (tier === 0) return [];
  const base = elementAt(FLOURISH_BASE, tier - 1);
  const degrees = [base, base + 2, base + 4];
  if (tier === COMBO_TIER_COUNT) degrees.push(base + 5);
  return degrees;
}
