import { RenderTarget, Vector2, type WebGPURenderer } from 'three/webgpu';
import { createPostPipeline } from '../post/postPipeline.ts';
import { BENCH_LOOK, createBenchScene } from './benchScene.ts';
import { frameCostFromBatches, median, TIER_THRESHOLDS_MS, tierForFrameCost } from './score.ts';
import { isLowerTier, QUALITY_PROFILES, type QualityTier } from './tiers.ts';

const FRAMES_PER_BATCH = 4;
const WARMUP_BATCHES = 2;
const MEASURED_BATCHES = 5;
const SYNC_PROBES = 3;
/**
 * Covers the whole run, from building the bench scene and compiling to the last batch, so a
 * provisional pick never holds first boot much longer than this. A batch only starts when the
 * cost measured so far says it ends inside the budget.
 */
export const TIME_BUDGET_MS = 600;
/** A first batch this far past the medium line cannot recover, so the boot skips the rest. */
const HOPELESS_FACTOR = 4;
const SOFTWARE_RASTERIZER = /swiftshader|llvmpipe|softpipe|lavapipe|software|basic render driver/i;

export interface BenchmarkResult {
  readonly tier: QualityTier;
  /**
   * True only when every measured batch ran. An early exit (setup over budget, a slow bare
   * scene, a hopeless first batch, or the budget running out mid-run) is a provisional pick
   * for this boot that must not be saved: the next boot measures again.
   */
  readonly complete: boolean;
  /**
   * Median GPU+submit cost of one high-tier frame, readback latency removed. When setup alone
   * used up the time budget, it is the elapsed setup time instead; when the run stopped before
   * the post pipeline drew, it is the bare bench scene's frame cost.
   */
  readonly msPerFrame: number;
  readonly samples: readonly number[];
  /** Set when the device was scored without rendering: the GPU it named. */
  readonly softwareGpu?: string;
}

/**
 * Renders the bench scene offscreen through the high-tier post pipeline at the canvas's
 * real drawing-buffer size and scores the device. It never touches the visible canvas, and
 * gives up within `TIME_BUDGET_MS` so first boot never stalls on a slow device: each step
 * starts only when the costs measured so far say it fits, so the only frames that can run
 * past the budget are the ones nothing measured beforehand (the first bare frame, and the
 * post graph's first two when they cost more than a bare one).
 *
 * Before compiling the high-tier post graph (seconds on a software GPU), it times one bare
 * frame of the bench scene: that is the scene pass without its post chain, so a bare frame
 * over the medium line already proves the device is low tier.
 *
 * A software rasterizer is low tier without a frame drawn: it has no parallel shader compile,
 * so every link blocks the main thread for up to seconds and no deadline could interrupt it.
 */
export async function runBenchmark(
  renderer: WebGPURenderer,
  now: () => number = () => performance.now(),
): Promise<BenchmarkResult> {
  const softwareGpu = softwareRasterizerOf(renderer);
  if (softwareGpu !== null) {
    return { tier: 'low', complete: false, msPerFrame: 0, samples: [], softwareGpu };
  }
  const started = now();
  const elapsed = (): number => now() - started;
  const bench = createBenchScene(renderer);
  const post = createPostPipeline(renderer, bench.scene, bench.camera, QUALITY_PROFILES.high, {
    reducedMotion: true,
    look: BENCH_LOOK,
  });
  const size = renderer.getDrawingBufferSize(new Vector2());
  const target = new RenderTarget(Math.max(size.x, 1), Math.max(size.y, 1));
  const previousTarget = renderer.getRenderTarget();
  const sync = () => renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1);
  const release = (): void => {
    target.dispose();
    post.dispose();
    bench.dispose();
  };
  let pendingCompile: Promise<unknown> | null = null;

  try {
    renderer.setRenderTarget(target);
    const compile = renderer.compileAsync(bench.scene, bench.camera);
    pendingCompile = compile;
    const compiled = await settlesWithin(compile, TIME_BUDGET_MS - elapsed());
    if (compiled) pendingCompile = null;
    if (!compiled || elapsed() > TIME_BUDGET_MS) {
      return { tier: 'low', complete: false, msPerFrame: elapsed(), samples: [] };
    }

    const renderBare = (): void => {
      renderer.render(bench.scene, bench.camera);
    };
    const probes: number[] = [];
    for (let i = 0; i < SYNC_PROBES; i++) {
      const t0 = now();
      await sync();
      probes.push(now() - t0);
    }
    const syncLatency = median(probes);
    const firstBareStart = now();
    renderBare();
    await sync();
    const firstBareMs = now() - firstBareStart;
    if (elapsed() + firstBareMs > TIME_BUDGET_MS) {
      return { tier: 'low', complete: false, msPerFrame: firstBareMs, samples: [firstBareMs] };
    }
    const bareStart = now();
    renderBare();
    await sync();
    const bareCost = Math.max(now() - bareStart - syncLatency, 0);
    // The post graph's first two frames are the one cost not measured before it is paid; a bare
    // frame is the floor for each, so the graph only starts when two of those still fit.
    const postFits = elapsed() + 2 * (bareCost + syncLatency) <= TIME_BUDGET_MS;
    if (bareCost > TIER_THRESHOLDS_MS.medium || !postFits) {
      // The bare frame leaves the post graph out, so on its own it can never vouch for high.
      const bareTier = tierForFrameCost(bareCost);
      return {
        tier: isLowerTier(bareTier, 'medium') ? bareTier : 'medium',
        complete: false,
        msPerFrame: bareCost,
        samples: [bareCost],
      };
    }

    const renderBatch = async (frames = FRAMES_PER_BATCH): Promise<number> => {
      const t0 = now();
      for (let i = 0; i < frames; i++) post.render(t0);
      await sync();
      return now() - t0;
    };
    const perFrame = (batchMs: number, frames = FRAMES_PER_BATCH): number =>
      Math.max(batchMs - syncLatency, 0) / frames;
    const batchFits = (frameMs: number): boolean =>
      elapsed() + frameMs * FRAMES_PER_BATCH + syncLatency <= TIME_BUDGET_MS;

    // The first pipeline render compiles its full-screen materials; keep that out of the score.
    post.render(now());
    await sync();
    // One frame alone first, so a device that turns out hopeless pays for one frame, not four.
    let roughCost = perFrame(await renderBatch(1), 1);
    if (roughCost > TIER_THRESHOLDS_MS.medium * HOPELESS_FACTOR) {
      return { tier: 'low', complete: false, msPerFrame: roughCost, samples: [roughCost] };
    }
    for (let i = 1; i < WARMUP_BATCHES && batchFits(roughCost); i++) {
      roughCost = perFrame(await renderBatch());
    }

    const batches: number[] = [];
    while (batches.length < MEASURED_BATCHES && batchFits(roughCost)) {
      const batchMs = await renderBatch();
      batches.push(batchMs);
      roughCost = perFrame(batchMs);
    }
    if (batches.length === 0) {
      return {
        tier: tierForFrameCost(roughCost),
        complete: false,
        msPerFrame: roughCost,
        samples: [roughCost],
      };
    }

    const msPerFrame = frameCostFromBatches(batches, syncLatency, FRAMES_PER_BATCH);
    return {
      tier: tierForFrameCost(msPerFrame),
      complete: batches.length === MEASURED_BATCHES,
      msPerFrame,
      samples: batches.map(perFrame),
    };
  } finally {
    renderer.setRenderTarget(previousTarget);
    // A compile that outlived the budget still reads the bench materials; free them after it.
    if (pendingCompile === null) release();
    else void pendingCompile.then(release, release);
  }
}

function settlesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(
      () => {
        resolve(false);
      },
      Math.max(ms, 0),
    );
  });
  return Promise.race([work.then(() => true), deadline]).finally(() => {
    clearTimeout(timer);
  });
}

interface GpuAdapterInfo {
  readonly vendor?: string;
  readonly architecture?: string;
  readonly description?: string;
  readonly isFallbackAdapter?: boolean;
}

/** The renderer string of a CPU-emulated GPU (SwiftShader, llvmpipe, WARP), or null. */
export function softwareRasterizerOf(renderer: Pick<WebGPURenderer, 'backend'>): string | null {
  const backend: object = renderer.backend;
  if ('device' in backend && isObject(backend.device) && 'adapterInfo' in backend.device) {
    const info = backend.device.adapterInfo;
    if (!isObject(info)) return null;
    const adapter: GpuAdapterInfo = info;
    const name = [adapter.vendor, adapter.architecture, adapter.description]
      .filter((part) => typeof part === 'string' && part !== '')
      .join(' ');
    if (adapter.isFallbackAdapter === true) return name === '' ? 'fallback adapter' : name;
    return SOFTWARE_RASTERIZER.test(name) ? name : null;
  }
  if ('gl' in backend && isWebGl(backend.gl)) {
    const gl = backend.gl;
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const name: unknown = gl.getParameter(
      debug === null ? gl.RENDERER : debug.UNMASKED_RENDERER_WEBGL,
    );
    return typeof name === 'string' && SOFTWARE_RASTERIZER.test(name) ? name : null;
  }
  return null;
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function isWebGl(value: unknown): value is WebGL2RenderingContext {
  return isObject(value) && 'getParameter' in value && 'getExtension' in value;
}
