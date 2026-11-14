import { describe, expect, it } from 'vitest';
import { albumCuePlan, type AlbumCue } from './juice.ts';

const CUES: readonly AlbumCue[] = ['open', 'lore', 'fanfare'];
const MOTION_CHANNELS = ['particles', 'squash', 'timeManipulation'] as const;

describe('albumCuePlan', () => {
  it.each(CUES)('%s lights at least four juice channels in both motion modes', (cue) => {
    for (const reduced of [false, true]) {
      const { channels } = albumCuePlan(cue, reduced, 0.08);
      expect(new Set(channels).size, `${cue} reduced=${String(reduced)}`).toBeGreaterThanOrEqual(4);
    }
  });

  it('fires every fanfare channel the task names at full motion', () => {
    const plan = albumCuePlan('fanfare', false, 0.05);
    expect(plan.channels).toEqual(
      expect.arrayContaining(['sound', 'haptic', 'particles', 'squash', 'light']),
    );
    expect(plan.foil).toBe('sweep');
    expect(plan.haptic).toBe('fanfare');
    expect(plan.sparks).toBeGreaterThan(0);
    expect(plan.hold).toBeGreaterThan(0);
    expect(plan.chime.length).toBeGreaterThan(0);
  });

  it.each(CUES)('%s drops motion in its reduced variant but keeps sound and haptic', (cue) => {
    const plan = albumCuePlan(cue, true, 0.15);
    for (const channel of MOTION_CHANNELS) expect(plan.channels).not.toContain(channel);
    expect(plan.sparks).toBe(0);
    expect(plan.hold).toBe(0);
    expect(plan.foil).not.toBe('sweep');
    expect(plan.channels).toEqual(expect.arrayContaining(['sound', 'haptic']));
    expect(plan.chime).toEqual(albumCuePlan(cue, false, 0.15).chime);
  });

  it('keeps every chime strike inside the audio engine velocity range, in time order', () => {
    for (const cue of CUES) {
      for (const bonus of [0, 0.05, 0.15, 1]) {
        const { chime } = albumCuePlan(cue, false, bonus);
        for (const step of chime) {
          expect(step.impact.velocity).toBeGreaterThanOrEqual(0.06);
          expect(step.impact.velocity).toBeLessThanOrEqual(2.8);
          expect(Math.abs(step.impact.pan ?? 0)).toBeLessThanOrEqual(1);
        }
        const times = chime.map((step) => step.at);
        expect(times).toEqual([...times].sort((a, b) => a - b));
      }
    }
  });

  it('rings longer and throws more sparks for a richer set, within a cap', () => {
    const small = albumCuePlan('fanfare', false, 0.05);
    const large = albumCuePlan('fanfare', false, 0.15);
    const huge = albumCuePlan('fanfare', false, 5);
    expect(large.chime.length).toBeGreaterThan(small.chime.length);
    expect(large.sparks).toBeGreaterThan(small.sparks);
    expect(huge.chime.length).toBe(large.chime.length);
    expect(huge.sparks).toBeLessThanOrEqual(32);
  });

  it('keeps the open cue quiet: no fanfare haptic, chime or foil', () => {
    const plan = albumCuePlan('open', false);
    expect(plan).toMatchObject({ feedback: 'open', haptic: null, sparks: 0, foil: null });
    expect(plan.chime).toEqual([]);
  });
});
