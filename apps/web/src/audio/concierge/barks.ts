import type { ConciergeExpression } from '../../game/concierge/lines.ts';
import { signedSpread, type PitchVariator } from '../collecting/variation.ts';
import type { Rng } from '../rng.ts';
import { VoicePriority } from '../voicePool.ts';

export type Vowel = 'm' | 'a' | 'o' | 'u' | 'e';

export interface Formant {
  readonly frequency: number;
  readonly q: number;
  readonly gain: number;
}

/**
 * Two formants per vowel are enough for the ear to hear a mouth shape without ever hearing a
 * word. The hummed 'm' keeps a closed, nasal pair and lets the body lowpass carry it.
 */
export const VOWELS: Readonly<Record<Vowel, readonly [Formant, Formant]>> = {
  m: [
    { frequency: 260, q: 5, gain: 0.55 },
    { frequency: 1050, q: 9, gain: 0.12 },
  ],
  a: [
    { frequency: 720, q: 6, gain: 1 },
    { frequency: 1200, q: 8, gain: 0.55 },
  ],
  o: [
    { frequency: 480, q: 6, gain: 1 },
    { frequency: 860, q: 8, gain: 0.45 },
  ],
  u: [
    { frequency: 330, q: 6, gain: 0.85 },
    { frequency: 780, q: 9, gain: 0.25 },
  ],
  e: [
    { frequency: 460, q: 6, gain: 0.9 },
    { frequency: 1850, q: 10, gain: 0.4 },
  ],
};

export interface SyllableRecipe {
  readonly delay: number;
  readonly duration: number;
  readonly attack: number;
  /** The closing fade, so a murmur trails off instead of stopping like a beep. */
  readonly release: number;
  /** Pitch contour relative to the expression's base: start, peak, end. */
  readonly contour: readonly [number, number, number];
  /** Where the peak sits, as a fraction of the syllable. */
  readonly peakAt: number;
  readonly from: Vowel;
  readonly to: Vowel;
  readonly level: number;
  readonly vibratoHz: number;
  /** Peak frequency deviation as a fraction of the syllable's peak pitch. */
  readonly vibratoDepth: number;
}

export interface BreathRecipe {
  readonly delay: number;
  readonly duration: number;
  readonly level: number;
  readonly fromHz: number;
  readonly toHz: number;
  readonly q: number;
}

export interface BarkProfile {
  readonly base: number;
  readonly level: number;
  /** Per-play spread of every delay and duration, so two barks never share a rhythm. */
  readonly timeSpread: number;
  readonly breath: BreathRecipe | null;
  readonly syllables: readonly SyllableRecipe[];
}

const STEADY = { vibratoHz: 0, vibratoDepth: 0 } as const;

/**
 * 03-ART: "short wordless voice barks (pitched murmurs)". Each face has its own melody: pleased
 * is a warm "mm-HM!" climbing a major third; wry is a low, falling "hmm" with a knowing lift at
 * the end; scandalised is a sharp intake of breath and a high "OH!" that swoops up a fifth and
 * collapses, trembling.
 */
export const BARK_PROFILES: Readonly<Record<ConciergeExpression, BarkProfile>> = {
  pleased: {
    base: 150,
    level: 0.34,
    timeSpread: 0.06,
    breath: null,
    syllables: [
      {
        ...STEADY,
        delay: 0,
        duration: 0.13,
        attack: 0.02,
        release: 0.04,
        contour: [1, 1.08, 1.12],
        peakAt: 0.7,
        from: 'm',
        to: 'm',
        level: 0.7,
      },
      {
        delay: 0.16,
        duration: 0.24,
        attack: 0.025,
        release: 0.11,
        contour: [1.26, 1.335, 1.12],
        peakAt: 0.3,
        from: 'm',
        to: 'a',
        level: 1,
        vibratoHz: 5.5,
        vibratoDepth: 0.008,
      },
    ],
  },
  wry: {
    base: 122,
    level: 0.32,
    timeSpread: 0.08,
    breath: null,
    syllables: [
      {
        ...STEADY,
        delay: 0,
        duration: 0.3,
        attack: 0.04,
        release: 0.12,
        contour: [1.06, 1, 0.89],
        peakAt: 0.15,
        from: 'm',
        to: 'u',
        level: 0.85,
      },
      {
        ...STEADY,
        delay: 0.4,
        duration: 0.15,
        attack: 0.015,
        release: 0.07,
        contour: [0.94, 1.06, 1.12],
        peakAt: 0.75,
        from: 'm',
        to: 'e',
        level: 0.75,
      },
    ],
  },
  scandalised: {
    base: 205,
    level: 0.36,
    timeSpread: 0.05,
    breath: { delay: 0, duration: 0.1, level: 0.5, fromHz: 1400, toHz: 2600, q: 1.4 },
    syllables: [
      {
        delay: 0.09,
        duration: 0.2,
        attack: 0.012,
        release: 0.06,
        contour: [1, 1.5, 1.3],
        peakAt: 0.35,
        from: 'o',
        to: 'a',
        level: 1,
        vibratoHz: 7,
        vibratoDepth: 0.025,
      },
      {
        delay: 0.31,
        duration: 0.24,
        attack: 0.02,
        release: 0.15,
        contour: [1.4, 1.33, 0.95],
        peakAt: 0.1,
        from: 'o',
        to: 'u',
        level: 0.7,
        vibratoHz: 6,
        vibratoDepth: 0.03,
      },
    ],
  },
};

export interface BarkSyllable {
  readonly start: number;
  readonly duration: number;
  readonly attack: number;
  readonly release: number;
  readonly startHz: number;
  readonly peakHz: number;
  readonly endHz: number;
  readonly peakTime: number;
  readonly formantsFrom: readonly Formant[];
  readonly formantsTo: readonly Formant[];
  readonly level: number;
  readonly vibratoHz: number;
  readonly vibratoDepth: number;
}

export interface BarkBreath {
  readonly start: number;
  readonly duration: number;
  readonly level: number;
  readonly fromHz: number;
  readonly toHz: number;
  readonly q: number;
  /** Where in the shared noise buffer to read, 0..1, so no two gasps hiss alike. */
  readonly noiseOffset: number;
}

export interface BarkSpec {
  readonly expression: ConciergeExpression;
  readonly pitch: number;
  readonly gain: number;
  readonly syllables: readonly BarkSyllable[];
  readonly breath: BarkBreath | null;
  readonly duration: number;
  readonly priority: number;
}

/** Formants stay well under Nyquist so a low-rate context never aliases or clamps them. */
const NYQUIST_MARGIN = 0.8;

function placeFormants(vowel: Vowel, ceiling: number): Formant[] {
  return VOWELS[vowel].map((f) => ({ ...f, frequency: Math.min(f.frequency, ceiling) }));
}

/** One glottal oscillator per syllable, plus its vibrato LFO, plus the breath's noise source. */
export function barkVoiceCost(spec: BarkSpec): number {
  const syllables = spec.syllables.reduce((sum, s) => sum + (s.vibratoDepth > 0 ? 2 : 1), 0);
  return syllables + (spec.breath ? 1 : 0);
}

export function buildBarkSpec(
  expression: ConciergeExpression,
  variator: PitchVariator<ConciergeExpression>,
  rng: Rng,
  sampleRate: number,
): BarkSpec {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`Concierge bark needs a positive sample rate, got ${sampleRate}`);
  }
  const profile = BARK_PROFILES[expression];
  const pitch = variator.next(expression);
  const pace = signedSpread(rng, profile.timeSpread);
  const ceiling = (sampleRate / 2) * NYQUIST_MARGIN;
  const base = profile.base * pitch;

  const syllables = profile.syllables.map((s): BarkSyllable => {
    const duration = s.duration * pace * signedSpread(rng, profile.timeSpread / 2);
    const [from, peak, to] = s.contour;
    return {
      start: s.delay * pace,
      duration,
      attack: Math.min(s.attack, duration / 2),
      release: Math.min(s.release, duration / 2),
      startHz: base * from,
      peakHz: base * peak,
      endHz: base * to,
      peakTime: s.peakAt * duration,
      formantsFrom: placeFormants(s.from, ceiling),
      formantsTo: placeFormants(s.to, ceiling),
      level: s.level,
      vibratoHz: s.vibratoHz,
      vibratoDepth: s.vibratoDepth,
    };
  });

  const recipe = profile.breath;
  const breath: BarkBreath | null = recipe
    ? {
        start: recipe.delay * pace,
        duration: recipe.duration * pace,
        level: recipe.level,
        fromHz: Math.min(recipe.fromHz, ceiling),
        toHz: Math.min(recipe.toHz, ceiling),
        q: recipe.q,
        noiseOffset: rng(),
      }
    : null;

  const ends = syllables.map((s) => s.start + s.duration);
  if (breath) ends.push(breath.start + breath.duration);
  return {
    expression,
    pitch,
    gain: profile.level,
    syllables,
    breath,
    duration: Math.max(...ends),
    priority: VoicePriority.ui,
  };
}
