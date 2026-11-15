import type { AchievementGrade } from '@coinposh/shared';
import { midiToHz, pentatonicMidi, type VenueKey } from '../music/theory.ts';
import { clamp, type Rng } from '../rng.ts';
import { VoicePriority } from '../voicePool.ts';
import { nyquistCeiling } from './fanfare.ts';
import {
  humanizeTime,
  humanizeVelocity,
  type DetuneVariator,
  type NoRepeatPicker,
} from './variation.ts';

export interface ChimePartialSpec {
  readonly ratio: number;
  readonly amplitude: number;
  /** Relative to the grade's ring time: upper partials die first, as on a struck bar. */
  readonly ring: number;
}

export interface ChimeProfile {
  readonly level: number;
  readonly t60: number;
  /** Seconds between motif steps. */
  readonly spacing: number;
  readonly partials: readonly ChimePartialSpec[];
  /** Each motif is a list of steps, each step one or more pentatonic degrees struck together. */
  readonly motifs: readonly (readonly (readonly number[])[])[];
}

/**
 * The badge metal is the timbre. Bronze is a warm, nearly harmonic bar; silver the glockenspiel's
 * bright 2.76 overtone; gold a fuller, longer bell with its octave; platinum a glassy celesta
 * that rings longest. Higher grades climb further up the venue key and end on a wider chord.
 */
export const CHIME_PROFILES: Readonly<Record<AchievementGrade, ChimeProfile>> = {
  bronze: {
    level: 0.2,
    t60: 0.8,
    spacing: 0.085,
    partials: [
      { ratio: 1, amplitude: 1, ring: 1 },
      { ratio: 2, amplitude: 0.25, ring: 0.7 },
      { ratio: 3, amplitude: 0.08, ring: 0.4 },
    ],
    motifs: [
      [[3], [5]],
      [[2], [5]],
      [[4], [5]],
    ],
  },
  silver: {
    level: 0.24,
    t60: 1.2,
    spacing: 0.075,
    partials: [
      { ratio: 1, amplitude: 1, ring: 1 },
      { ratio: 2.76, amplitude: 0.3, ring: 0.45 },
      { ratio: 5.4, amplitude: 0.1, ring: 0.22 },
    ],
    motifs: [
      [[2], [3], [5]],
      [[3], [2], [5]],
      [[0], [3], [5]],
    ],
  },
  gold: {
    level: 0.28,
    t60: 1.7,
    spacing: 0.07,
    partials: [
      { ratio: 1, amplitude: 1, ring: 1 },
      { ratio: 2, amplitude: 0.45, ring: 0.75 },
      { ratio: 3, amplitude: 0.18, ring: 0.45 },
      { ratio: 4.07, amplitude: 0.1, ring: 0.28 },
    ],
    motifs: [
      [[0], [2], [3], [5, 7]],
      [[3], [2], [3], [5, 7]],
      [[2], [3], [4], [5, 7]],
    ],
  },
  platinum: {
    level: 0.32,
    t60: 2.4,
    spacing: 0.065,
    partials: [
      { ratio: 1, amplitude: 1, ring: 1 },
      { ratio: 2, amplitude: 0.4, ring: 0.8 },
      { ratio: 2.76, amplitude: 0.2, ring: 0.55 },
      { ratio: 5.4, amplitude: 0.12, ring: 0.3 },
    ],
    motifs: [
      [[0], [2], [3], [5], [5, 7, 10]],
      [[2], [3], [5], [7], [5, 8, 10]],
      [[3], [5], [4], [7], [5, 7, 10]],
    ],
  },
};

export interface ChimePartial {
  readonly frequency: number;
  readonly amplitude: number;
  readonly t60: number;
}

export interface ChimeNote {
  readonly at: number;
  readonly midi: number;
  readonly velocity: number;
  /** Already detuned and filtered under Nyquist. */
  readonly partials: readonly ChimePartial[];
}

export interface AchievementChimeSpec {
  readonly grade: AchievementGrade;
  readonly gain: number;
  readonly pan: number;
  readonly notes: readonly ChimeNote[];
  readonly duration: number;
  readonly priority: number;
}

export const CHIME_PRIORITY = VoicePriority.ui + 10;
export const MAX_CHIME_PAN = 0.6;
const STRUM_SECONDS = 0.012;
const TIMING_JITTER = 0.003;
const VELOCITY_SPREAD = 0.06;

/**
 * An achievement unlock chime in the venue key: a short rising motif in the badge's metal that
 * lands on the octave. The motif never repeats twice in a row and the whole chime detunes by a
 * few cents each play, so a streak of unlocks never sounds like one sample looped.
 */
export function buildAchievementChime(
  grade: AchievementGrade,
  key: VenueKey,
  rng: Rng,
  motifs: NoRepeatPicker<AchievementGrade>,
  detune: DetuneVariator<AchievementGrade>,
  sampleRate: number,
  pan = 0,
): AchievementChimeSpec {
  const profile = CHIME_PROFILES[grade];
  const motif = motifs.pick(grade, profile.motifs);
  const factor = detune.next(grade);
  const ceiling = nyquistCeiling(sampleRate);
  const notes: ChimeNote[] = [];
  motif.forEach((step, i) => {
    const landing = i === motif.length - 1;
    step.forEach((degree, j) => {
      const midi = pentatonicMidi(key.ladderTonicMidi, degree);
      const fundamental = midiToHz(midi) * factor;
      const partials = profile.partials
        .map((p) => ({
          frequency: fundamental * p.ratio,
          amplitude: p.amplitude / Math.sqrt(step.length),
          t60: profile.t60 * p.ring * (landing ? 1 : 0.55),
        }))
        .filter((p) => p.frequency < ceiling);
      if (partials.length === 0) return;
      const base = 0.62 + (0.3 * i) / Math.max(1, motif.length - 1);
      notes.push({
        at: humanizeTime(rng, i * profile.spacing + j * STRUM_SECONDS, TIMING_JITTER),
        midi,
        velocity: humanizeVelocity(rng, landing ? 1 : base, VELOCITY_SPREAD),
        partials,
      });
    });
  });
  const duration = notes.reduce(
    (end, note) => Math.max(end, note.at + Math.max(...note.partials.map((p) => p.t60))),
    0,
  );
  return {
    grade,
    gain: profile.level,
    pan: clamp(pan, -MAX_CHIME_PAN, MAX_CHIME_PAN),
    notes,
    duration,
    priority: CHIME_PRIORITY,
  };
}

export function chimeVoiceCost(spec: AchievementChimeSpec): number {
  return spec.notes.reduce((sum, note) => sum + note.partials.length, 0);
}
