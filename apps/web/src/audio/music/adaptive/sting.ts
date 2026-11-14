export type StingInstrument = 'keys' | 'bass' | 'vibes';

export interface StingNote {
  readonly instrument: StingInstrument;
  /** Beats after the sting starts, at the tempo the bed is playing. */
  readonly beat: number;
  readonly durationBeats: number;
  readonly midi: number;
  readonly velocity: number;
}

/** Where the arpeggio lands on the held chord. */
export const STING_LANDING_BEAT = 2;
const STING_HOLD_BEATS = 3;
/** The chord rings this long past the bar it lands in before the bed comes back up. */
export const STING_DUCK_TAIL_BEATS = 1.5;

/** D major 9 climbing two octaves in sixteenths: every note sits on the Riviera key. */
const ARPEGGIO: readonly number[] = [74, 78, 81, 85, 86, 90, 93, 97];
const LANDING_KEYS: readonly number[] = [62, 66, 69, 73, 76];
const LANDING_VIBES: readonly (readonly [number, number])[] = [
  [86, 0.62],
  [93, 0.74],
  [98, 1],
];
const KEYS_STRUM_BEATS = 0.012;

/** The jackpot sting: a rising vibraphone run that lands on a full chord with the bass under it. */
export function jackpotSting(): readonly StingNote[] {
  const notes: StingNote[] = ARPEGGIO.map((midi, i) => ({
    instrument: 'vibes',
    beat: i * 0.25,
    durationBeats: 0.5,
    midi,
    velocity: 0.55 + (0.4 * i) / (ARPEGGIO.length - 1),
  }));
  LANDING_KEYS.forEach((midi, i) => {
    notes.push({
      instrument: 'keys',
      beat: STING_LANDING_BEAT + i * KEYS_STRUM_BEATS,
      durationBeats: STING_HOLD_BEATS,
      midi,
      velocity: 0.82 - i * 0.04,
    });
  });
  for (const [midi, velocity] of LANDING_VIBES) {
    notes.push({
      instrument: 'vibes',
      beat: STING_LANDING_BEAT,
      durationBeats: STING_HOLD_BEATS,
      midi,
      velocity,
    });
  }
  notes.push({
    instrument: 'bass',
    beat: STING_LANDING_BEAT,
    durationBeats: STING_HOLD_BEATS - 0.5,
    midi: 38,
    velocity: 0.9,
  });
  return notes;
}

export function stingLengthBeats(notes: readonly StingNote[]): number {
  return notes.reduce((end, note) => Math.max(end, note.beat + note.durationBeats), 0);
}
