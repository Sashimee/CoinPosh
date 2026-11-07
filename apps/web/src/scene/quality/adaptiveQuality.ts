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
} from './storage.ts';
import {
  canvasPixelRatio,
  lowerTier,
  QUALITY_PROFILES,
  type QualityProfile,
  type QualityTier,
} from './tiers.ts';

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

/**
 * Returns the saved tier for this backend, or runs the first-boot benchmark and saves its
 * pick. A governor downgrade saved by an earlier session wins for a few boots, then expires.
 */
export async function resolveQuality(options: ResolveQualityOptions): Promise<ResolvedQuality> {
  const logger = options.logger ?? console;
  if (options.override !== undefined) {
    return { profile: QUALITY_PROFILES[options.override], source: 'override', benchmarkMs: null };
  }
  const stored = loadQuality(options.store, options.backend, logger);
  if (stored !== null) {
    const downgrade =
      stored.downgrade !== null && stored.downgrade.bootsLeft > 0 ? stored.downgrade : null;
    if (stored.downgrade !== null) {
      const bootsLeft = (downgrade?.bootsLeft ?? 0) - 1;
      saveQuality(
        options.store,
        {
          ...stored,
          downgrade: downgrade && bootsLeft > 0 ? { tier: downgrade.tier, bootsLeft } : null,
        },
        logger,
      );
    }
    return {
      profile: QUALITY_PROFILES[downgrade?.tier ?? stored.tier],
      source: 'stored',
      benchmarkMs: stored.benchmarkMs,
    };
  }
  const result = await options.benchmark();
  logger.info(
    `[CoinPosh] Quality benchmark: ${result.msPerFrame.toFixed(2)} ms/frame on ${options.backend}, ` +
      `tier ${result.tier}, shader compile ${result.compileMs.toFixed(0)} ms`,
  );
  saveQuality(
    options.store,
    {
      tier: result.tier,
      backend: options.backend,
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

export type ScalablePipeline = Pick<
  PostPipeline,
  'profile' | 'dynamicScale' | 'rendererPixelRatio' | 'setProfile' | 'setDynamicScale'
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
 * the scale has bottomed out for a few seconds while still GPU-bound the post tier steps
 * down. The downgrade is saved for the next few boots only (see DOWNGRADE_BOOTS).
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
    const devicePixelRatio = post.rendererPixelRatio;
    const renderedRatio = canvasPixelRatio(from, devicePixelRatio) * controller.scale;
    const baseline = controller.typicalFrameMs;
    post.setProfile(to);
    controller = controllerFor(
      to,
      renderedRatio / canvasPixelRatio(to, devicePixelRatio),
      baseline ?? undefined,
    );
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

function controllerFor(
  profile: QualityProfile,
  initialScale: number,
  baselineFrameMs?: number,
): DynamicResolution {
  return new DynamicResolution({
    minScale: profile.minResolutionScale,
    maxScale: profile.maxResolutionScale,
    initialScale,
    ...(baselineFrameMs === undefined ? {} : { baselineFrameMs }),
  });
}
