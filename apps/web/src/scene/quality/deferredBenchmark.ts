import type { BenchmarkResult } from './benchmark.ts';

/**
 * Frames the first boot draws at the provisional tier before the benchmark may start: enough
 * for the venue to be on screen and its programs linked, so the benchmark never delays them.
 */
export const BENCHMARK_AFTER_FRAMES = 12;

/** Longest wait for an idle moment once the frames are in; a busy boot benchmarks anyway. */
export const BENCHMARK_IDLE_TIMEOUT_MS = 2500;

/**
 * The canvas holds its last frame while the benchmark runs, so it starts only once the player
 * has not touched the game for this long, and yields back at the next batch when they do.
 */
export const BENCHMARK_INPUT_QUIET_MS = 1500;

/** Runs interrupted by input before the boot gives up and keeps its provisional tier. */
export const BENCHMARK_MAX_ATTEMPTS = 3;

/** Calls `callback` once the main thread is idle, at most `timeoutMs` later; returns a cancel. */
export type IdleScheduler = (callback: () => void, timeoutMs: number) => () => void;

/** Calls `callback` after `delayMs`; returns a cancel. */
export type TimerScheduler = (callback: () => void, delayMs: number) => () => void;

/** Calls `listener` on each player input (pointer, touch, key, wheel); returns an unsubscribe. */
export type InputSource = (listener: () => void) => () => void;

export type DeferredBenchmarkState =
  'counting' | 'quiet-wait' | 'idle-wait' | 'running' | 'done' | 'cancelled';

export interface DeferredBenchmarkOptions {
  /**
   * Measures; `interrupted` turns true on player input during the run, and the run should then
   * stop at its next batch and resolve null so it can be retried once the player is idle.
   */
  readonly run: (interrupted: () => boolean) => Promise<BenchmarkResult | null>;
  readonly onResult: (result: BenchmarkResult) => void;
  /**
   * A failed run, or `BENCHMARK_MAX_ATTEMPTS` runs cut short by input, leave the boot on its
   * provisional tier; nothing is saved.
   */
  readonly onError: (error: unknown) => void;
  readonly afterFrames?: number;
  readonly idleTimeoutMs?: number;
  readonly whenIdle?: IdleScheduler;
  /** Player input; `null` means the page has none to wait for. Defaults to the window. */
  readonly input?: InputSource | null;
  readonly inputQuietMs?: number;
  readonly maxAttempts?: number;
  readonly now?: () => number;
  readonly after?: TimerScheduler;
}

export interface DeferredBenchmark {
  readonly state: DeferredBenchmarkState;
  /**
   * True while the benchmark owns the renderer: it switches render targets and the renderer's
   * look for its own scene, so the caller must not draw a frame meanwhile. It is only true
   * while the player is idle, and turns false within one bench batch of new input.
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
 * It runs only while the player is idle: it waits for `inputQuietMs` without input, and a run
 * that input interrupts is dropped and retried at the next quiet moment.
 */
export function deferBenchmark(options: DeferredBenchmarkOptions): DeferredBenchmark {
  const afterFrames = options.afterFrames ?? BENCHMARK_AFTER_FRAMES;
  const idleTimeoutMs = options.idleTimeoutMs ?? BENCHMARK_IDLE_TIMEOUT_MS;
  const whenIdle = options.whenIdle ?? browserIdle;
  const quietMs = options.inputQuietMs ?? BENCHMARK_INPUT_QUIET_MS;
  const maxAttempts = options.maxAttempts ?? BENCHMARK_MAX_ATTEMPTS;
  const now = options.now ?? (() => performance.now());
  const after = options.after ?? browserTimer;
  let state: DeferredBenchmarkState = 'counting';
  let frames = 0;
  let attempts = 0;
  let lastInputAt = Number.NEGATIVE_INFINITY;
  let inputDuringRun = false;
  let cancelWait: (() => void) | null = null;
  const input = options.input === undefined ? browserInput : options.input;
  const stopInput =
    input?.(() => {
      lastInputAt = now();
      if (state === 'running') inputDuringRun = true;
    }) ?? null;

  const settle = (next: 'done' | 'cancelled'): void => {
    state = next;
    cancelWait?.();
    cancelWait = null;
    stopInput?.();
  };

  const waitForQuiet = (): void => {
    const quietFor = now() - lastInputAt;
    if (quietFor >= quietMs) {
      state = 'idle-wait';
      cancelWait = whenIdle(start, idleTimeoutMs);
      return;
    }
    state = 'quiet-wait';
    cancelWait = after(waitForQuiet, quietMs - quietFor);
  };

  const start = (): void => {
    cancelWait = null;
    if (state !== 'idle-wait') return;
    if (now() - lastInputAt < quietMs) {
      waitForQuiet();
      return;
    }
    state = 'running';
    attempts += 1;
    inputDuringRun = false;
    // The executor turns a synchronous throw from `run` into a rejection.
    new Promise<BenchmarkResult | null>((resolve) => {
      resolve(options.run(() => inputDuringRun));
    })
      .then((result) => {
        if (state !== 'running') return;
        if (result !== null) {
          settle('done');
          options.onResult(result);
          return;
        }
        if (attempts >= maxAttempts) {
          settle('done');
          options.onError(
            new Error(
              `the benchmark was interrupted by player input ${attempts} times; it runs again next boot`,
            ),
          );
          return;
        }
        waitForQuiet();
      })
      .catch((error: unknown) => {
        if (state === 'cancelled') return;
        settle('done');
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
      waitForQuiet();
    },
    cancel() {
      if (state === 'done' || state === 'cancelled') return;
      settle('cancelled');
    },
  };
}

const browserTimer: TimerScheduler = (callback, delayMs) => {
  const handle = setTimeout(callback, delayMs);
  return () => {
    clearTimeout(handle);
  };
};

const INPUT_EVENTS = ['pointerdown', 'touchstart', 'keydown', 'wheel'] as const;

/** Input on the window, seen in the capture phase so a handler that stops it still counts. */
export const browserInput: InputSource | null =
  typeof globalThis.addEventListener === 'function'
    ? (listener) => {
        const options = { capture: true, passive: true } as const;
        for (const type of INPUT_EVENTS) globalThis.addEventListener(type, listener, options);
        return () => {
          for (const type of INPUT_EVENTS) globalThis.removeEventListener(type, listener, options);
        };
      }
    : null;

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
