import { describe, expect, it } from 'vitest';
import {
  AgXToneMapping,
  NoToneMapping,
  PCFShadowMap,
  SRGBColorSpace,
  VSMShadowMap,
} from 'three/webgpu';
import { applyRenderLook, DEFAULT_RENDER_LOOK, type LookRenderer } from './look.ts';

function venueTunedRenderer(): LookRenderer {
  return {
    toneMapping: NoToneMapping,
    toneMappingExposure: 1.4,
    outputColorSpace: 'srgb-linear',
    shadowMap: { enabled: false, type: VSMShadowMap },
  };
}

describe('applyRenderLook', () => {
  it('writes the art bible grade over whatever a venue set', () => {
    const renderer = venueTunedRenderer();
    const scene = { environmentIntensity: 1 };
    applyRenderLook(renderer, scene, DEFAULT_RENDER_LOOK);
    expect(renderer).toEqual({
      toneMapping: AgXToneMapping,
      toneMappingExposure: 0.85,
      outputColorSpace: SRGBColorSpace,
      shadowMap: { enabled: true, type: PCFShadowMap },
    });
    expect(scene.environmentIntensity).toBe(0.32);
  });

  it('honours a venue look without shadows', () => {
    const renderer = venueTunedRenderer();
    const scene = { environmentIntensity: 1 };
    applyRenderLook(renderer, scene, { exposure: 1.1, environmentIntensity: 0, shadows: false });
    expect(renderer.toneMappingExposure).toBe(1.1);
    expect(renderer.shadowMap.enabled).toBe(false);
    expect(scene.environmentIntensity).toBe(0);
  });

  it.each([
    { exposure: 0, environmentIntensity: 0.32 },
    { exposure: Number.NaN, environmentIntensity: 0.32 },
    { exposure: 0.85, environmentIntensity: -0.1 },
  ])('rejects an invalid look %o and leaves the renderer alone', (values) => {
    const renderer = venueTunedRenderer();
    const scene = { environmentIntensity: 1 };
    expect(() => {
      applyRenderLook(renderer, scene, { ...values, shadows: true });
    }).toThrow(/RenderLook/);
    expect(renderer).toEqual(venueTunedRenderer());
    expect(scene.environmentIntensity).toBe(1);
  });
});
