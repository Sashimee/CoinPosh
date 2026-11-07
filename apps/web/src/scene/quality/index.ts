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
import type { QualityProfile, QualityTier } from './tiers.ts';

export { QUALITY_PROFILES, QUALITY_TIERS, isQualityTier } from './tiers.ts';
export type { QualityProfile, QualityTier } from './tiers.ts';

export interface AdaptiveRenderingOptions extends PostPipelineOptions {
  readonly renderer: WebGPURenderer;
  readonly scene: Scene;
  readonly camera: Camera;
  readonly backend: RenderBackend;
  readonly store?: KeyValueStore | null;
  readonly override?: QualityTier;
  readonly onTierChange?: (profile: QualityProfile) => void;
}

export interface AdaptiveRendering {
  readonly post: PostPipeline;
  readonly governor: QualityGovernor;
  readonly resolved: ResolvedQuality;
  /** Replaces `renderer.render(scene, camera)` in the animation loop. */
  render(nowMs: number): void;
  /** Releases the post graph; `render` throws afterwards. Call before rebuilding the renderer. */
  dispose(): void;
}

/**
 * Binds post-processing and the quality governor to one renderer and backend.
 *
 * Await it before the first visible frame (behind the loading state): on first boot it runs
 * the benchmark, which needs up to `TIME_BUDGET_MS`. When the stage rebuilds its renderer
 * (device loss, or a WebGPU -> WebGL2 fallback), call `dispose()` on the old instance and
 * create a new one with the new renderer and backend; a backend change re-benchmarks because
 * saved tiers are per backend.
 */
export async function createAdaptiveRendering(
  options: AdaptiveRenderingOptions,
): Promise<AdaptiveRendering> {
  const { renderer, scene, camera, backend } = options;
  const store = options.store === undefined ? browserStore() : options.store;
  const resolved = await resolveQuality({
    backend,
    store,
    benchmark: () => runBenchmark(renderer),
    ...(options.override === undefined ? {} : { override: options.override }),
  });
  const post = createPostPipeline(renderer, scene, camera, resolved.profile, options);
  const governor = createQualityGovernor(post, {
    backend,
    store,
    ...(options.onTierChange === undefined ? {} : { onTierChange: options.onTierChange }),
  });
  let disposed = false;
  return {
    post,
    governor,
    resolved,
    render(nowMs) {
      if (disposed) {
        throw new Error(
          'AdaptiveRendering.render called after dispose(); create a new one for the rebuilt renderer',
        );
      }
      governor.frame(nowMs);
      post.render(nowMs);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      post.dispose();
    },
  };
}
