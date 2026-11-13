import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BenchmarkResult } from './benchmark.ts';
import {
  BENCHMARK_AFTER_FRAMES,
  BENCHMARK_IDLE_TIMEOUT_MS,
  browserIdle,
  deferBenchmark,
  type IdleScheduler,
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

function setup(run: () => Promise<BenchmarkResult>) {
  const idle = manualIdle();
  const onResult = vi.fn<(result: BenchmarkResult) => void>();
  const onError = vi.fn<(error: unknown) => void>();
  const benchmark = deferBenchmark({ run, onResult, onError, whenIdle: idle.whenIdle });
  const frames = (count: number) => {
    for (let i = 0; i < count; i++) benchmark.frameRendered();
  };
  return { idle, onResult, onError, benchmark, frames };
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
      afterFrames: 1,
    });
    benchmark.frameRendered();
    idle.fire();
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith(failure);
    });
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
