import { RANK_ROAD, rankKey, type Rank } from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import { isInMajorPentatonic, RIVIERA_KEY, type VenueKey } from '../music/theory.ts';
import { createRng } from '../rng.ts';
import { VoicePriority } from '../voicePool.ts';
import {
  buildRankUpFanfare,
  FANFARE_DUCK_DB,
  FANFARE_PRIORITY,
  fanfareVoiceCost,
  sparkleCount,
  SPARKLE_FIGURES,
  type RankUpFanfareSpec,
} from './fanfare.ts';
import { NoRepeatPicker } from './variation.ts';
import { STANDING_SOURCE_BUDGET } from './index.ts';

const RATE = 48000;
const C_MAJOR: VenueKey = { name: 'C major', ladderTonicMidi: 72 };
const MONARCH: Rank = { title: 'monarch', stars: 0 };
const ALL_RANKS: readonly Rank[] = [...RANK_ROAD, { title: 'monarch', stars: 7 }];

function fanfare(rank: Rank, key: VenueKey = RIVIERA_KEY, seed = 1): RankUpFanfareSpec {
  const rng = createRng(seed);
  return buildRankUpFanfare(rank, key, rng, new NoRepeatPicker(rng));
}

const instruments = (spec: RankUpFanfareSpec) => new Set(spec.notes.map((n) => n.instrument));

describe('rank-up fanfare', () => {
  it.each(ALL_RANKS.map((rank) => [rankKey(rank), rank] as const))(
    '%s plays only notes of the venue key',
    (_, rank) => {
      for (const key of [RIVIERA_KEY, C_MAJOR]) {
        const spec = fanfare(rank, key);
        for (const note of spec.notes) {
          expect(isInMajorPentatonic(key.ladderTonicMidi, note.midi)).toBe(true);
        }
      }
    },
  );

  it('lands its call on the tonic, an octave under the combo ladder', () => {
    for (const key of [RIVIERA_KEY, C_MAJOR]) {
      const spec = fanfare({ title: 'commoner', grade: 1 }, key);
      const landing = spec.notes.filter(
        (n) => n.instrument === 'brass' && Math.abs(n.at - spec.landingAt) < 0.01,
      );
      expect(landing.map((n) => n.midi)).toContain(key.ladderTonicMidi);
      expect(spec.notes[0]?.midi).toBe(key.ladderTonicMidi - 12);
    }
  });

  it('starts on the first sample and lands fast enough to stamp the crest', () => {
    for (const rank of ALL_RANKS) {
      const spec = fanfare(rank);
      expect(spec.notes[0]?.at).toBe(0);
      expect(spec.notes.every((n) => n.at >= 0)).toBe(true);
      expect(spec.landingAt).toBeGreaterThan(0);
      expect(spec.landingAt).toBeLessThanOrEqual(0.65);
      for (const note of spec.notes) {
        expect(note.at + note.duration).toBeLessThanOrEqual(spec.duration);
      }
    }
  });

  it('grows a section per title: harmony and bass, then drums, then the full court', () => {
    const commoner = fanfare({ title: 'commoner', grade: 1 });
    const baron = fanfare({ title: 'baron', grade: 1 });
    const duke = fanfare({ title: 'duke', grade: 1 });
    const monarch = fanfare(MONARCH);
    expect(instruments(commoner)).toEqual(new Set(['brass', 'bell']));
    expect(instruments(baron)).toEqual(new Set(['brass', 'bell', 'bass']));
    expect(instruments(duke)).toEqual(new Set(['brass', 'bell', 'bass', 'timpani']));
    const counts = [commoner, baron, duke, monarch].map((s) => s.notes.length);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(new Set(counts).size).toBe(4);
    const gains = [commoner, baron, duke, monarch].map((s) => s.gain);
    expect(gains).toEqual([...gains].sort((a, b) => a - b));
    expect(monarch.duration).toBeGreaterThan(commoner.duration);
    const rolls = monarch.notes.filter(
      (n) => n.instrument === 'timpani' && n.at < monarch.landingAt,
    );
    expect(rolls.length).toBeGreaterThan(
      duke.notes.filter((n) => n.instrument === 'timpani' && n.at < duke.landingAt).length,
    );
  });

  it('adds a sparkle per grade and more for Monarch stars, capped', () => {
    for (let grade = 1; grade <= 5; grade++) {
      const rank: Rank = { title: 'baron', grade };
      const bells = fanfare(rank).notes.filter((n) => n.instrument === 'bell');
      expect(bells).toHaveLength(grade);
      expect(sparkleCount(rank)).toBe(grade);
      expect(bells.every((n) => n.at > fanfare(rank).landingAt)).toBe(true);
    }
    expect(sparkleCount(MONARCH)).toBe(5);
    expect(sparkleCount({ title: 'monarch', stars: 2 })).toBe(7);
    expect(sparkleCount({ title: 'monarch', stars: 400 })).toBe(8);
    for (const figure of SPARKLE_FIGURES) {
      expect(figure.length).toBeGreaterThanOrEqual(sparkleCount({ title: 'monarch', stars: 400 }));
    }
  });

  it('blazes brighter with each grade', () => {
    const brightness = [1, 2, 3, 4, 5].map((grade) => fanfare({ title: 'duke', grade }).brightness);
    expect(brightness).toEqual([...brightness].sort((a, b) => a - b));
    expect(new Set(brightness).size).toBe(5);
    expect(fanfare(MONARCH).brightness).toBe(1);
  });

  it('ducks the music like the jackpot sting, held through the landing chord', () => {
    for (const rank of ALL_RANKS) {
      const spec = fanfare(rank);
      expect(spec.duck.depthDb).toBe(FANFARE_DUCK_DB);
      expect(spec.duck.attack + spec.duck.hold).toBeGreaterThan(spec.landingAt);
      expect(spec.duck.release).toBeGreaterThan(0);
      expect(spec.priority).toBe(FANFARE_PRIORITY);
      expect(spec.priority).toBeGreaterThan(VoicePriority.combo);
    }
  });

  it('never repeats the sparkle figure twice in a row', () => {
    const rng = createRng(5);
    const figures = new NoRepeatPicker<'sparkle'>(rng);
    const rank: Rank = { title: 'duke', grade: 5 };
    let previous: string | undefined;
    for (let i = 0; i < 40; i++) {
      const spec = buildRankUpFanfare(rank, RIVIERA_KEY, rng, figures);
      const shape = spec.notes
        .filter((n) => n.instrument === 'bell')
        .map((n) => n.midi)
        .join(',');
      expect(shape).not.toBe(previous);
      previous = shape;
    }
  });

  it('is reproducible from a seed and humanised across seeds', () => {
    const rank: Rank = { title: 'baron', grade: 3 };
    expect(fanfare(rank, RIVIERA_KEY, 4)).toEqual(fanfare(rank, RIVIERA_KEY, 4));
    const a = fanfare(rank, RIVIERA_KEY, 4).notes.map((n) => n.velocity);
    const b = fanfare(rank, RIVIERA_KEY, 5).notes.map((n) => n.velocity);
    expect(a).not.toEqual(b);
  });

  it('fits the standing source budget even as the richest Monarch fanfare', () => {
    const spec = fanfare({ title: 'monarch', stars: 99 });
    const cost = fanfareVoiceCost(spec, RATE);
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThanOrEqual(STANDING_SOURCE_BUDGET);
    expect(fanfareVoiceCost(spec, 8000)).toBeLessThan(cost);
  });
});
