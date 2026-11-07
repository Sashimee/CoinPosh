import { describe, expect, it } from 'vitest';
import { frameCostFromBatches, median, TIER_THRESHOLDS_MS, tierForFrameCost } from './score.ts';

describe('tierForFrameCost', () => {
  it('maps the benchmark cost onto three tiers, inclusive at each threshold', () => {
    expect(tierForFrameCost(2)).toBe('high');
    expect(tierForFrameCost(TIER_THRESHOLDS_MS.high)).toBe('high');
    expect(tierForFrameCost(TIER_THRESHOLDS_MS.high + 0.01)).toBe('medium');
    expect(tierForFrameCost(TIER_THRESHOLDS_MS.medium)).toBe('medium');
    expect(tierForFrameCost(TIER_THRESHOLDS_MS.medium + 0.01)).toBe('low');
    expect(tierForFrameCost(400)).toBe('low');
  });

  it('falls back to low when the measurement is unusable', () => {
    expect(tierForFrameCost(Number.NaN)).toBe('low');
    expect(tierForFrameCost(Number.POSITIVE_INFINITY)).toBe('low');
  });
});

describe('median', () => {
  it('handles odd, even, unsorted and empty input', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([7])).toBe(7);
    expect(median([])).toBeNaN();
  });
});

describe('frameCostFromBatches', () => {
  it('removes readback latency and divides by the frames in each batch', () => {
    expect(frameCostFromBatches([26, 30, 22], 6, 4)).toBe(5);
  });

  it('is robust to one outlier batch (GC pause)', () => {
    expect(frameCostFromBatches([20, 21, 200, 20, 22], 0, 4)).toBe(5.25);
  });

  it('never reports a negative cost when latency dominates', () => {
    expect(frameCostFromBatches([3, 4], 10, 4)).toBe(0);
  });

  it('yields an unusable cost, hence low tier, when nothing was measured', () => {
    expect(tierForFrameCost(frameCostFromBatches([], 1, 4))).toBe('low');
  });
});
