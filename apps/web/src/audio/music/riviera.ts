import { clamp, createRng, elementAt, type Rng } from '../rng.ts';

export interface NoteEvent {
  /** Start, in beats from the top of the loop. */
  readonly time: number;
  readonly duration: number;
  readonly midi: number;
  readonly velocity: number;
}

export type DrumKind = 'kick' | 'rim' | 'shaker';

export interface DrumEvent {
  readonly time: number;
  readonly kind: DrumKind;
  readonly velocity: number;
}

export interface Composition {
  readonly bpm: number;
  readonly bars: number;
  readonly beatsPerBar: number;
  readonly tonicMidi: number;
  readonly keys: readonly NoteEvent[];
  readonly bass: readonly NoteEvent[];
  readonly vibes: readonly NoteEvent[];
  readonly drums: readonly DrumEvent[];
}

interface Chord {
  readonly root: number;
  readonly voicing: readonly number[];
}

/** | Dmaj9 | Bm9 | Em9 | A13 | Dmaj9 | Bm9 | Gmaj9 | A13sus4 | */
const PROGRESSION: readonly Chord[] = [
  { root: 38, voicing: [54, 57, 61, 64] },
  { root: 35, voicing: [57, 61, 62, 66] },
  { root: 40, voicing: [55, 59, 62, 66] },
  { root: 33, voicing: [55, 59, 61, 66] },
  { root: 38, voicing: [54, 57, 61, 64] },
  { root: 35, voicing: [57, 61, 62, 66] },
  { root: 31, voicing: [54, 57, 59, 62] },
  { root: 33, voicing: [55, 59, 62, 66] },
];

/** Two-bar bossa comping figure, in eighth notes. */
const COMPING: readonly (readonly number[])[] = [
  [0, 3, 6],
  [2, 5],
];

/** Bossa clave over two bars, in sixteenths. */
const CLAVE: readonly (readonly number[])[] = [
  [0, 6, 12],
  [4, 10],
];

const SHAKER_ACCENTS = [0.55, 0.22, 0.38, 0.22];

/** [bar, beat, midi, beats]: a D major pentatonic line that resolves back into bar one. */
const VIBES_LINE: readonly (readonly [number, number, number, number])[] = [
  [0, 0.5, 78, 1],
  [0, 1.5, 81, 1],
  [0, 3, 76, 1],
  [1, 0, 74, 1.5],
  [1, 2, 71, 0.5],
  [1, 2.5, 74, 1.5],
  [2, 0.5, 76, 1],
  [2, 1.5, 78, 0.5],
  [2, 2, 83, 2],
  [3, 0, 81, 1.5],
  [3, 2, 78, 0.5],
  [3, 2.5, 76, 1.5],
  [4, 0.5, 81, 1],
  [4, 1.5, 83, 1],
  [4, 3, 86, 1],
  [5, 0, 83, 1.5],
  [5, 2, 81, 0.5],
  [5, 2.5, 78, 1.5],
  [6, 0.5, 76, 1],
  [6, 1.5, 78, 0.5],
  [6, 2, 74, 2],
  [7, 0, 76, 1.5],
  [7, 2, 71, 0.5],
  [7, 2.5, 69, 1.5],
];

const TIME_JITTER_BEATS = 0.012;
const VELOCITY_JITTER = 0.06;

function humanize(rng: Rng, time: number, velocity: number): { time: number; velocity: number } {
  return {
    time: Math.max(0, time + (rng() * 2 - 1) * TIME_JITTER_BEATS),
    velocity: clamp(velocity + (rng() * 2 - 1) * VELOCITY_JITTER, 0.05, 1),
  };
}

/** "Riviera Lounge": an original 8-bar bossa loop, dedicated to the public domain (CC0). */
export function composeRiviera(seed = 0x7e1a): Composition {
  const rng = createRng(seed);
  const beatsPerBar = 4;
  const bars = PROGRESSION.length;
  const keys: NoteEvent[] = [];
  const bass: NoteEvent[] = [];
  const drums: DrumEvent[] = [];

  PROGRESSION.forEach((chord, bar) => {
    const barStart = bar * beatsPerBar;
    const hits = elementAt(COMPING, bar % 2);
    hits.forEach((eighth, i) => {
      const next = hits[i + 1] ?? 8;
      const duration = (next - eighth) * 0.5 - 0.08;
      chord.voicing.forEach((midi, n) => {
        const strum = n * 0.012;
        const { time, velocity } = humanize(rng, barStart + eighth * 0.5 + strum, 0.62 - n * 0.04);
        keys.push({ time, duration, midi, velocity });
      });
    });

    const fifth = chord.root + 7;
    const bassFigure: readonly (readonly [number, number, number, number])[] = [
      [0, 1.4, chord.root, 0.85],
      [1.5, 0.42, chord.root, 0.5],
      [2, 1.4, fifth, 0.75],
      [3.5, 0.42, fifth, 0.45],
    ];
    for (const [beat, duration, midi, level] of bassFigure) {
      const { time, velocity } = humanize(rng, barStart + beat, level);
      bass.push({ time, duration, midi, velocity });
    }

    for (let sixteenth = 0; sixteenth < 16; sixteenth++) {
      const accent = elementAt(SHAKER_ACCENTS, sixteenth % 4);
      const { time, velocity } = humanize(rng, barStart + sixteenth * 0.25, accent);
      drums.push({ time, kind: 'shaker', velocity });
    }
    for (const sixteenth of elementAt(CLAVE, bar % 2)) {
      const { time, velocity } = humanize(rng, barStart + sixteenth * 0.25, 0.6);
      drums.push({ time, kind: 'rim', velocity });
    }
    for (const [beat, level] of [
      [0, 0.75],
      [2, 0.62],
      [3.5, 0.3],
    ] as const) {
      const { time, velocity } = humanize(rng, barStart + beat, level);
      drums.push({ time, kind: 'kick', velocity });
    }
  });

  const vibes = VIBES_LINE.map(([bar, beat, midi, duration]) => {
    const { time, velocity } = humanize(rng, bar * beatsPerBar + beat, 0.7);
    return { time, duration, midi, velocity };
  });

  return { bpm: 92, bars, beatsPerBar, tonicMidi: 62, keys, bass, vibes, drums };
}

export function loopSeconds(composition: Composition): number {
  return (composition.bars * composition.beatsPerBar * 60) / composition.bpm;
}
