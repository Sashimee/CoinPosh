import { describe, expect, it, vi } from 'vitest';
import { CALM_SEA, DeckSway, REST_POSE, swayPose, type SwayPose } from './sway.ts';

describe('swayPose', () => {
  it('stays within the profile amplitudes over a long run', () => {
    for (let t = 0; t < 600; t += 0.37) {
      const pose = swayPose(t, CALM_SEA, 1);
      expect(Math.abs(pose.roll)).toBeLessThanOrEqual(CALM_SEA.rollAmplitude + 1e-12);
      expect(Math.abs(pose.pitch)).toBeLessThanOrEqual(CALM_SEA.pitchAmplitude + 1e-12);
      expect(Math.abs(pose.heave)).toBeLessThanOrEqual(CALM_SEA.heaveAmplitude + 1e-12);
    }
  });

  it('actually moves, using a meaningful share of each amplitude', () => {
    let maxRoll = 0;
    let maxPitch = 0;
    let maxHeave = 0;
    for (let t = 0; t < 120; t += 0.1) {
      const pose = swayPose(t, CALM_SEA, 1);
      maxRoll = Math.max(maxRoll, Math.abs(pose.roll));
      maxPitch = Math.max(maxPitch, Math.abs(pose.pitch));
      maxHeave = Math.max(maxHeave, Math.abs(pose.heave));
    }
    expect(maxRoll).toBeGreaterThan(CALM_SEA.rollAmplitude * 0.6);
    expect(maxPitch).toBeGreaterThan(CALM_SEA.pitchAmplitude * 0.6);
    expect(maxHeave).toBeGreaterThan(CALM_SEA.heaveAmplitude * 0.6);
  });

  it('returns the rest pose at zero intensity and clamps intensity to 0..1', () => {
    expect(swayPose(12.3, CALM_SEA, 0)).toBe(REST_POSE);
    expect(swayPose(12.3, CALM_SEA, -2)).toBe(REST_POSE);
    expect(swayPose(12.3, CALM_SEA, 5)).toEqual(swayPose(12.3, CALM_SEA, 1));
  });

  it('scales linearly with intensity', () => {
    const full = swayPose(4.2, CALM_SEA, 1);
    const half = swayPose(4.2, CALM_SEA, 0.5);
    expect(half.roll).toBeCloseTo(full.roll / 2, 12);
    expect(half.pitch).toBeCloseTo(full.pitch / 2, 12);
    expect(half.heave).toBeCloseTo(full.heave / 2, 12);
  });

  it('is a pure function of time', () => {
    expect(swayPose(31.7, CALM_SEA, 1)).toEqual(swayPose(31.7, CALM_SEA, 1));
  });
});

describe('DeckSway', () => {
  it('starts at rest and advances with frame deltas', () => {
    const sway = new DeckSway();
    expect(sway.pose).toBe(REST_POSE);
    sway.update(0.2);
    sway.update(0.2);
    expect(sway.pose).toEqual(swayPose(0.4, CALM_SEA, 1));
  });

  it('caps a single long frame at a quarter second so tab switches do not jolt the deck', () => {
    const sway = new DeckSway();
    sway.update(10);
    expect(sway.pose).toEqual(swayPose(0.25, CALM_SEA, 1));
  });

  it('ignores zero and negative deltas', () => {
    const sway = new DeckSway();
    sway.update(0.5);
    const before = sway.pose;
    sway.update(-1);
    sway.update(0);
    expect(sway.pose).toEqual(before);
  });

  it('notifies subscribers each update until they unsubscribe', () => {
    const sway = new DeckSway();
    const listener = vi.fn<(pose: SwayPose) => void>();
    const unsubscribe = sway.subscribe(listener);
    const pose = sway.update(0.1);
    expect(listener).toHaveBeenCalledWith(pose);
    unsubscribe();
    sway.update(0.1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('clamps intensity, rests at zero and rejects non-finite values', () => {
    const sway = new DeckSway();
    sway.intensity = 3;
    expect(sway.intensity).toBe(1);
    sway.intensity = 0;
    expect(sway.update(1)).toBe(REST_POSE);
    expect(() => {
      sway.intensity = Number.NaN;
    }).toThrow(RangeError);
    expect(() => {
      sway.intensity = Number.POSITIVE_INFINITY;
    }).toThrow(RangeError);
  });
});
