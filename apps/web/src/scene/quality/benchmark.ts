import { RenderTarget, Vector2, type WebGPURenderer } from 'three/webgpu';
import { createPostPipeline } from '../post/postPipeline.ts';
import { BENCH_LOOK, createBenchScene } from './benchScene.ts';
import { frameCostFromBatches, median, TIER_THRESHOLDS_MS, tierForFrameCost } from './score.ts';
import { pixelRatioFor, QUALITY_PROFILES, type QualityProfile, type QualityTier } from './tiers.ts';

const FRAMES_PER_BATCH = 4;
const WARMUP_BATCHES = 2;
const MEASURED_BATCHES = 5;
const SYNC_PROBES = 3;
/** Covers the whole run, from building the bench scene and compiling to the last batch. */
export const TIME_BUDGET_MS = 1800;
/** A first batch this far past the medium line cannot recover, so the boot skips the rest. */
const HOPELESS_FACTOR = 4;

export interface BenchmarkResult {
  readonly tier: QualityTier;
  /**
   * True only when every measured batch ran. An early exit (setup over budget, a hopeless
   * first batch, or the budget running out mid-run) is a provisional pick for this boot
   * that must not be saved: the next boot measures again.
   */
  readonly complete: boolean;
  /**
   * Median GPU+submit cost of one high-tier frame, readback latency removed. When setup alone
   * used up the time budget, it is the elapsed setup time instead.
   */
  readonly msPerFrame: number;
  readonly samples: readonly number[];
}

export interface BenchmarkOptions {
  /** Reads the display's device pixel ratio; defaults to `window.devicePixelRatio`. */
  readonly devicePixelRatio?: () => number;
}

/** How big the bench renders, so that it always costs what one high-tier frame costs. */
export interface BenchResolution {
  /** The output target in device pixels: the canvas at the high tier's pixel ratio. */
  readonly width: number;
  readonly height: number;
  /**
   * Scene pass and bloom scale over the live renderer ratio. Every pass sizes itself from the
   * renderer's drawing buffer, which stays at the live tier's ratio.
   */
  readonly passScale: number;
}

/**
 * The bench always measures at `min(devicePixelRatio, high.maxPixelRatio)`, whatever ratio the
 * live tier has put on the renderer: a provisional low tier at ratio 1 would otherwise score a
 * DPR 3 phone on a quarter of the pixels a high-tier frame fills.
 */
export function benchResolution(
  cssWidth: number,
  cssHeight: number,
  liveRatio: number,
  devicePixelRatio: number,
): BenchResolution {
  if (!(liveRatio > 0)) {
    throw new Error(`benchResolution needs the renderer's pixel ratio above 0, got ${liveRatio}`);
  }
  const ratio = pixelRatioFor(QUALITY_PROFILES.high, devicePixelRatio);
  return {
    width: Math.max(Math.floor(Math.max(cssWidth, 1) * ratio), 1),
    height: Math.max(Math.floor(Math.max(cssHeight, 1) * ratio), 1),
    passScale: ratio / liveRatio,
  };
}

function benchProfile(passScale: number): QualityProfile {
  const high = QUALITY_PROFILES.high;
  return {
    ...high,
    minResolutionScale: passScale,
    maxResolutionScale: passScale,
    bloom: { ...high.bloom, resolutionScale: high.bloom.resolutionScale * passScale },
  };
}

/**
 * Renders the bench scene offscreen through the high-tier post pipeline at the canvas size and
 * the high tier's pixel ratio (`benchResolution`), and scores the device. It never touches the
 * visible canvas or the renderer's pixel ratio, and gives up within `TIME_BUDGET_MS` so first
 * boot never stalls on a slow device.
 *
 * Its pipeline applies the bench look (exposure, shadow map) to the shared renderer, so a
 * caller that already draws a scene re-applies its own look before the next frame.
 */
export async function runBenchmark(
  renderer: WebGPURenderer,
  now: () => number = () => performance.now(),
  options: BenchmarkOptions = {},
): Promise<BenchmarkResult> {
  const result = await measure(renderer, now, () => false, options);
  if (result === null) throw new Error('runBenchmark was interrupted without an interrupt check');
  return result;
}

/**
 * `runBenchmark` that stops between batches once `interrupted()` turns true, resolving null:
 * the renderer is the caller's again within one batch, and nothing from the run is scored.
 */
export function runInterruptibleBenchmark(
  renderer: WebGPURenderer,
  interrupted: () => boolean,
  now: () => number = () => performance.now(),
  options: BenchmarkOptions = {},
): Promise<BenchmarkResult | null> {
  return measure(renderer, now, interrupted, options);
}

async function measure(
  renderer: WebGPURenderer,
  now: () => number,
  interrupted: () => boolean,
  options: BenchmarkOptions,
): Promise<BenchmarkResult | null> {
  const started = now();
  const readDevicePixelRatio = options.devicePixelRatio ?? (() => globalThis.devicePixelRatio);
  const liveRatio = renderer.getPixelRatio();
  const css = renderer.getSize(new Vector2());
  const resolution = benchResolution(css.x, css.y, liveRatio, readDevicePixelRatio());
  const bench = createBenchScene(renderer);
  // The pipeline keeps the live ratio on the renderer, since resizing a live canvas would blank
  // it for as long as the run lasts; its passes scale up to the high tier's ratio instead.
  const post = createPostPipeline(
    renderer,
    bench.scene,
    bench.camera,
    benchProfile(resolution.passScale),
    {
      reducedMotion: true,
      look: BENCH_LOOK,
      devicePixelRatio: () => liveRatio,
    },
  );
  post.setDynamicScale(resolution.passScale);
  const target = new RenderTarget(resolution.width, resolution.height);
  const previousTarget = renderer.getRenderTarget();
  const sync = () => renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1);

  try {
    await renderer.compileAsync(bench.scene, bench.camera);
    if (interrupted()) return null;
    const setupMs = now() - started;
    if (setupMs > TIME_BUDGET_MS) {
      return { tier: 'low', complete: false, msPerFrame: setupMs, samples: [] };
    }
    renderer.setRenderTarget(target);

    const renderBatch = async (): Promise<number> => {
      const t0 = now();
      for (let i = 0; i < FRAMES_PER_BATCH; i++) post.render(t0);
      await sync();
      return now() - t0;
    };

    // The first pipeline render compiles its full-screen materials; keep that out of the score.
    post.render(now());
    await sync();
    if (interrupted()) return null;
    let roughCost = (await renderBatch()) / FRAMES_PER_BATCH;
    if (interrupted()) return null;
    if (roughCost > TIER_THRESHOLDS_MS.medium * HOPELESS_FACTOR) {
      return { tier: 'low', complete: false, msPerFrame: roughCost, samples: [roughCost] };
    }
    for (let i = 1; i < WARMUP_BATCHES; i++) {
      roughCost = (await renderBatch()) / FRAMES_PER_BATCH;
      if (interrupted()) return null;
    }
    if (now() - started > TIME_BUDGET_MS) {
      return {
        tier: tierForFrameCost(roughCost),
        complete: false,
        msPerFrame: roughCost,
        samples: [roughCost],
      };
    }

    const probes: number[] = [];
    for (let i = 0; i < SYNC_PROBES; i++) {
      const t0 = now();
      await sync();
      probes.push(now() - t0);
    }
    const syncLatency = median(probes);

    const batches: number[] = [];
    for (let i = 0; i < MEASURED_BATCHES; i++) {
      batches.push(await renderBatch());
      if (interrupted()) return null;
      if (now() - started > TIME_BUDGET_MS) break;
    }

    const msPerFrame = frameCostFromBatches(batches, syncLatency, FRAMES_PER_BATCH);
    return {
      tier: tierForFrameCost(msPerFrame),
      complete: batches.length === MEASURED_BATCHES,
      msPerFrame,
      samples: batches.map((ms) => Math.max(ms - syncLatency, 0) / FRAMES_PER_BATCH),
    };
  } finally {
    renderer.setRenderTarget(previousTarget);
    target.dispose();
    post.dispose();
    bench.dispose();
  }
}
