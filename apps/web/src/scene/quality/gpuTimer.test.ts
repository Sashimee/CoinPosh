import { describe, expect, it, vi } from 'vitest';
import { createGpuFrameTimer, type TimestampRenderer } from './gpuTimer.ts';

interface FakeTimestamps {
  readonly renderer: TimestampRenderer;
  readonly resolve: ReturnType<typeof vi.fn<() => Promise<number>>>;
  settle(ms: number): Promise<void>;
  fail(error: Error): Promise<void>;
}

function fakeTimestamps(tracking = true, supported = true): FakeTimestamps {
  const pending: { resolve: (ms: number) => void; reject: (error: Error) => void }[] = [];
  const resolve = vi.fn<() => Promise<number>>(
    () =>
      new Promise<number>((res, rej) => {
        pending.push({ resolve: res, reject: rej });
      }),
  );
  const renderer = {
    backend: { trackTimestamp: tracking },
    hasFeature: (name: string) => supported && name === 'timestamp-query',
    resolveTimestampsAsync: resolve,
  } as unknown as TimestampRenderer;
  const flush = () => new Promise<void>((done) => setTimeout(done, 0));
  return {
    renderer,
    resolve,
    async settle(ms) {
      pending.shift()?.resolve(ms);
      await flush();
    },
    async fail(error) {
      pending.shift()?.reject(error);
      await flush();
    },
  };
}

const quiet = () => ({ warn: vi.fn<(message: string, error?: unknown) => void>() });

describe('createGpuFrameTimer', () => {
  it('is unavailable unless the renderer tracks timestamps and the device supports them', () => {
    expect(createGpuFrameTimer(fakeTimestamps(false, true).renderer)).toBeNull();
    expect(createGpuFrameTimer(fakeTimestamps(true, false).renderer)).toBeNull();
    expect(createGpuFrameTimer(fakeTimestamps(true, true).renderer)).not.toBeNull();
  });

  it('reports the latest resolved GPU time and keeps one readback in flight', async () => {
    const gpu = fakeTimestamps();
    const timer = createGpuFrameTimer(gpu.renderer, quiet());
    expect(timer?.latestMs).toBeNull();
    timer?.afterRender();
    timer?.afterRender();
    timer?.afterRender();
    expect(gpu.resolve).toHaveBeenCalledOnce();
    await gpu.settle(7.5);
    expect(timer?.latestMs).toBe(7.5);
    timer?.afterRender();
    expect(gpu.resolve).toHaveBeenCalledTimes(2);
  });

  it('ignores empty readings', async () => {
    const gpu = fakeTimestamps();
    const timer = createGpuFrameTimer(gpu.renderer, quiet());
    timer?.afterRender();
    await gpu.settle(0);
    expect(timer?.latestMs).toBeNull();
  });

  it('stops trusting a reading once readbacks stall', async () => {
    const gpu = fakeTimestamps();
    const timer = createGpuFrameTimer(gpu.renderer, quiet());
    timer?.afterRender();
    await gpu.settle(9);
    timer?.afterRender();
    for (let i = 0; i < 29; i++) timer?.afterRender();
    expect(timer?.latestMs).toBe(9);
    timer?.afterRender();
    expect(timer?.latestMs).toBeNull();
  });

  it('disables itself and warns when a readback fails', async () => {
    const gpu = fakeTimestamps();
    const logger = quiet();
    const timer = createGpuFrameTimer(gpu.renderer, logger);
    timer?.afterRender();
    await gpu.settle(5);
    timer?.afterRender();
    await gpu.fail(new Error('device lost'));
    expect(timer?.latestMs).toBeNull();
    expect(logger.warn).toHaveBeenCalledOnce();
    timer?.afterRender();
    expect(gpu.resolve).toHaveBeenCalledTimes(2);
  });

  it('drops its reading on dispose', async () => {
    const gpu = fakeTimestamps();
    const timer = createGpuFrameTimer(gpu.renderer, quiet());
    timer?.afterRender();
    await gpu.settle(5);
    timer?.dispose();
    expect(timer?.latestMs).toBeNull();
    timer?.afterRender();
    expect(gpu.resolve).toHaveBeenCalledOnce();
  });
});
