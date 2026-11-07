import type { RenderBackend } from '../../backend.ts';
import type { PostPipeline } from '../post/postPipeline.ts';
import type { BenchmarkResult } from './benchmark.ts';
import { DynamicResolution } from './dynamicResolution.ts';
import {
  DOWNGRADE_BOOTS,
  loadQuality,
  saveQuality,
  type KeyValueStore,
  type QualityStorageLogger,
  type StoredQuality,
} from './storage.ts';
import { lowerTier, QUALITY_PROFILES, type QualityProfile, type QualityTier } from './tiers.ts';

export type QualitySource = 'stored' | 'downgrade' | 'benchmark' | 'override';

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
 * Returns the saved tier for this backend, or runs the first-boot benchmark and saves its pick.
 * A saved runtime downgrade wins over the benchmark tier until its boots run out.
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
    `[CoinPosh] Quality benchmark: ${result.msPerFrame.toFixed(2)} ms/frame on ${options.backend}, tier ${result.tier}`,
  );
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
  'profile' | 'dynamicScale' | 'sceneScale' | 'setProfile' | 'setDynamicScale'
>;

export interface QualityGovernorOptions {
  readonly backend: RenderBackend;
  readonly store: KeyValueStore | null;
  readonly onTierChange?: (profile: QualityProfile) => void;
  readonly logger?: QualityStorageLogger;
}

export interface QualityGovernor {
  readonly profile: QualityProfile;
  readonly scale: number;
  readonly smoothedFrameMs: number | null;
  /** Call once per rendered frame with the rAF timestamp. */
  frame(nowMs: number): void;
}

/**
 * Keeps the frame rate at or above 55 fps: dynamic resolution absorbs load spikes, and when
 * the scale has bottomed out for a few seconds the post tier steps down. The step keeps the
 * scene's effective pixel ratio, so it only ever sheds cost. The downgrade is saved next to
 * the benchmark record and expires after `DOWNGRADE_BOOTS` boots.
 */
export function createQualityGovernor(
  post: ScalablePipeline,
  options: QualityGovernorOptions,
): QualityGovernor {
  const logger = options.logger ?? console;
  let controller = controllerFor(post.profile, post.dynamicScale);
  let last: number | null = null;

  const stepDown = (): void => {
    const next = lowerTier(post.profile.tier);
    if (next === null) return;
    const from = post.profile;
    const to = QUALITY_PROFILES[next];
    const effectiveScale = post.sceneScale;
    post.setProfile(to);
    const ratioCap = post.sceneScale / post.dynamicScale;
    controller = controllerFor(to, effectiveScale / ratioCap);
    post.setDynamicScale(controller.scale);
    logger.warn(
      `[CoinPosh] Frame rate below target at minimum resolution, quality ${from.tier} -> ${to.tier}`,
    );
    const stored = loadQuality(options.store, options.backend, logger);
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
    frame(nowMs) {
      const delta = last === null ? null : nowMs - last;
      last = nowMs;
      if (delta === null) return;
      const event = controller.sample(delta);
      if (event === null) return;
      if (event.kind === 'scale') post.setDynamicScale(event.scale);
      else stepDown();
    },
  };
}

function controllerFor(profile: QualityProfile, initialScale: number): DynamicResolution {
  return new DynamicResolution({
    minScale: profile.minResolutionScale,
    maxScale: profile.maxResolutionScale,
    initialScale,
  });
}
