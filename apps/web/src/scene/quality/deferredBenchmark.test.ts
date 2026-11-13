import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BenchmarkResult } from './benchmark.ts';
import {
  BENCHMARK_AFTER_FRAMES,
  BENCHMARK_IDLE_TIMEOUT_MS,
  BENCHMARK_INPUT_QUIET_MS,
  BENCHMARK_MAX_ATTEMPTS,
  browserIdle,
  deferBenchmark,
  type IdleScheduler,
  type InputSource,
  type TimerScheduler,
} from './deferredBenchmark.ts';

const HIGH: BenchmarkResult = { tier: 'high', complete: true, msPerFrame: 3, samples: [3] };

/** An idle scheduler the test fires by hand. */
function manualIdle() {
  const queued: { callback: () => void; timeoutMs: number; cancelled: boolean }[] = [];
  const whenIdle: IdleScheduler = (callback, timeoutMs) => {
    const entry = { callback, timeoutMs, cancelled: false };
    queued.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  return {
    whenIdle,
    queued,
    fire() {
      for (const entry of queued.splice(0)) if (!entry.cancelled) entry.callback();
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A clock, timers and player input the test drives by hand. */
function manualWorld() {
  let time = 10_000;
  const timers: { at: number; callback: () => void; cancelled: boolean }[] = [];
  const listeners = new Set<() => void>();
  const after: TimerScheduler = (callback, delayMs) => {
    const entry = { at: time + delayMs, callback, cancelled: false };
    timers.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  const input: InputSource = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return {
    now: () => time,
    after,
    input,
    listeners,
    pendingTimers: () => timers.filter((entry) => !entry.cancelled),
    advance(ms: number) {
      time += ms;
      for (const entry of timers.splice(0)) {
        if (entry.cancelled) continue;
        if (entry.at <= time) entry.callback();
        else timers.push(entry);
      }
    },
    press() {
      for (const listener of listeners) listener();
    },
  };
}

function setup(run: (interrupted: () => boolean) => Promise<BenchmarkResult | null>) {
  const idle = manualIdle();
  const world = manualWorld();
  const onResult = vi.fn<(result: BenchmarkResult) => void>();
  const onError = vi.fn<(error: unknown) => void>();
  const benchmark = deferBenchmark({
    run,
    onResult,
    onError,
    whenIdle: idle.whenIdle,
    input: world.input,
    now: world.now,
    after: world.after,
  });
  const frames = (count: number) => {
    for (let i = 0; i < count; i++) benchmark.frameRendered();
  };
  return { idle, world, onResult, onError, benchmark, frames };
}

describe('deferBenchmark', () => {
  it('waits for the first frames and an idle moment before measuring', async () => {
    const run = vi.fn(() => Promise.resolve(HIGH));
    const { idle, onResult, benchmark, frames } = setup(run);

    frames(BENCHMARK_AFTER_FRAMES - 1);
    expect(benchmark.state).toBe('counting');
    expect(idle.queued).toHaveLength(0);

    frames(1);
    expect(benchmark.state).toBe('idle-wait');
    expect(idle.queued).toEqual([
      expect.objectContaining({ timeoutMs: BENCHMARK_IDLE_TIMEOUT_MS }),
    ]);
    expect(run).not.toHaveBeenCalled();

    idle.fire();
    expect(run).toHaveBeenCalledOnce();
    expect(benchmark.running).toBe(true);
    await vi.waitFor(() => {
      expect(onResult).toHaveBeenCalledWith(HIGH);
    });
    expect(benchmark.state).toBe('done');
    expect(benchmark.running).toBe(false);
  });

  it('runs once however many frames follow', async () => {
    const run = vi.fn(() => Promise.resolve(HIGH));
    const { idle, onResult, frames } = setup(run);
    frames(BENCHMARK_AFTER_FRAMES * 3);
    expect(idle.queued).toHaveLength(1);
    idle.fire();
    frames(BENCHMARK_AFTER_FRAMES * 3);
    await vi.waitFor(() => {
      expect(onResult).toHaveBeenCalledOnce();
    });
    frames(BENCHMARK_AFTER_FRAMES * 3);
    expect(idle.queued).toHaveLength(0);
    expect(run).toHaveBeenCalledOnce();
  });

  it('owns the renderer from the moment it starts until its result is in', async () => {
    const pending = deferred<BenchmarkResult>();
    const { idle, onResult, benchmark, frames } = setup(() => pending.promise);
    frames(BENCHMARK_AFTER_FRAMES);
    expect(benchmark.running).toBe(false);
    idle.fire();
    expect(benchmark.running).toBe(true);
    pending.resolve(HIGH);
    await vi.waitFor(() => {
      expect(onResult).toHaveBeenCalledOnce();
    });
    expect(benchmark.running).toBe(false);
  });

  it('never starts when cancelled while waiting for idle', () => {
    const run = vi.fn(() => Promise.resolve(HIGH));
    const { idle, benchmark, frames } = setup(run);
    frames(BENCHMARK_AFTER_FRAMES);
    benchmark.cancel();
    idle.fire();
    expect(run).not.toHaveBeenCalled();
    expect(benchmark.state).toBe('cancelled');
    expect(benchmark.running).toBe(false);
  });

  it('drops the result of a run cancelled midway (the renderer was rebuilt)', async () => {
    const pending = deferred<BenchmarkResult>();
    const { idle, onResult, onError, benchmark, frames } = setup(() => pending.promise);
    frames(BENCHMARK_AFTER_FRAMES);
    idle.fire();
    benchmark.cancel();
    expect(benchmark.running).toBe(false);
    pending.resolve(HIGH);
    await Promise.resolve();
    await Promise.resolve();
    expect(onResult).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('ignores a cancelled run that then fails on the disposed renderer', async () => {
    const pending = deferred<BenchmarkResult>();
    const { idle, onError, benchmark, frames } = setup(() => pending.promise);
    frames(BENCHMARK_AFTER_FRAMES);
    idle.fire();
    benchmark.cancel();
    pending.reject(new Error('device destroyed'));
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports a failed run and releases the renderer', async () => {
    const failure = new Error('readback failed');
    const { idle, onResult, onError, benchmark, frames } = setup(() => Promise.reject(failure));
    frames(BENCHMARK_AFTER_FRAMES);
    idle.fire();
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith(failure);
    });
    expect(onResult).not.toHaveBeenCalled();
    expect(benchmark.running).toBe(false);
  });

  it('reports a run that throws before returning a promise', async () => {
    const failure = new Error('bench scene failed to build');
    const { idle, onError, benchmark, frames } = setup(() => {
      throw failure;
    });
    frames(BENCHMARK_AFTER_FRAMES);
    expect(() => {
      idle.fire();
    }).not.toThrow();
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith(failure);
    });
    expect(benchmark.state).toBe('done');
  });

  it('reports a failure to apply the result instead of leaving it unhandled', async () => {
    const failure = new Error('setProfile failed');
    const idle = manualIdle();
    const onError = vi.fn<(error: unknown) => void>();
    const benchmark = deferBenchmark({
      run: () => Promise.resolve(HIGH),
      onResult: () => {
        throw failure;
      },
      onError,
      whenIdle: idle.whenIdle,
      input: null,
      afterFrames: 1,
    });
    benchmark.frameRendered();
    idle.fire();
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith(failure);
    });
  });
});

describe('deferBenchmark input gating', () => {
  it('waits until the player has been quiet before asking for idle time', () => {
    const run = vi.fn(() => Promise.resolve(HIGH));
    const { idle, world, benchmark, frames } = setup(run);
    world.press();
    world.advance(400);
    frames(BENCHMARK_AFTER_FRAMES);
    expect(benchmark.state).toBe('quiet-wait');
    expect(idle.queued).toHaveLength(0);

    world.advance(BENCHMARK_INPUT_QUIET_MS - 400 - 1);
    expect(benchmark.state).toBe('quiet-wait');
    world.press();
    world.advance(1);
    expect(benchmark.state).toBe('quiet-wait');

    world.advance(BENCHMARK_INPUT_QUIET_MS);
    expect(benchmark.state).toBe('idle-wait');
    idle.fire();
    expect(run).toHaveBeenCalledOnce();
  });

  it('goes back to waiting when input lands between the idle request and its callback', () => {
    const run = vi.fn(() => Promise.resolve(HIGH));
    const { idle, world, benchmark, frames } = setup(run);
    frames(BENCHMARK_AFTER_FRAMES);
    expect(benchmark.state).toBe('idle-wait');
    world.press();
    idle.fire();
    expect(run).not.toHaveBeenCalled();
    expect(benchmark.state).toBe('quiet-wait');
    world.advance(BENCHMARK_INPUT_QUIET_MS);
    idle.fire();
    expect(run).toHaveBeenCalledOnce();
  });

  it('tells the run it was interrupted, releases the renderer and retries once quiet', async () => {
    const seen: (() => boolean)[] = [];
    const runs = [deferred<BenchmarkResult | null>(), deferred<BenchmarkResult | null>()];
    const { idle, world, onResult, onError, benchmark, frames } = setup((interrupted) => {
      seen.push(interrupted);
      const next = runs[seen.length - 1];
      if (!next) throw new Error('unexpected extra run');
      return next.promise;
    });
    frames(BENCHMARK_AFTER_FRAMES);
    idle.fire();
    expect(seen[0]?.()).toBe(false);
    world.press();
    expect(seen[0]?.()).toBe(true);
    runs[0]?.resolve(null);
    await vi.waitFor(() => {
      expect(benchmark.state).toBe('quiet-wait');
    });
    expect(benchmark.running).toBe(false);
    expect(onError).not.toHaveBeenCalled();

    world.advance(BENCHMARK_INPUT_QUIET_MS);
    idle.fire();
    expect(seen[1]?.()).toBe(false);
    runs[1]?.resolve(HIGH);
    await vi.waitFor(() => {
      expect(onResult).toHaveBeenCalledWith(HIGH);
    });
    expect(world.listeners.size).toBe(0);
  });

  it('gives up on the provisional tier after repeated interruptions', async () => {
    const run = vi.fn(() => Promise.resolve(null));
    const { idle, world, onResult, onError, benchmark, frames } = setup(run);
    frames(BENCHMARK_AFTER_FRAMES);
    for (let attempt = 1; attempt <= BENCHMARK_MAX_ATTEMPTS; attempt++) {
      world.press();
      world.advance(BENCHMARK_INPUT_QUIET_MS);
      expect(benchmark.state).toBe('idle-wait');
      idle.fire();
      expect(run).toHaveBeenCalledTimes(attempt);
      await vi.waitFor(() => {
        expect(benchmark.state).not.toBe('running');
      });
    }
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(String(onError.mock.calls[0]?.[0])).toMatch(/interrupted by player input 3 times/);
    expect(onResult).not.toHaveBeenCalled();
    expect(benchmark.state).toBe('done');
    expect(world.listeners.size).toBe(0);
    idle.fire();
    expect(run).toHaveBeenCalledTimes(BENCHMARK_MAX_ATTEMPTS);
  });

  it('stops listening and drops its quiet timer when cancelled', () => {
    const run = vi.fn(() => Promise.resolve(HIGH));
    const { world, benchmark, frames } = setup(run);
    world.press();
    frames(BENCHMARK_AFTER_FRAMES);
    expect(world.pendingTimers()).toHaveLength(1);
    benchmark.cancel();
    expect(world.pendingTimers()).toHaveLength(0);
    expect(world.listeners.size).toBe(0);
    world.advance(BENCHMARK_INPUT_QUIET_MS);
    expect(run).not.toHaveBeenCalled();
  });

  it('runs straight away on a page without input', () => {
    const run = vi.fn(() => Promise.resolve(HIGH));
    const idle = manualIdle();
    const benchmark = deferBenchmark({
      run,
      onResult: vi.fn(),
      onError: vi.fn(),
      whenIdle: idle.whenIdle,
      input: null,
      afterFrames: 1,
    });
    benchmark.frameRendered();
    idle.fire();
    expect(run).toHaveBeenCalledOnce();
  });
});

describe('browserIdle', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('uses requestIdleCallback with the timeout, and cancels it', () => {
    const request = vi.fn<(callback: () => void, options: { timeout: number }) => number>(() => 7);
    const cancel = vi.fn<(handle: number) => void>();
    vi.stubGlobal('requestIdleCallback', request);
    vi.stubGlobal('cancelIdleCallback', cancel);
    const callback = vi.fn();
    const stop = browserIdle(callback, 1234);
    expect(request).toHaveBeenCalledWith(callback, { timeout: 1234 });
    stop();
    expect(cancel).toHaveBeenCalledWith(7);
  });

  it('falls back to a timer where requestIdleCallback is missing', () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestIdleCallback', undefined);
    const callback = vi.fn();
    browserIdle(callback, 1000);
    expect(callback).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(callback).toHaveBeenCalledOnce();

    const cancelled = vi.fn();
    browserIdle(cancelled, 1000)();
    vi.runAllTimers();
    expect(cancelled).not.toHaveBeenCalled();
  });
});
