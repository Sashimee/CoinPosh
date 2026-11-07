import type { Camera, Scene, WebGPURenderer } from 'three/webgpu';
import type { RenderBackend } from '../../backend.ts';
import {
  createPostPipeline,
  type PostPipeline,
  type PostPipelineOptions,
} from '../post/postPipeline.ts';
import {
  createQualityGovernor,
  resolveQuality,
  type QualityGovernor,
  type ResolvedQuality,
} from './adaptiveQuality.ts';
import { runBenchmark } from './benchmark.ts';
import { browserStore, type KeyValueStore } from './storage.ts';
import { canvasPixelRatio, type QualityProfile, type QualityTier } from './tiers.ts';

export { QUALITY_PROFILES, QUALITY_TIERS, canvasPixelRatio, isQualityTier } from './tiers.ts';
export type { QualityProfile, QualityTier } from './tiers.ts';

export interface AdaptiveRenderingOptions extends PostPipelineOptions {
  readonly renderer: WebGPURenderer;
  readonly scene: Scene;
  readonly camera: Camera;
  readonly backend: RenderBackend;
  readonly store?: KeyValueStore | null;
  readonly override?: QualityTier;
  /**
   * The device pixel ratio after the stage's own cap. Defaults to the renderer's pixel ratio
   * when this is called, which is what the stage sets at startup.
   */
  readonly devicePixelRatio?: number;
  readonly onTierChange?: (profile: QualityProfile) => void;
}

export interface AdaptiveRendering {
  readonly post: PostPipeline;
  readonly governor: QualityGovernor;
  readonly resolved: ResolvedQuality;
  /** Replaces `renderer.render(scene, camera)` in the animation loop. */
  render(nowMs: number): void;
  dispose(): void;
}

/**
 * Picks the tier (first-boot benchmark or saved), builds the post pipeline and the governor.
 *
 * Wiring contract for the stage:
 * - Await this behind the boot/loading screen, never before first paint: the benchmark
 *   compiles the full material set and can take seconds on WebGL2 mobile (`compileMs`).
 * - Create the renderer with `antialias: false`. The scene pass does its own MSAA, so a
 *   multisampled canvas only adds a full-DPR resolve to the final full-screen pass.
 * - This sets the renderer's pixel ratio to `canvasPixelRatio(profile, devicePixelRatio)`
 *   and re-applies it on every tier change, so the full-screen passes shrink with the tier.
 *   The stage must not reset the pixel ratio afterwards (resizing with `setSize` is fine).
 */
export async function createAdaptiveRendering(
  options: AdaptiveRenderingOptions,
): Promise<AdaptiveRendering> {
  const { renderer, scene, camera, backend } = options;
  const devicePixelRatio = options.devicePixelRatio ?? renderer.getPixelRatio();
  const store = options.store === undefined ? browserStore() : options.store;
  const resolved = await resolveQuality({
    backend,
    store,
    benchmark: () => runBenchmark(renderer),
    ...(options.override === undefined ? {} : { override: options.override }),
  });
  const applyPixelRatio = (profile: QualityProfile): void => {
    renderer.setPixelRatio(canvasPixelRatio(profile, devicePixelRatio));
  };
  applyPixelRatio(resolved.profile);
  const post = createPostPipeline(renderer, scene, camera, resolved.profile, options);
  const governor = createQualityGovernor(post, {
    backend,
    store,
    onTierChange(profile) {
      applyPixelRatio(profile);
      options.onTierChange?.(profile);
    },
  });
  return {
    post,
    governor,
    resolved,
    render(nowMs) {
      governor.frame(nowMs);
      post.render(nowMs);
    },
    dispose() {
      post.dispose();
    },
  };
}
