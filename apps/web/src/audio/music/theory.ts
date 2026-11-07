import { elementAt } from '../rng.ts';

export const MAJOR_PENTATONIC: readonly number[] = [0, 2, 4, 7, 9];

export function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/** Degree 0 is the tonic; degrees past 4 climb into the next octave, negatives go below. */
export function pentatonicMidi(tonicMidi: number, degree: number): number {
  if (!Number.isInteger(degree)) {
    throw new RangeError(`Pentatonic degree must be an integer, got ${degree}`);
  }
  const size = MAJOR_PENTATONIC.length;
  const octave = Math.floor(degree / size);
  return tonicMidi + 12 * octave + elementAt(MAJOR_PENTATONIC, degree - octave * size);
}

export function isInMajorPentatonic(tonicMidi: number, midi: number): boolean {
  const pitchClass = (((midi - tonicMidi) % 12) + 12) % 12;
  return MAJOR_PENTATONIC.includes(pitchClass);
}

export interface VenueKey {
  readonly name: string;
  /** Tonic as a MIDI note in the octave the combo ladder starts from. */
  readonly ladderTonicMidi: number;
}

/** Riviera Yacht is in D major: bright, sunny, and every pentatonic note sits on its chords. */
export const RIVIERA_KEY: VenueKey = { name: 'D major', ladderTonicMidi: 74 };
