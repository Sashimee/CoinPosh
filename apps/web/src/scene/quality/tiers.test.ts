import { describe, expect, it } from 'vitest';
import { isQualityTier, lowerTier, QUALITY_PROFILES, QUALITY_TIERS } from './tiers.ts';

describe('quality tiers', () => {
  it('orders tiers from cheapest to richest and steps down one at a time', () => {
    expect(QUALITY_TIERS).toEqual(['low', 'medium', 'high']);
    expect(lowerTier('high')).toBe('medium');
    expect(lowerTier('medium')).toBe('low');
    expect(lowerTier('low')).toBeNull();
  });

  it('recognises only the three tier names', () => {
    expect(isQualityTier('medium')).toBe(true);
    expect(isQualityTier('ultra')).toBe(false);
    expect(isQualityTier(2)).toBe(false);
    expect(isQualityTier(null)).toBe(false);
  });

  it.each(QUALITY_TIERS)('%s keeps the art bible look and valid scale bounds', (tier) => {
    const profile = QUALITY_PROFILES[tier];
    expect(profile.tier).toBe(tier);
    expect(profile.grain).toBe(0.02);
    expect(profile.bloom.strength).toBeGreaterThan(0);
    expect(profile.vignette.strength).toBeGreaterThan(0);
    expect(profile.vignette.warmth).toBeGreaterThan(0);
    expect(profile.minResolutionScale).toBeGreaterThan(0);
    expect(profile.minResolutionScale).toBeLessThanOrEqual(profile.maxResolutionScale);
    expect(profile.maxResolutionScale).toBeLessThanOrEqual(1);
  });

  it('makes every lower tier cheaper in pixels and bloom resolution', () => {
    const { low, medium, high } = QUALITY_PROFILES;
    expect(low.maxPixelRatio).toBeLessThan(medium.maxPixelRatio);
    expect(medium.maxPixelRatio).toBeLessThan(high.maxPixelRatio);
    expect(low.bloom.resolutionScale).toBeLessThan(medium.bloom.resolutionScale);
    expect(medium.bloom.resolutionScale).toBeLessThan(high.bloom.resolutionScale);
  });
});
