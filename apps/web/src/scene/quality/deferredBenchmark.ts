import type { BenchmarkResult } from './benchmark.ts';

/**
 * Frames the first boot draws at the provisional tier before the benchmark may start: enough
 * for the venue to be on screen and its programs linked, so the benchmark never delays them.
 */
export const BENCHMARK_AFTER_FRAMES = 12;

/** Longest wait for an idle moment once the frames are in; a busy boot benchmarks anyway. */
export const BENCHMARK_IDLE_TIMEOUT_MS = 2500;

/** Calls `callback` once the main thread is idle, at most `timeoutMs` later; returns a cancel. */
export type IdleScheduler = (callback: () => void, timeoutMs: number) => () => void;

export type DeferredBenchmarkState = 'counting' | 'idle-wait' | 'running' | 'done' | 'cancelled';

export interface DeferredBenchmarkOptions {
  readonly run: () => Promise<BenchmarkResult>;
  readonly onResult: (result: BenchmarkResult) => void;
  /** A failed run leaves the boot on its provisional tier; nothing is saved. */
  readonly onError: (error: unknown) => void;
  readonly afterFrames?: number;
  readonly idleTimeoutMs?: number;
  readonly whenIdle?: IdleScheduler;
}

export interface DeferredBenchmark {
  readonly state: DeferredBenchmarkState;
  /**
   * True while the benchmark owns the renderer: it switches render targets, pixel ratio and
   * the renderer's look for its own scene, so the caller must not draw a frame meanwhile.
   */
  readonly running: boolean;
  /** Call after each frame actually drawn on screen. */
  frameRendered(): void;
  /** Stops a run that has not started and drops the result of one that has. */
  cancel(): void;
}

/**
 * Runs the first-boot quality benchmark after the first frames instead of before them, so the
 * venue is on screen at once at a provisional tier and the measured tier is applied in place.
 */
export function deferBenchmark(options: DeferredBenchmarkOptions): DeferredBenchmark {
  const afterFrames = options.afterFrames ?? BENCHMARK_AFTER_FRAMES;
  const idleTimeoutMs = options.idleTimeoutMs ?? BENCHMARK_IDLE_TIMEOUT_MS;
  const whenIdle = options.whenIdle ?? browserIdle;
  let state: DeferredBenchmarkState = 'counting';
  let frames = 0;
  let cancelIdle: (() => void) | null = null;

  const start = (): void => {
    cancelIdle = null;
    if (state !== 'idle-wait') return;
    state = 'running';
    // The executor turns a synchronous throw from `run` into a rejection.
    new Promise<BenchmarkResult>((resolve) => {
      resolve(options.run());
    })
      .then((result) => {
        if (state !== 'running') return;
        state = 'done';
        options.onResult(result);
      })
      .catch((error: unknown) => {
        if (state === 'cancelled') return;
        state = 'done';
        options.onError(error);
      });
  };

  return {
    get state() {
      return state;
    },
    get running() {
      return state === 'running';
    },
    frameRendered() {
      if (state !== 'counting') return;
      frames += 1;
      if (frames < afterFrames) return;
      state = 'idle-wait';
      cancelIdle = whenIdle(start, idleTimeoutMs);
    },
    cancel() {
      if (state === 'done' || state === 'cancelled') return;
      state = 'cancelled';
      cancelIdle?.();
      cancelIdle = null;
    },
  };
}

/** `requestIdleCallback` where the browser has it (Safari before 18 does not), else a timer. */
export const browserIdle: IdleScheduler = (callback, timeoutMs) => {
  if (typeof globalThis.requestIdleCallback === 'function') {
    const handle = globalThis.requestIdleCallback(callback, { timeout: timeoutMs });
    return () => {
      globalThis.cancelIdleCallback(handle);
    };
  }
  const handle = setTimeout(callback, 0);
  return () => {
    clearTimeout(handle);
  };
};
