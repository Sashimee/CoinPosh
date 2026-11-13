import type { Camera, Scene, WebGPURenderer } from 'three/webgpu';
import type { RenderBackend } from '../../backend.ts';
import {
  createPostPipeline,
  type PostPipeline,
  type PostPipelineOptions,
} from '../post/postPipeline.ts';
import {
  createQualitySession,
  pendingQuality,
  resumeQuality,
  settleBenchmark,
  type QualityGovernor,
  type ResolvedQuality,
} from './adaptiveQuality.ts';
import { runBenchmark } from './benchmark.ts';
import { deferBenchmark, type DeferredBenchmark, type IdleScheduler } from './deferredBenchmark.ts';
import { assertFrameTimestamp } from './frameClock.ts';
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
export { PROVISIONAL_TIER, type QualitySource } from './adaptiveQuality.ts';
export { PAUSE_MS } from './dynamicResolution.ts';
export type { VisibilitySource } from './visibility.ts';
export { DEFAULT_RENDER_LOOK, type RenderLook } from '../post/look.ts';

/**
 * When a device with no saved tier for this backend is benchmarked:
 * - `before-first-frame`: `createAdaptiveRendering` resolves only after the benchmark, so the
 *   first frame is already at the measured tier (captures and the post preview).
 * - `deferred`: it resolves at once at `PROVISIONAL_TIER`; the benchmark runs on idle after the
 *   first `BENCHMARK_AFTER_FRAMES` frames and its tier is applied in place (the game's boot).
 */
export type BenchmarkTiming = 'before-first-frame' | 'deferred';

export interface AdaptiveRenderingOptions extends PostPipelineOptions {
  readonly renderer: WebGPURenderer;
  readonly scene: Scene;
  readonly camera: Camera;
  readonly backend: RenderBackend;
  readonly store?: KeyValueStore | null;
  readonly override?: QualityTier;
  /** Defaults to `before-first-frame`. */
  readonly benchmark?: BenchmarkTiming;
  /** Fires on every tier change after creation: a runtime step down or a deferred benchmark. */
  readonly onTierChange?: (profile: QualityProfile) => void;
  /** Same timebase as the requestAnimationFrame timestamp; injectable for tests. */
  readonly now?: () => number;
  /** Hidden/shown events that pause frame measurement; defaults to `document`. */
  readonly visibility?: VisibilitySource | null;
  /** Idle moments for a deferred benchmark; defaults to `requestIdleCallback`. */
  readonly whenIdle?: IdleScheduler;
}

export interface AdaptiveRendering {
  readonly post: PostPipeline;
  /** The live governor; a deferred benchmark replaces it, so read it each time. */
  readonly governor: QualityGovernor;
  /** Where the live tier came from; `pending` until a deferred benchmark settles. */
  readonly resolved: ResolvedQuality;
  /** The live tier; read coin emboss size, coin shadows and venue detail from it. */
  readonly profile: QualityProfile;
  /** Whether GPU timestamps drive dynamic resolution (`trackTimestamp: true` and support). */
  readonly gpuTimed: boolean;
  /**
   * Replaces `renderer.render(scene, camera)` in the animation loop. Call it last in the
   * frame, with the requestAnimationFrame timestamp, so the time from that timestamp to the
   * end of this call measures the frame's main-thread work. While a deferred benchmark runs
   * it draws nothing and the canvas keeps the previous frame.
   */
  render(nowMs: number): void;
  /** Releases the post graph; `render` throws afterwards. Call before rebuilding the renderer. */
  dispose(): void;
}

/**
 * Binds post-processing and the quality governor to one renderer and backend.
 *
 * The renderer must be created with `antialias: false` (the scene pass anti-aliases) and,
 * for GPU-timed dynamic resolution, `trackTimestamp: true`. The pipeline owns the renderer
 * pixel ratio, `min(devicePixelRatio, profile.maxPixelRatio)`, on boot and on tier change.
 *
 * With a saved tier or an override it resolves at once. Otherwise the benchmark (up to
 * `TIME_BUDGET_MS`) runs before it resolves, or after the first frames with `benchmark:
 * 'deferred'`. When the stage rebuilds its renderer (device loss, or a WebGPU -> WebGL2
 * fallback), call `dispose()` on the old instance and create a new one with the new renderer
 * and backend; a backend change re-benchmarks because saved tiers are per backend.
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
  const resumed = resumeQuality({
    backend,
    store,
    ...(options.override === undefined ? {} : { override: options.override }),
  });
  const deferred = options.benchmark === 'deferred';
  const initial =
    resumed ??
    (deferred
      ? pendingQuality()
      : settleBenchmark(await runBenchmark(renderer), { backend, store }));
  const post = createPostPipeline(renderer, scene, camera, initial.profile, options);
  const session = createQualitySession(post, initial, {
    backend,
    store,
    ...(options.onTierChange === undefined ? {} : { onTierChange: options.onTierChange }),
  });
  const benchmark: DeferredBenchmark | null = session.pending
    ? deferBenchmark({
        run: () => runBenchmark(renderer, now),
        onResult: (result) => {
          post.setLook(post.look);
          session.settle(result);
        },
        onError: (error) => {
          post.setLook(post.look);
          console.warn(
            `[CoinPosh] Quality benchmark failed on ${backend}; staying at the provisional ${initial.profile.tier} tier this boot`,
            error,
          );
        },
        ...(options.whenIdle === undefined ? {} : { whenIdle: options.whenIdle }),
      })
    : null;
  const gpuTimer = createGpuFrameTimer(renderer);
  const stopWatchingVisibility = suspendOnVisibilityChange(
    options.visibility === undefined ? documentVisibility() : options.visibility,
    () => {
      session.governor.suspend();
    },
  );
  const builtAt = now();
  let lastCpuMs: number | null = null;
  let clockChecked = false;
  let held = false;
  let disposed = false;
  return {
    post,
    get governor() {
      return session.governor;
    },
    get resolved() {
      return session.resolved;
    },
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
        assertFrameTimestamp(nowMs, builtAt, now());
        clockChecked = true;
      }
      if (benchmark?.running === true) {
        held = true;
        return;
      }
      if (held) {
        held = false;
        lastCpuMs = null;
        session.governor.suspend();
      }
      session.governor.frame(nowMs, { cpuMs: lastCpuMs, gpuMs: gpuTimer?.latestMs ?? null });
      post.render(nowMs);
      gpuTimer?.afterRender();
      const busy = now() - nowMs;
      lastCpuMs = Number.isFinite(busy) && busy >= 0 ? busy : null;
      benchmark?.frameRendered();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      benchmark?.cancel();
      stopWatchingVisibility();
      gpuTimer?.dispose();
      post.dispose();
    },
  };
}
