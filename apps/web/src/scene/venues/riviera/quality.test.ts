import { describe, expect, it } from 'vitest';
import { AgXToneMapping, DataTexture, PCFShadowMap, type WebGPURenderer } from 'three/webgpu';
import { applyRivieraRendererSettings, rivieraRendererSettings } from './index.ts';
import { createRivieraMaterials, disposeMaterials } from './materials.ts';
import { MAX_SWELLS, RIVIERA_QUALITY, resolveRivieraQuality } from './quality.ts';

const tile = (): DataTexture => new DataTexture(new Uint8Array([200, 160, 120, 128]), 1, 1);

describe('resolveRivieraQuality', () => {
  it('defaults to the high tier and resolves tier names', () => {
    expect(resolveRivieraQuality()).toEqual(RIVIERA_QUALITY.high);
    expect(resolveRivieraQuality('low')).toEqual(RIVIERA_QUALITY.low);
  });

  it('applies partial overrides on top of high', () => {
    expect(resolveRivieraQuality({ sheen: false, swells: 3 })).toEqual({
      ...RIVIERA_QUALITY.high,
      sheen: false,
      swells: 3,
    });
  });

  it('orders the tiers from most to least expensive', () => {
    const { high, medium, low } = RIVIERA_QUALITY;
    expect(high.swells).toBeGreaterThanOrEqual(medium.swells);
    expect(medium.swells).toBeGreaterThanOrEqual(low.swells);
    expect(high.textureScale).toBeGreaterThanOrEqual(low.textureScale);
    expect(high.swells).toBeLessThanOrEqual(MAX_SWELLS);
  });

  it('rejects unknown tiers and out-of-range overrides', () => {
    expect(() => resolveRivieraQuality('ultra' as 'high')).toThrow(RangeError);
    expect(() => resolveRivieraQuality({ swells: MAX_SWELLS + 1 })).toThrow(RangeError);
    expect(() => resolveRivieraQuality({ swells: -1 })).toThrow(RangeError);
    expect(() => resolveRivieraQuality({ swells: 2.5 })).toThrow(RangeError);
    expect(() => resolveRivieraQuality({ textureScale: 0 })).toThrow(RangeError);
    expect(() => resolveRivieraQuality({ textureScale: 1.5 })).toThrow(RangeError);
    expect(() => resolveRivieraQuality({ textureScale: Number.NaN })).toThrow(RangeError);
  });
});

describe('quality-driven materials', () => {
  it('turns the expensive lobes off on the low tier', () => {
    const high = createRivieraMaterials({ sole: tile(), deck: tile() }, RIVIERA_QUALITY.high);
    const low = createRivieraMaterials({ sole: tile(), deck: tile() }, RIVIERA_QUALITY.low);
    expect(high.lacquer.clearcoat).toBeGreaterThan(0);
    expect(high.velvet.sheen).toBeGreaterThan(0);
    expect(high.gold.anisotropy).toBeGreaterThan(0);
    expect(low.lacquer.clearcoat).toBe(0);
    expect(low.velvet.sheen).toBe(0);
    expect(low.gold.anisotropy).toBe(0);
    disposeMaterials(high);
    disposeMaterials(low);
  });
});

describe('rivieraRendererSettings', () => {
  it('is a frozen AgX preset', () => {
    expect(Object.isFrozen(rivieraRendererSettings)).toBe(true);
    expect(rivieraRendererSettings.toneMapping).toBe(AgXToneMapping);
    expect(rivieraRendererSettings.toneMappingExposure).toBeGreaterThan(0);
  });

  it('applies tonemapping and shadows to a renderer', () => {
    const fake = { toneMapping: 0, toneMappingExposure: 1, shadowMap: { enabled: false, type: 0 } };
    const renderer = fake as unknown as WebGPURenderer;
    applyRivieraRendererSettings(renderer);
    expect(fake.toneMapping).toBe(AgXToneMapping);
    expect(fake.toneMappingExposure).toBe(rivieraRendererSettings.toneMappingExposure);
    expect(fake.shadowMap).toEqual({ enabled: true, type: PCFShadowMap });
    applyRivieraRendererSettings(renderer, { shadows: false });
    expect(fake.shadowMap.enabled).toBe(false);
  });
});
