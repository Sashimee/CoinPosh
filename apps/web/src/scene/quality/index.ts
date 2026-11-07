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
import { createGpuFrameTimer } from './gpuTimer.ts';
import { browserStore, type KeyValueStore } from './storage.ts';
import type { QualityProfile, QualityTier } from './tiers.ts';
import {
  documentVisibility,
  suspendOnVisibilityChange,
  type VisibilitySource,
} from './visibility.ts';

export {
  QUALITY_PROFILES,
  QUALITY_TIERS,
  isQualityTier,
  pixelRatioFor,
  qualityOverrideFrom,
} from './tiers.ts';
export type { EmbossResolution, QualityProfile, QualityTier, VenueDetail } from './tiers.ts';
export { PAUSE_MS } from './dynamicResolution.ts';
export type { VisibilitySource } from './visibility.ts';
export { DEFAULT_RENDER_LOOK, type RenderLook } from '../post/look.ts';

export interface AdaptiveRenderingOptions extends PostPipelineOptions {
  readonly renderer: WebGPURenderer;
  readonly scene: Scene;
  readonly camera: Camera;
  readonly backend: RenderBackend;
  readonly store?: KeyValueStore | null;
  readonly override?: QualityTier;
  readonly onTierChange?: (profile: QualityProfile) => void;
  /** Same timebase as the requestAnimationFrame timestamp; injectable for tests. */
  readonly now?: () => number;
  /** Hidden/shown events that pause frame measurement; defaults to `document`. */
  readonly visibility?: VisibilitySource | null;
}

export interface AdaptiveRendering {
  readonly post: PostPipeline;
  readonly governor: QualityGovernor;
  readonly resolved: ResolvedQuality;
  /** The live tier; read coin emboss size, coin shadows and venue detail from it. */
  readonly profile: QualityProfile;
  /** Whether GPU timestamps drive dynamic resolution (`trackTimestamp: true` and support). */
  readonly gpuTimed: boolean;
  /**
   * Replaces `renderer.render(scene, camera)` in the animation loop. Call it last in the
   * frame, with the requestAnimationFrame timestamp, so the time from that timestamp to the
   * end of this call measures the frame's main-thread work.
   */
  render(nowMs: number): void;
  /** Releases the post graph; `render` throws afterwards. Call before rebuilding the renderer. */
  dispose(): void;
}

/** A rAF timestamp further than this from `now()` is from another clock (seconds, Date). */
const CLOCK_SKEW_LIMIT_MS = 1000;

/**
 * Binds post-processing and the quality governor to one renderer and backend.
 *
 * The renderer must be created with `antialias: false` (the scene pass anti-aliases) and,
 * for GPU-timed dynamic resolution, `trackTimestamp: true`. The pipeline owns the renderer
 * pixel ratio, `min(devicePixelRatio, profile.maxPixelRatio)`, on boot and on tier change.
 *
 * Await it before the first visible frame (behind the loading state): on first boot it runs
 * the benchmark, which needs up to `TIME_BUDGET_MS`. When the stage rebuilds its renderer
 * (device loss, or a WebGPU -> WebGL2 fallback), call `dispose()` on the old instance and
 * create a new one with the new renderer and backend; a backend change re-benchmarks because
 * saved tiers are per backend.
 *
 * Frame measurement pauses on `visibilitychange`, and any gap over `PAUSE_MS` between two
 * `render` calls counts as a pause rather than a slow frame, so a hidden tab, a suspended
 * phone or a debugger break never lowers resolution or the tier.
 */
export async function createAdaptiveRendering(
  options: AdaptiveRenderingOptions,
): Promise<AdaptiveRendering> {
  const { renderer, scene, camera, backend } = options;
  const now = options.now ?? (() => performance.now());
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
    source: resolved.source,
    ...(options.onTierChange === undefined ? {} : { onTierChange: options.onTierChange }),
  });
  const gpuTimer = createGpuFrameTimer(renderer);
  const stopWatchingVisibility = suspendOnVisibilityChange(
    options.visibility === undefined ? documentVisibility() : options.visibility,
    () => {
      governor.suspend();
    },
  );
  let lastCpuMs: number | null = null;
  let clockChecked = false;
  let disposed = false;
  return {
    post,
    governor,
    resolved,
    get profile() {
      return post.profile;
    },
    gpuTimed: gpuTimer !== null,
    render(nowMs) {
      if (disposed) {
        throw new Error(
          'AdaptiveRendering.render called after dispose(); create a new one for the rebuilt renderer',
        );
      }
      if (!clockChecked) {
        const skew = now() - nowMs;
        if (!(Math.abs(skew) <= CLOCK_SKEW_LIMIT_MS)) {
          throw new Error(
            `AdaptiveRendering.render(nowMs) needs the requestAnimationFrame timestamp in ms; got ${nowMs}, ${skew.toFixed(0)} ms from performance.now()`,
          );
        }
        clockChecked = true;
      }
      governor.frame(nowMs, { cpuMs: lastCpuMs, gpuMs: gpuTimer?.latestMs ?? null });
      post.render(nowMs);
      gpuTimer?.afterRender();
      const busy = now() - nowMs;
      lastCpuMs = Number.isFinite(busy) && busy >= 0 ? busy : null;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopWatchingVisibility();
      gpuTimer?.dispose();
      post.dispose();
    },
  };
}
