import { RenderTarget, Vector2, type WebGPURenderer } from 'three/webgpu';
import { createPostPipeline } from '../post/postPipeline.ts';
import { BENCH_LOOK, createBenchScene } from './benchScene.ts';
import { frameCostFromBatches, median, TIER_THRESHOLDS_MS, tierForFrameCost } from './score.ts';
import { QUALITY_PROFILES, type QualityTier } from './tiers.ts';

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

/**
 * Renders the bench scene offscreen through the high-tier post pipeline at the canvas's
 * real drawing-buffer size and scores the device. It never touches the visible canvas, and
 * gives up within `TIME_BUDGET_MS` so first boot never stalls on a slow device.
 */
export async function runBenchmark(
  renderer: WebGPURenderer,
  now: () => number = () => performance.now(),
): Promise<BenchmarkResult> {
  const started = now();
  const bench = createBenchScene(renderer);
  const post = createPostPipeline(renderer, bench.scene, bench.camera, QUALITY_PROFILES.high, {
    reducedMotion: true,
    look: BENCH_LOOK,
  });
  const size = renderer.getDrawingBufferSize(new Vector2());
  const target = new RenderTarget(Math.max(size.x, 1), Math.max(size.y, 1));
  const previousTarget = renderer.getRenderTarget();
  const sync = () => renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1);

  try {
    await renderer.compileAsync(bench.scene, bench.camera);
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
    let roughCost = (await renderBatch()) / FRAMES_PER_BATCH;
    if (roughCost > TIER_THRESHOLDS_MS.medium * HOPELESS_FACTOR) {
      return { tier: 'low', complete: false, msPerFrame: roughCost, samples: [roughCost] };
    }
    for (let i = 1; i < WARMUP_BATCHES; i++) roughCost = (await renderBatch()) / FRAMES_PER_BATCH;
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
