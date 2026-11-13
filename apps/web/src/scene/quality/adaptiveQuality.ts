import type { RenderBackend } from '../../backend.ts';
import type { PostPipeline } from '../post/postPipeline.ts';
import type { BenchmarkResult } from './benchmark.ts';
import { DynamicResolution, type FrameTiming, type ResolutionEvent } from './dynamicResolution.ts';
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

/**
 * `provisional`: the benchmark stopped early; its pick is used this boot but not saved.
 * `pending`: nothing is saved for this backend and the benchmark has not run yet, so the boot
 * renders at `PROVISIONAL_TIER` until `QualitySession.settle` applies the result in place.
 */
export type QualitySource =
  'stored' | 'downgrade' | 'benchmark' | 'provisional' | 'pending' | 'override';

/**
 * The tier a first boot renders at while its benchmark waits for the first frames. The lowest
 * tier compiles fastest and the benchmark can only raise it, so a slow device never starts
 * above its means.
 */
export const PROVISIONAL_TIER: QualityTier = 'low';

export interface ResolvedQuality {
  readonly profile: QualityProfile;
  readonly source: QualitySource;
  readonly benchmarkMs: number | null;
}

export type QualityLogger = QualityStorageLogger & { info(message: string): void };

export interface ResumeQualityOptions {
  readonly backend: RenderBackend;
  readonly store: KeyValueStore | null;
  readonly override?: QualityTier;
  readonly logger?: QualityLogger;
}

export interface ResolveQualityOptions extends ResumeQualityOptions {
  readonly benchmark: () => Promise<BenchmarkResult>;
}

/**
 * Returns the saved tier for this backend, or runs the first-boot benchmark. Only a complete
 * benchmark is saved; a provisional pick is used for this boot and re-measured on the next.
 * A saved runtime downgrade wins over the benchmark tier until its boots run out; one that is
 * not below the benchmark tier is dropped, so a downgrade can never raise quality.
 */
export async function resolveQuality(options: ResolveQualityOptions): Promise<ResolvedQuality> {
  return resumeQuality(options) ?? settleBenchmark(await options.benchmark(), options);
}

/**
 * The tier this boot can start at without measuring: the override, or the saved tier (and
 * downgrade) for this backend. Null means this device has not been benchmarked on it yet.
 */
export function resumeQuality(options: ResumeQualityOptions): ResolvedQuality | null {
  const logger = options.logger ?? console;
  if (options.override !== undefined) {
    return { profile: QUALITY_PROFILES[options.override], source: 'override', benchmarkMs: null };
  }
  const stored = loadQuality(options.store, options.backend, logger);
  return stored === null ? null : resumeStored(stored, options.store, logger);
}

/** What a first boot renders at until its deferred benchmark settles. */
export function pendingQuality(): ResolvedQuality {
  return { profile: QUALITY_PROFILES[PROVISIONAL_TIER], source: 'pending', benchmarkMs: null };
}

/** Turns a benchmark run into this boot's tier, saving it for later boots when it completed. */
export function settleBenchmark(
  result: BenchmarkResult,
  options: Omit<ResumeQualityOptions, 'override'>,
): ResolvedQuality {
  const logger = options.logger ?? console;
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
   * Where this session's tier came from. `override`, `provisional` and `pending` sessions
   * never write their downgrades: a forced or unmeasured tier says nothing about the device's
   * benchmarked one.
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
  /**
   * Call when frames stop being continuous (the tab is hidden or shown, the app is
   * backgrounded): the next `frame()` only sets a new baseline, so the time spent away is
   * never read as a slow frame, however short it was.
   */
  suspend(): void;
}

/**
 * Keeps the frame rate at or above 55 fps: dynamic resolution absorbs GPU load spikes, and
 * when a GPU-bound overload persists at the floor scale the post tier steps down. CPU-bound
 * and vsync- or power-capped frames never count (see `DynamicResolution`), so those devices
 * keep their tier. The step keeps the scene's effective pixel ratio, so it only ever sheds
 * cost. The downgrade is saved next to the benchmark record and expires after
 * `DOWNGRADE_BOOTS` boots; `override`, `provisional` and `pending` sessions only step down in
 * memory.
 */
export function createQualityGovernor(
  post: ScalablePipeline,
  options: QualityGovernorOptions,
): QualityGovernor {
  const logger = options.logger ?? console;
  const persists =
    options.source !== 'override' &&
    options.source !== 'provisional' &&
    options.source !== 'pending';
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
      handle(controller.sample({ ...measured, intervalMs: delta }));
    },
    suspend() {
      last = null;
      controller.interrupt();
    },
  };

  function handle(event: ResolutionEvent | null): void {
    if (event === null) return;
    if (event.kind === 'scale') post.setDynamicScale(event.scale);
    else stepDown();
  }
}

export interface QualitySessionOptions {
  readonly backend: RenderBackend;
  readonly store: KeyValueStore | null;
  readonly onTierChange?: (profile: QualityProfile) => void;
  readonly logger?: QualityLogger;
}

export interface QualitySession {
  readonly resolved: ResolvedQuality;
  /** The live governor; `settle` replaces it, so read it per frame rather than keeping it. */
  readonly governor: QualityGovernor;
  /** True until a deferred benchmark result is settled (`resolved.source === 'pending'`). */
  readonly pending: boolean;
  /**
   * Applies a deferred benchmark result in place: the pipeline switches to the measured tier
   * at full dynamic resolution (only its graph is rebuilt, and only when the anti-aliasing
   * changes), the result is saved when complete, and `onTierChange` fires if the tier moved.
   */
  settle(result: BenchmarkResult): void;
}

/**
 * Ties the governor to where the tier came from. A `pending` session starts at
 * `PROVISIONAL_TIER` and becomes a `benchmark` or `provisional` one when it settles, at which
 * point its downgrades start to persist like any benchmarked boot's.
 */
export function createQualitySession(
  post: ScalablePipeline,
  initial: ResolvedQuality,
  options: QualitySessionOptions,
): QualitySession {
  let resolved = initial;
  const governorFor = (source: QualitySource): QualityGovernor =>
    createQualityGovernor(post, {
      backend: options.backend,
      store: options.store,
      source,
      ...(options.onTierChange === undefined ? {} : { onTierChange: options.onTierChange }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
  let governor = governorFor(initial.source);
  return {
    get resolved() {
      return resolved;
    },
    get governor() {
      return governor;
    },
    get pending() {
      return resolved.source === 'pending';
    },
    settle(result) {
      if (resolved.source !== 'pending') {
        throw new Error(
          `QualitySession.settle: this session's tier is already settled (${resolved.source}); only a pending session takes a benchmark result`,
        );
      }
      resolved = settleBenchmark(result, options);
      const moved = resolved.profile !== post.profile;
      if (moved) {
        post.setProfile(resolved.profile);
        post.setDynamicScale(resolved.profile.maxResolutionScale);
      }
      governor = governorFor(resolved.source);
      if (moved) options.onTierChange?.(resolved.profile);
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
