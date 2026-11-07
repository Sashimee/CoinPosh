import type { RenderBackend } from '../../backend.ts';
import type { PostPipeline } from '../post/postPipeline.ts';
import type { BenchmarkResult } from './benchmark.ts';
import { DynamicResolution } from './dynamicResolution.ts';
import {
  loadQuality,
  saveQuality,
  type KeyValueStore,
  type QualityStorageLogger,
} from './storage.ts';
import { lowerTier, QUALITY_PROFILES, type QualityProfile, type QualityTier } from './tiers.ts';

export type QualitySource = 'stored' | 'benchmark' | 'override';

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

/** Returns the saved tier for this backend, or runs the first-boot benchmark and saves its pick. */
export async function resolveQuality(options: ResolveQualityOptions): Promise<ResolvedQuality> {
  const logger = options.logger ?? console;
  if (options.override !== undefined) {
    return { profile: QUALITY_PROFILES[options.override], source: 'override', benchmarkMs: null };
  }
  const stored = loadQuality(options.store, options.backend, logger);
  if (stored !== null) {
    return {
      profile: QUALITY_PROFILES[stored.tier],
      source: 'stored',
      benchmarkMs: stored.benchmarkMs,
    };
  }
  const result = await options.benchmark();
  logger.info(
    `[CoinPosh] Quality benchmark: ${result.msPerFrame.toFixed(2)} ms/frame on ${options.backend}, tier ${result.tier}`,
  );
  saveQuality(
    options.store,
    { tier: result.tier, backend: options.backend, benchmarkMs: result.msPerFrame },
    logger,
  );
  return {
    profile: QUALITY_PROFILES[result.tier],
    source: 'benchmark',
    benchmarkMs: result.msPerFrame,
  };
}

export type ScalablePipeline = Pick<
  PostPipeline,
  'profile' | 'dynamicScale' | 'setProfile' | 'setDynamicScale'
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
 * the scale has bottomed out for a few seconds the post tier steps down and is saved, so the
 * next boot starts where this one settled.
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
    const pixelRatio = from.maxPixelRatio * controller.scale;
    post.setProfile(to);
    controller = controllerFor(to, pixelRatio / to.maxPixelRatio);
    post.setDynamicScale(controller.scale);
    logger.warn(
      `[CoinPosh] Frame rate below target at minimum resolution, quality ${from.tier} -> ${to.tier}`,
    );
    saveQuality(
      options.store,
      { tier: to.tier, backend: options.backend, benchmarkMs: null },
      logger,
    );
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
