import { describe, expect, it } from 'vitest';
import {
  isQualityTier,
  lowerTier,
  pixelRatioFor,
  QUALITY_PROFILES,
  QUALITY_TIERS,
  qualityOverrideFrom,
} from './tiers.ts';

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

  it('trims coin emboss, coin shadows and venue detail only on the low tier', () => {
    const { low, medium, high } = QUALITY_PROFILES;
    expect([high.coinEmbossResolution, medium.coinEmbossResolution]).toEqual([1024, 1024]);
    expect(low.coinEmbossResolution).toBe(512);
    expect([high.coinShadows, medium.coinShadows, low.coinShadows]).toEqual([true, true, false]);
    expect([high.venueDetail, medium.venueDetail, low.venueDetail]).toEqual([
      'high',
      'high',
      'low',
    ]);
  });

  it('caps the renderer pixel ratio at the tier and never raises it above the display', () => {
    expect(pixelRatioFor(QUALITY_PROFILES.high, 3)).toBe(2);
    expect(pixelRatioFor(QUALITY_PROFILES.medium, 3)).toBe(1.5);
    expect(pixelRatioFor(QUALITY_PROFILES.low, 2)).toBe(1);
    expect(pixelRatioFor(QUALITY_PROFILES.high, 1.25)).toBe(1.25);
    expect(pixelRatioFor(QUALITY_PROFILES.high, 0.75)).toBe(0.75);
  });

  it('treats a missing or broken device pixel ratio as 1', () => {
    expect(pixelRatioFor(QUALITY_PROFILES.high, Number.NaN)).toBe(1);
    expect(pixelRatioFor(QUALITY_PROFILES.high, 0)).toBe(1);
    expect(pixelRatioFor(QUALITY_PROFILES.high, -2)).toBe(1);
    expect(pixelRatioFor(QUALITY_PROFILES.high, Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('reads a ?quality= override and ignores anything that is not a tier', () => {
    expect(qualityOverrideFrom('?quality=low')).toBe('low');
    expect(qualityOverrideFrom('?debug=1&quality=high')).toBe('high');
    expect(qualityOverrideFrom('')).toBeUndefined();
    expect(qualityOverrideFrom('?quality=ultra')).toBeUndefined();
    expect(qualityOverrideFrom('?quality=')).toBeUndefined();
    expect(qualityOverrideFrom('?quality=HIGH')).toBeUndefined();
  });
});
