import { ACHIEVEMENT_GRADES, type AchievementGrade } from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import { isInMajorPentatonic, midiToHz, RIVIERA_KEY, type VenueKey } from '../music/theory.ts';
import { createRng } from '../rng.ts';
import { VoicePriority } from '../voicePool.ts';
import {
  buildAchievementChime,
  CHIME_PRIORITY,
  CHIME_PROFILES,
  chimeVoiceCost,
  MAX_CHIME_PAN,
  type AchievementChimeSpec,
} from './chime.ts';
import { nyquistCeiling } from './fanfare.ts';
import { DetuneVariator, NoRepeatPicker, TONAL_DETUNE_CENTS } from './variation.ts';

const RATE = 48000;
const A_MAJOR: VenueKey = { name: 'A major', ladderTonicMidi: 69 };

function chime(
  grade: AchievementGrade,
  { seed = 1, key = RIVIERA_KEY, rate = RATE, pan = 0 } = {},
): AchievementChimeSpec {
  const rng = createRng(seed);
  return buildAchievementChime(
    grade,
    key,
    rng,
    new NoRepeatPicker(rng),
    new DetuneVariator(rng),
    rate,
    pan,
  );
}

const lastAt = (spec: AchievementChimeSpec) => Math.max(...spec.notes.map((n) => n.at));

describe('achievement chime', () => {
  it.each(ACHIEVEMENT_GRADES)('%s rings in the venue key and lands on the octave', (grade) => {
    for (const key of [RIVIERA_KEY, A_MAJOR]) {
      for (let seed = 1; seed <= 6; seed++) {
        const spec = chime(grade, { seed, key });
        expect(spec.notes.length).toBeGreaterThan(1);
        for (const note of spec.notes) {
          expect(isInMajorPentatonic(key.ladderTonicMidi, note.midi)).toBe(true);
        }
        const landing = spec.notes.filter((n) => n.at >= lastAt(spec) - 0.05);
        expect(landing.map((n) => n.midi)).toContain(key.ladderTonicMidi + 12);
        expect(spec.notes[0]?.at).toBe(0);
      }
    }
  });

  it('plays at UI priority, above footsteps and below the fanfare', () => {
    expect(chime('gold').priority).toBe(CHIME_PRIORITY);
    expect(CHIME_PRIORITY).toBeGreaterThan(VoicePriority.ui);
    expect(CHIME_PRIORITY).toBeLessThan(VoicePriority.combo);
  });

  it('grows louder, longer and richer with the badge metal', () => {
    const specs = ACHIEVEMENT_GRADES.map((grade) => chime(grade));
    const gains = specs.map((s) => s.gain);
    const durations = specs.map((s) => s.duration);
    const costs = specs.map(chimeVoiceCost);
    for (const series of [gains, durations, costs]) {
      expect(series).toEqual([...series].sort((a, b) => a - b));
      expect(new Set(series).size).toBe(ACHIEVEMENT_GRADES.length);
    }
  });

  it('gives each metal its own overtones', () => {
    const shapes = ACHIEVEMENT_GRADES.map((grade) =>
      CHIME_PROFILES[grade].partials.map((p) => p.ratio).join(','),
    );
    expect(new Set(shapes).size).toBe(ACHIEVEMENT_GRADES.length);
  });

  it('never plays the same motif twice in a row and detunes only a few cents', () => {
    const rng = createRng(11);
    const motifs = new NoRepeatPicker<AchievementGrade>(rng);
    const detune = new DetuneVariator<AchievementGrade>(rng);
    let previous: string | undefined;
    for (let i = 0; i < 60; i++) {
      const spec = buildAchievementChime('silver', RIVIERA_KEY, rng, motifs, detune, RATE);
      const shape = spec.notes.map((n) => n.midi).join(',');
      expect(shape).not.toBe(previous);
      previous = shape;
      for (const note of spec.notes) {
        const fundamental = note.partials[0]?.frequency ?? 0;
        const cents = Math.abs(1200 * Math.log2(fundamental / midiToHz(note.midi)));
        expect(cents).toBeLessThanOrEqual(TONAL_DETUNE_CENTS + 1e-6);
      }
    }
  });

  it('drops partials a low-rate context cannot carry', () => {
    const ceiling = nyquistCeiling(8000);
    const spec = chime('platinum', { rate: 8000 });
    for (const note of spec.notes) {
      for (const partial of note.partials) expect(partial.frequency).toBeLessThan(ceiling);
    }
    expect(chimeVoiceCost(spec)).toBeLessThan(chimeVoiceCost(chime('platinum')));
  });

  it('keeps the toast pan inside the stereo field', () => {
    expect(chime('bronze', { pan: 3 }).pan).toBe(MAX_CHIME_PAN);
    expect(chime('bronze', { pan: -3 }).pan).toBe(-MAX_CHIME_PAN);
    expect(chime('bronze', { pan: 0.25 }).pan).toBe(0.25);
  });

  it('rings the landing longest', () => {
    const spec = chime('gold');
    const ring = (at: number) =>
      Math.max(
        ...spec.notes.filter((n) => n.at === at).flatMap((n) => n.partials.map((p) => p.t60)),
      );
    const first = spec.notes[0]?.at ?? 0;
    expect(ring(lastAt(spec))).toBeGreaterThan(ring(first));
  });
});
