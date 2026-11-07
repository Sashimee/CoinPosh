import type { RenderBackend } from '../../backend.ts';
import type { PostPipeline } from '../post/postPipeline.ts';
import type { BenchmarkResult } from './benchmark.ts';
import { DynamicResolution, type FrameTiming } from './dynamicResolution.ts';
import {
  DOWNGRADE_BOOTS,
  loadQuality,
  saveQuality,
  type KeyValueStore,
  type QualityStorageLogger,
  type StoredQuality,
} from './storage.ts';
import {
  lowerTier,
  isLowerTier,
  QUALITY_PROFILES,
  type QualityProfile,
  type QualityTier,
} from './tiers.ts';

/** `provisional`: the benchmark stopped early; its pick is used this boot but not saved. */
export type QualitySource = 'stored' | 'downgrade' | 'benchmark' | 'provisional' | 'override';

export interface ResolvedQuality {
  readonly profile: QualityProfile;
  readonly source: QualitySource;
  readonly benchmarkMs: number | null;
}

export interface ResolveQualityOptions {
  readonly backend: RenderBackend;
  readonly store: KeyValueStore | null;
  readonly benchmark: () => Promise<BenchmarkResult>;
  readonly override?: QualityTier;
  readonly logger?: QualityStorageLogger & { info(message: string): void };
}

/**
 * Returns the saved tier for this backend, or runs the first-boot benchmark. Only a complete
 * benchmark is saved; a provisional pick is used for this boot and re-measured on the next.
 * A saved runtime downgrade wins over the benchmark tier until its boots run out; one that is
 * not below the benchmark tier is dropped, so a downgrade can never raise quality.
 */
export async function resolveQuality(options: ResolveQualityOptions): Promise<ResolvedQuality> {
  const logger = options.logger ?? console;
  if (options.override !== undefined) {
    return { profile: QUALITY_PROFILES[options.override], source: 'override', benchmarkMs: null };
  }
  const stored = loadQuality(options.store, options.backend, logger);
  if (stored !== null) return resumeStored(stored, options.store, logger);
  const result = await options.benchmark();
  logger.info(
    `[CoinPosh] Quality benchmark: ${result.msPerFrame.toFixed(2)} ms/frame on ${options.backend}, tier ${result.tier}${result.complete ? '' : ' (provisional, not saved)'}`,
  );
  if (!result.complete) {
    return {
      profile: QUALITY_PROFILES[result.tier],
      source: 'provisional',
      benchmarkMs: result.msPerFrame,
    };
  }
  saveQuality(
    options.store,
    {
      backend: options.backend,
      benchTier: result.tier,
      benchmarkMs: result.msPerFrame,
      downgrade: null,
    },
    logger,
  );
  return {
    profile: QUALITY_PROFILES[result.tier],
    source: 'benchmark',
    benchmarkMs: result.msPerFrame,
  };
}

function resumeStored(
  stored: StoredQuality,
  store: KeyValueStore | null,
  logger: QualityStorageLogger,
): ResolvedQuality {
  const { downgrade } = stored;
  if (downgrade !== null && !isLowerTier(downgrade.tier, stored.benchTier)) {
    logger.warn(
      `[CoinPosh] Dropping a saved quality downgrade to ${downgrade.tier}, which is not below the benchmarked ${stored.benchTier}`,
    );
    saveQuality(store, { ...stored, downgrade: null }, logger);
    return {
      profile: QUALITY_PROFILES[stored.benchTier],
      source: 'stored',
      benchmarkMs: stored.benchmarkMs,
    };
  }
  if (downgrade === null) {
    return {
      profile: QUALITY_PROFILES[stored.benchTier],
      source: 'stored',
      benchmarkMs: stored.benchmarkMs,
    };
  }
  const remaining = downgrade.bootsLeft - 1;
  saveQuality(
    store,
    { ...stored, downgrade: remaining > 0 ? { tier: downgrade.tier, bootsLeft: remaining } : null },
    logger,
  );
  return {
    profile: QUALITY_PROFILES[downgrade.tier],
    source: 'downgrade',
    benchmarkMs: stored.benchmarkMs,
  };
}

export type ScalablePipeline = Pick<
  PostPipeline,
  'profile' | 'pixelRatio' | 'dynamicScale' | 'scenePixelRatio' | 'setProfile' | 'setDynamicScale'
>;

/** What the caller measured for the frame that ended at this `frame()` call. */
export type FrameMeasurements = Omit<FrameTiming, 'intervalMs'>;

export interface QualityGovernorOptions {
  readonly backend: RenderBackend;
  readonly store: KeyValueStore | null;
  /**
   * Where this session's tier came from. `override` and `provisional` sessions never write
   * their downgrades: a forced tier says nothing about the device's benchmarked one.
   */
  readonly source: QualitySource;
  readonly onTierChange?: (profile: QualityProfile) => void;
  readonly logger?: QualityStorageLogger;
}

export interface QualityGovernor {
  readonly profile: QualityProfile;
  readonly scale: number;
  readonly smoothedFrameMs: number | null;
  readonly controller: DynamicResolution;
  /**
   * Call once per rendered frame with the rAF timestamp, plus the main-thread and GPU time
   * measured for the previous frame. Without them every slow frame is a suspect, verified by
   * whether lowering resolution helps before it counts.
   */
  frame(nowMs: number, measured?: FrameMeasurements): void;
}

/**
 * Keeps the frame rate at or above 55 fps: dynamic resolution absorbs GPU load spikes, and
 * when a GPU-bound overload persists at the floor scale the post tier steps down. CPU-bound
 * and vsync- or power-capped frames never count (see `DynamicResolution`), so those devices
 * keep their tier. The step keeps the scene's effective pixel ratio, so it only ever sheds
 * cost. The downgrade is saved next to the benchmark record and expires after
 * `DOWNGRADE_BOOTS` boots; `override` and `provisional` sessions only step down in memory.
 */
export function createQualityGovernor(
  post: ScalablePipeline,
  options: QualityGovernorOptions,
): QualityGovernor {
  const logger = options.logger ?? console;
  const persists = options.source !== 'override' && options.source !== 'provisional';
  let controller = controllerFor(post.profile, post.dynamicScale);
  let last: number | null = null;

  const stepDown = (): void => {
    const next = lowerTier(post.profile.tier);
    if (next === null) return;
    const from = post.profile;
    const to = QUALITY_PROFILES[next];
    const effectiveRatio = post.scenePixelRatio;
    const confirmed = controller.gpuBoundConfirmed;
    post.setProfile(to);
    controller = controllerFor(to, effectiveRatio / post.pixelRatio, confirmed);
    post.setDynamicScale(controller.scale);
    logger.warn(
      `[CoinPosh] Frame rate below target at minimum resolution, quality ${from.tier} -> ${to.tier}`,
    );
    const stored = persists ? loadQuality(options.store, options.backend, logger) : null;
    if (stored !== null) {
      saveQuality(
        options.store,
        { ...stored, downgrade: { tier: to.tier, bootsLeft: DOWNGRADE_BOOTS } },
        logger,
      );
    }
    options.onTierChange?.(to);
  };

  return {
    get profile() {
      return post.profile;
    },
    get scale() {
      return controller.scale;
    },
    get smoothedFrameMs() {
      return controller.smoothedFrameMs;
    },
    get controller() {
      return controller;
    },
    frame(nowMs, measured = {}) {
      const delta = last === null ? null : nowMs - last;
      last = nowMs;
      if (delta === null) return;
      const event = controller.sample({ ...measured, intervalMs: delta });
      if (event === null) return;
      if (event.kind === 'scale') post.setDynamicScale(event.scale);
      else stepDown();
    },
  };
}

function controllerFor(
  profile: QualityProfile,
  initialScale: number,
  gpuBoundConfirmed = false,
): DynamicResolution {
  return new DynamicResolution({
    minScale: profile.minResolutionScale,
    maxScale: profile.maxResolutionScale,
    initialScale,
    gpuBoundConfirmed,
  });
}
