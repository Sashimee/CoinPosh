import { rankKey, type Rank, type RankTitle } from '@coinposh/shared';
import type { DuckOptions } from '../mixer.ts';
import { midiToHz, pentatonicMidi, type VenueKey } from '../music/theory.ts';
import { elementAt, type Rng } from '../rng.ts';
import { VoicePriority } from '../voicePool.ts';
import { humanizeTime, humanizeVelocity, type NoRepeatPicker } from './variation.ts';

export type FanfareInstrument = 'brass' | 'bass' | 'bell' | 'timpani';

export interface FanfareNote {
  readonly instrument: FanfareInstrument;
  /** Seconds after the fanfare starts. */
  readonly at: number;
  readonly duration: number;
  readonly midi: number;
  readonly velocity: number;
  readonly pan: number;
  /** Where a drum's skin noise reads from the shared buffer, 0..1, so no two hits share a sample. */
  readonly noiseOffset: number;
}

export interface RankUpFanfareSpec {
  readonly rank: string;
  readonly title: RankTitle;
  readonly notes: readonly FanfareNote[];
  /** When the call lands on the held octave: the crest's stamp should hit here. */
  readonly landingAt: number;
  readonly duration: number;
  readonly gain: number;
  /** 0..1: how far the brass filter opens, so higher grades blaze brighter. */
  readonly brightness: number;
  readonly duck: Required<DuckOptions>;
  readonly priority: number;
}

/** Above every coin and combo voice: a rank-up is the loudest moment of a session. */
export const FANFARE_PRIORITY = VoicePriority.combo + 20;
export const SIXTEENTH_SECONDS = 0.1;
/** Matches the jackpot sting's duck, so every reveal stinger steps the band back the same way. */
export const FANFARE_DUCK_DB = -14;
export const FANFARE_DUCK_ATTACK = 0.04;
export const FANFARE_DUCK_RELEASE = 1.6;
const RING_SECONDS = 0.7;
const TIMING_JITTER = 0.004;
const VELOCITY_SPREAD = 0.05;
const BELL_SPACING = 0.06;

/** Commoner calls alone; each title above adds a section: harmony and bass, a run and drums, the full court. */
const TITLE_LEVEL: Readonly<Record<RankTitle, number>> = {
  commoner: 0,
  baron: 1,
  duke: 2,
  monarch: 3,
};
const LANDING_HOLD_SIXTEENTHS = [6, 7, 9, 12] as const;
const TITLE_GAIN = [0.34, 0.38, 0.42, 0.46] as const;

/**
 * The heraldic call, in pentatonic degrees of the venue key an octave under the combo ladder:
 * a repeated tonic pickup, the fifth, and the octave it lands on. Every note of every section
 * sits in the key's major pentatonic, so the fanfare never clashes with the band it ducks.
 */
const CALL: readonly {
  readonly step: number;
  readonly degree: number;
  readonly length: number;
  readonly velocity: number;
}[] = [
  { step: 0, degree: 0, length: 0.75, velocity: 0.78 },
  { step: 1, degree: 0, length: 0.75, velocity: 0.74 },
  { step: 2, degree: 3, length: 1.75, velocity: 0.86 },
];
const LANDING_STEP = 4;
const RUN_DEGREES = [-5, -4, -3, -2, -1] as const;
const RUN_SIXTEENTHS = 2.5;

/** Glitter over the landing chord, in degrees of the combo ladder's octave. */
export const SPARKLE_FIGURES: readonly (readonly number[])[] = [
  [5, 7, 8, 9, 10, 9, 10, 8],
  [3, 5, 7, 9, 10, 8, 9, 7],
  [5, 8, 7, 10, 9, 8, 10, 9],
  [7, 5, 9, 8, 10, 7, 9, 10],
];
const MAX_MONARCH_STAR_SPARKLES = 3;

export function sparkleCount(rank: Rank): number {
  if (rank.title === 'monarch') return 5 + Math.min(MAX_MONARCH_STAR_SPARKLES, rank.stars);
  return rank.grade;
}

export function rankBrightness(rank: Rank): number {
  return rank.title === 'monarch' ? 1 : 0.7 + 0.075 * (rank.grade - 1);
}

interface Draft {
  readonly instrument: FanfareInstrument;
  readonly at: number;
  readonly duration: number;
  readonly midi: number;
  readonly velocity: number;
  readonly pan?: number;
}

/**
 * The rank-up fanfare for the rank just reached, in the venue's key. It starts on the first
 * sample (zero-latency), lands within 0.65 s, and comes with the duck the mixer should apply.
 */
export function buildRankUpFanfare(
  rank: Rank,
  key: VenueKey,
  rng: Rng,
  figures: NoRepeatPicker<'sparkle'>,
): RankUpFanfareSpec {
  const level = TITLE_LEVEL[rank.title];
  const lead = key.ladderTonicMidi - 12;
  const bassTonic = key.ladderTonicMidi - 36;
  const lift = level >= 2 ? RUN_SIXTEENTHS : 0;
  const hold = elementAt(LANDING_HOLD_SIXTEENTHS, level);
  const s = (sixteenths: number) => sixteenths * SIXTEENTH_SECONDS;
  const landingAt = s(lift + LANDING_STEP);
  const holdSeconds = s(hold);
  const drafts: Draft[] = [];
  const brass = (step: number, degree: number, length: number, velocity: number) => {
    drafts.push({
      instrument: 'brass',
      at: s(step),
      duration: s(length),
      midi: pentatonicMidi(lead, degree),
      velocity,
    });
  };

  if (level >= 2) {
    RUN_DEGREES.forEach((degree, i) => {
      brass(i * 0.5, degree, 0.5, 0.45 + (0.25 * i) / (RUN_DEGREES.length - 1));
    });
  }
  for (const note of CALL) {
    brass(lift + note.step, note.degree, note.length, note.velocity);
    if (level >= 3) brass(lift + note.step, note.degree + 5, note.length, note.velocity * 0.55);
  }
  brass(lift + LANDING_STEP, 5, hold, 1);
  if (level >= 3) brass(lift + LANDING_STEP, 10, hold, 0.55);
  if (level >= 1) {
    brass(lift + LANDING_STEP, 3, hold, 0.6);
    brass(lift + LANDING_STEP, 7, hold, 0.55);
    drafts.push({
      instrument: 'bass',
      at: landingAt,
      duration: holdSeconds,
      midi: bassTonic,
      velocity: 0.9,
    });
  }
  if (level >= 2) {
    brass(lift + LANDING_STEP, 0, hold, 0.6);
    drafts.push({
      instrument: 'bass',
      at: s(lift),
      duration: s(2),
      midi: bassTonic,
      velocity: 0.7,
    });
    drafts.push({
      instrument: 'timpani',
      at: s(lift),
      duration: 1,
      midi: bassTonic,
      velocity: 0.7,
    });
    drafts.push({
      instrument: 'timpani',
      at: s(lift + 2),
      duration: 1,
      midi: pentatonicMidi(bassTonic, -2),
      velocity: 0.62,
    });
    drafts.push({
      instrument: 'timpani',
      at: landingAt,
      duration: 1.4,
      midi: bassTonic,
      velocity: 1,
    });
  }
  if (level >= 3) {
    for (let i = 0; i < 5; i++) {
      drafts.push({
        instrument: 'timpani',
        at: landingAt - s(1.25 - i * 0.25),
        duration: 0.4,
        midi: bassTonic,
        velocity: 0.3 + 0.1 * i,
      });
    }
  }

  const figure = figures.pick('sparkle', SPARKLE_FIGURES);
  const sparkles = sparkleCount(rank);
  for (let i = 0; i < sparkles; i++) {
    drafts.push({
      instrument: 'bell',
      at: landingAt + 0.08 + i * BELL_SPACING,
      duration: 1.2,
      midi: pentatonicMidi(key.ladderTonicMidi, elementAt(figure, i)),
      velocity: 0.7 - (0.25 * i) / Math.max(1, sparkles - 1),
      pan: (i % 2 === 0 ? -1 : 1) * (0.12 + 0.05 * i),
    });
  }

  const notes = drafts
    .map<FanfareNote>((draft) => ({
      instrument: draft.instrument,
      at: humanizeTime(rng, draft.at, TIMING_JITTER),
      duration: draft.duration,
      midi: draft.midi,
      velocity: humanizeVelocity(rng, draft.velocity, VELOCITY_SPREAD),
      pan: draft.pan ?? 0,
      noiseOffset: rng(),
    }))
    .sort((a, b) => a.at - b.at);
  const end = notes.reduce((last, note) => Math.max(last, note.at + note.duration), 0);
  return {
    rank: rankKey(rank),
    title: rank.title,
    notes,
    landingAt,
    duration: end + RING_SECONDS,
    gain: elementAt(TITLE_GAIN, level),
    brightness: rankBrightness(rank),
    duck: {
      depthDb: FANFARE_DUCK_DB,
      attack: FANFARE_DUCK_ATTACK,
      hold: landingAt + holdSeconds - FANFARE_DUCK_ATTACK,
      release: FANFARE_DUCK_RELEASE,
    },
    priority: FANFARE_PRIORITY,
  };
}

/** Keep partials clear of Nyquist so a low-rate context never aliases or clamps them. */
export const NYQUIST_MARGIN = 0.8;

export function nyquistCeiling(sampleRate: number): number {
  return (sampleRate / 2) * NYQUIST_MARGIN;
}

export const BELL_PARTIALS: readonly {
  readonly ratio: number;
  readonly amplitude: number;
  readonly t60: number;
}[] = [
  { ratio: 1, amplitude: 1, t60: 1 },
  { ratio: 2.76, amplitude: 0.28, t60: 0.45 },
];
const LONG_NOTE_SECONDS = 0.4;

export function hasVibrato(note: FanfareNote): boolean {
  return note.instrument === 'brass' && note.duration >= LONG_NOTE_SECONDS;
}

/** Sources one note starts: brass gains a vibrato LFO when held, bells one per partial under Nyquist. */
export function fanfareNoteCost(note: FanfareNote, sampleRate: number): number {
  const ceiling = nyquistCeiling(sampleRate);
  const frequency = midiToHz(note.midi);
  if (frequency >= ceiling) return 0;
  switch (note.instrument) {
    case 'brass':
      return hasVibrato(note) ? 2 : 1;
    case 'bass':
      return 1;
    case 'timpani':
      return 2;
    case 'bell':
      return BELL_PARTIALS.filter((p) => frequency * p.ratio < ceiling).length;
  }
}

export function fanfareVoiceCost(spec: RankUpFanfareSpec, sampleRate: number): number {
  return spec.notes.reduce((sum, note) => sum + fanfareNoteCost(note, sampleRate), 0);
}
