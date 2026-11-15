import type { Camera, Scene, WebGPURenderer } from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import type { PostPipeline } from '../post/postPipeline.ts';
import { createAdaptiveRendering, type AdaptiveRendering } from './index.ts';
import { BOOT_HOLD_MS, type ScaleHoldSources } from './scaleHold.ts';
import { QUALITY_PROFILES, type QualityProfile, type SceneScalePin } from './tiers.ts';

vi.mock('../post/postPipeline.ts', () => ({
  createPostPipeline: (
    _renderer: unknown,
    _scene: unknown,
    _camera: unknown,
    initial: QualityProfile,
  ): PostPipeline => {
    let profile = initial;
    let dynamicScale = initial.maxResolutionScale;
    const clamp = (scale: number) =>
      Math.min(profile.maxResolutionScale, Math.max(profile.minResolutionScale, scale));
    return {
      get profile() {
        return profile;
      },
      look: {} as PostPipeline['look'],
      uniforms: {} as PostPipeline['uniforms'],
      pixelRatio: 1,
      get dynamicScale() {
        return dynamicScale;
      },
      get scenePixelRatio() {
        return dynamicScale;
      },
      setProfile(next) {
        profile = next;
        dynamicScale = clamp(dynamicScale);
      },
      setLook: () => undefined,
      setDynamicScale(scale) {
        dynamicScale = clamp(scale);
      },
      render: () => undefined,
      dispose: () => undefined,
    };
  },
}));

const FRAME_MS = 1000 / 60;

interface Harness {
  readonly rendering: AdaptiveRendering;
  readonly dataset: DOMStringMap;
  readonly playable: { at: number | null };
  /** Renders frames `FRAME_MS` apart for `durationMs`. */
  readonly play: (durationMs: number) => void;
}

async function harness(sceneScale: SceneScalePin | null = null): Promise<Harness> {
  const dataset: DOMStringMap = {};
  const renderer = {
    domElement: { dataset },
    backend: {},
    hasFeature: () => false,
  } as unknown as WebGPURenderer;
  const playable = { at: null as number | null };
  const scaleHold: ScaleHoldSources = {
    playableAt: () => playable.at,
    overlayOpen: () => false,
  };
  let clock = 1_000;
  const rendering = await createAdaptiveRendering({
    renderer,
    scene: {} as Scene,
    camera: {} as Camera,
    backend: 'webgpu',
    store: null,
    override: 'medium',
    now: () => clock,
    visibility: null,
    sceneScale,
    scaleHold,
  });
  return {
    rendering,
    dataset,
    playable,
    play: (durationMs) => {
      const end = clock + durationMs;
      while (clock < end) {
        clock += FRAME_MS;
        rendering.render(clock);
      }
    },
  };
}

describe('createAdaptiveRendering boot pin', () => {
  it('pins full resolution once from the playable frame and mirrors it on the canvas', async () => {
    const { rendering, dataset, playable, play } = await harness();
    const pinFull = vi.spyOn(rendering.governor, 'pinFull');

    play(500);
    expect(pinFull).not.toHaveBeenCalled();
    expect(dataset.scenePin).toBe('none');
    expect(dataset.sceneScale).toBe(QUALITY_PROFILES.medium.maxResolutionScale.toFixed(3));
    expect(dataset.qualityTier).toBe('medium');

    playable.at = 1_400;
    play(FRAME_MS);
    expect(pinFull).toHaveBeenCalledTimes(1);
    const [forMs] = pinFull.mock.calls[0] ?? [];
    expect(forMs).toBeGreaterThan(BOOT_HOLD_MS - 200);
    expect(forMs).toBeLessThanOrEqual(BOOT_HOLD_MS);
    expect(dataset.scenePin).toBe('boot');
    expect(dataset.sceneScale).toBe(QUALITY_PROFILES.medium.maxResolutionScale.toFixed(3));

    play(BOOT_HOLD_MS - 500);
    expect(pinFull).toHaveBeenCalledTimes(1);
    expect(dataset.scenePin).toBe('boot');

    play(500);
    expect(pinFull).toHaveBeenCalledTimes(1);
    expect(dataset.scenePin).toBe('none');
  });

  it('shows no pin in a session with a pinned scene scale', async () => {
    const { dataset, playable, play } = await harness('min');
    playable.at = 1_000;
    play(1_000);
    expect(dataset.scenePin).toBe('none');
    expect(dataset.sceneScale).toBe(QUALITY_PROFILES.medium.minResolutionScale.toFixed(3));
  });
});
