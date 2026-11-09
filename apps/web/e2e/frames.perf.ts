import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  DEVICE_FRAME_BUDGET_MS,
  FRAME_SAMPLE,
  MAX_JS_HEAP_MB,
  SWIFTSHADER_FRAMES,
} from './budgets.ts';
import { PERF_DIR } from './env.ts';
import { bootGame, expect, reviewShot, tapDrop, test } from './fixtures.ts';

const WEBGL2_FALLBACK_LOG = '[CoinPosh] WebGPU unavailable, renderer fell back to WebGL2';

interface RawSample {
  readonly intervals: readonly number[];
  readonly blockingMs: number;
  readonly longFrames: number;
  readonly elapsedMs: number;
  readonly heapBytes: number | null;
}

declare global {
  interface Window {
    __frameSample?: { stop(): RawSample };
  }
  interface Performance {
    readonly memory?: { readonly usedJSHeapSize: number };
  }
}

function startSample(page: Page): Promise<void> {
  return page.evaluate(() => {
    const intervals: number[] = [];
    let blockingMs = 0;
    let longFrames = 0;
    let running = true;
    let last = performance.now();
    const startedAt = last;
    const tick = (now: number): void => {
      if (!running) return;
      intervals.push(now - last);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame((now) => {
      last = now;
      requestAnimationFrame(tick);
    });
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longFrames += 1;
        blockingMs += (entry as PerformanceEntry & { blockingDuration: number }).blockingDuration;
      }
    });
    observer.observe({ type: 'long-animation-frame', buffered: false });
    window.__frameSample = {
      stop() {
        running = false;
        observer.disconnect();
        return {
          intervals,
          blockingMs,
          longFrames,
          elapsedMs: performance.now() - startedAt,
          heapBytes: performance.memory?.usedJSHeapSize ?? null,
        };
      },
    };
  });
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new Error('No frames were sampled, so there is no percentile');
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? Number.NaN;
}

async function playFor(page: Page, ms: number): Promise<void> {
  const drops = Math.floor(ms / FRAME_SAMPLE.dropEveryMs);
  for (let i = 0; i < drops; i += 1) {
    await tapDrop(page);
    await page.waitForTimeout(FRAME_SAMPLE.dropEveryMs);
  }
}

test.describe('frame time on CI chromium (WebGL2)', () => {
  test('twenty seconds of play stays inside the SwiftShader frame floors and the heap budget', async ({
    page,
  }) => {
    const logs: string[] = [];
    page.on('console', (message) => logs.push(message.text()));
    await bootGame(page, { query: FRAME_SAMPLE.query });
    expect(logs, 'CI chromium has no WebGPU adapter, so the stage runs WebGL2').toContain(
      WEBGL2_FALLBACK_LOG,
    );

    await playFor(page, FRAME_SAMPLE.warmupMs);
    await startSample(page);
    await playFor(page, FRAME_SAMPLE.sampleMs);
    const raw = await page.evaluate(() => {
      const sample = window.__frameSample;
      if (!sample) throw new Error('The frame sampler was not started');
      return sample.stop();
    });
    await reviewShot(page, 'perf-after-sample');

    const sorted = [...raw.intervals].sort((a, b) => a - b);
    const seconds = raw.elapsedMs / 1000;
    const report = {
      backend: 'webgl2',
      rasteriser: 'swiftshader',
      viewport: page.viewportSize(),
      query: FRAME_SAMPLE.query,
      frames: raw.intervals.length,
      seconds,
      fps: raw.intervals.length / seconds,
      frameMs: {
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
        max: sorted.at(-1) ?? Number.NaN,
      },
      longAnimationFrames: raw.longFrames,
      blockingMsPerSecond: raw.blockingMs / seconds,
      jsHeapMb: raw.heapBytes === null ? null : raw.heapBytes / 2 ** 20,
      budgets: {
        deviceFrameMs: DEVICE_FRAME_BUDGET_MS,
        ...SWIFTSHADER_FRAMES,
        maxJsHeapMb: MAX_JS_HEAP_MB,
      },
    };
    await mkdir(PERF_DIR, { recursive: true });
    await writeFile(join(PERF_DIR, 'frames.json'), `${JSON.stringify(report, null, 2)}\n`);
    test.info().annotations.push({ type: 'frames', description: JSON.stringify(report) });

    expect(report.fps, 'average fps over the sample').toBeGreaterThanOrEqual(
      SWIFTSHADER_FRAMES.minFps,
    );
    expect(report.frameMs.p95, 'p95 frame time (ms)').toBeLessThanOrEqual(
      SWIFTSHADER_FRAMES.maxP95FrameMs,
    );
    expect(report.blockingMsPerSecond, 'main-thread blocking per second (ms)').toBeLessThanOrEqual(
      SWIFTSHADER_FRAMES.maxBlockingMsPerSecond,
    );
    expect(report.jsHeapMb, 'chromium reports performance.memory').not.toBeNull();
    expect(report.jsHeapMb ?? Number.POSITIVE_INFINITY, 'JS heap (MB)').toBeLessThanOrEqual(
      MAX_JS_HEAP_MB,
    );
  });
});
