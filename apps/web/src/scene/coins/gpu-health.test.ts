import { describe, expect, it } from 'vitest';
import {
  acquireWebGL2Context,
  COIN_WEBGL2_ATTRIBUTES,
  coinBackend,
  describeGpuLoss,
  watchGpuLoss,
  type CoinGpuLoss,
  type WatchableRenderer,
} from './gpu-health.ts';

interface LostInfo {
  message?: string;
  reason?: string;
}

function webgpuRenderer() {
  let resolveLost: (info: LostInfo) => void = () => undefined;
  const lost = new Promise<LostInfo>((resolve) => {
    resolveLost = resolve;
  });
  const original = (): void => undefined;
  const renderer: WatchableRenderer = {
    onDeviceLost: original,
    backend: { isWebGPUBackend: true, device: { lost } },
  };
  return { renderer, original, loseDevice: resolveLost };
}

function webglRenderer(): WatchableRenderer {
  return { onDeviceLost: () => undefined, backend: { isWebGLBackend: true } };
}

function rejection(reason: unknown): Event {
  return Object.assign(new Event('unhandledrejection', { cancelable: true }), { reason });
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('coinBackend', () => {
  it('reads the backend flag three.js sets', () => {
    expect(coinBackend(webgpuRenderer().renderer)).toBe('webgpu');
    expect(coinBackend(webglRenderer())).toBe('webgl2');
    expect(coinBackend({ backend: null })).toBe('webgl2');
  });
});

describe('describeGpuLoss', () => {
  const loss: CoinGpuLoss = {
    backend: 'webgpu',
    source: 'device-lost',
    message: 'Instance dropped',
    reason: 'unknown',
  };

  it('names the backend, the cause and the fallback', () => {
    expect(describeGpuLoss(loss, 'webgl2')).toBe(
      '[coins] WebGPU device-lost (reason: unknown): Instance dropped. Rebuilding the coin field on WebGL2.',
    );
  });

  it('says a reload is needed when there is nothing left to fall back to', () => {
    const line = describeGpuLoss({ ...loss, backend: 'webgl2', reason: null }, 'reload');
    expect(line).toMatch(/^\[coins\] WebGL2 device-lost: Instance dropped\./);
    expect(line).toMatch(/must be reloaded/);
  });

  it('does not double the full stop when the browser message already ends with one', () => {
    const line = describeGpuLoss({ ...loss, message: 'Device was destroyed.' }, 'webgl2');
    expect(line).toContain('Device was destroyed. Rebuilding');
  });
});

describe('acquireWebGL2Context', () => {
  const context = {} as WebGL2RenderingContext;

  function canvases(results: (WebGL2RenderingContext | null)[]) {
    const made: { requested: WebGLContextAttributes | undefined }[] = [];
    const factory = () => {
      const result = results[made.length] ?? null;
      const canvas = {
        requested: undefined as WebGLContextAttributes | undefined,
        getContext(_id: 'webgl2', attributes?: WebGLContextAttributes) {
          canvas.requested = attributes;
          return result;
        },
      };
      made.push(canvas);
      return canvas;
    };
    return { factory, made };
  }

  it('returns the first context on a fresh canvas with three.js attributes', async () => {
    const { factory, made } = canvases([context]);
    const sleeps: number[] = [];
    const acquired = await acquireWebGL2Context(factory, {
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    expect(acquired.context).toBe(context);
    expect(acquired.attempt).toBe(1);
    expect(made).toHaveLength(1);
    expect(made[0]?.requested).toEqual(COIN_WEBGL2_ATTRIBUTES);
    expect(sleeps).toEqual([]);
  });

  it('retries on a new canvas with a growing delay while the GPU process restarts', async () => {
    const { factory, made } = canvases([null, null, context]);
    const sleeps: number[] = [];
    const acquired = await acquireWebGL2Context(factory, {
      delayMs: 100,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    expect(acquired.attempt).toBe(3);
    expect(acquired.canvas).toBe(made[2]);
    expect(sleeps).toEqual([100, 200]);
  });

  it('gives up with an actionable error after the last attempt', async () => {
    const { factory, made } = canvases([]);
    await expect(
      acquireWebGL2Context(factory, { attempts: 3, delayMs: 10, sleep: () => Promise.resolve() }),
    ).rejects.toThrow(/unavailable after 3 attempts over 30 ms.*Reload the page/);
    expect(made).toHaveLength(3);
  });

  it('rejects a non-positive attempt count before touching a canvas', async () => {
    const { factory, made } = canvases([context]);
    await expect(acquireWebGL2Context(factory, { attempts: 0 })).rejects.toThrow(/attempts/);
    expect(made).toHaveLength(0);
  });
});

describe('watchGpuLoss', () => {
  it('reports a WebGL context loss delivered through three.js onDeviceLost', () => {
    const renderer = webglRenderer();
    const losses: CoinGpuLoss[] = [];
    const watch = watchGpuLoss(renderer, (l) => losses.push(l));
    renderer.onDeviceLost({
      api: 'WebGL',
      message: 'context lost',
      reason: null,
      originalEvent: {},
    });
    expect(losses).toEqual([
      { backend: 'webgl2', source: 'context-lost', message: 'context lost', reason: null },
    ]);
    expect(watch.loss).toEqual(losses[0]);
  });

  it('catches a WebGPU device loss whose reason three.js would swallow', async () => {
    const { renderer, loseDevice } = webgpuRenderer();
    const losses: CoinGpuLoss[] = [];
    watchGpuLoss(renderer, (l) => losses.push(l));
    loseDevice({ message: '', reason: 'destroyed' });
    await flush();
    expect(losses).toHaveLength(1);
    expect(losses[0]).toMatchObject({
      backend: 'webgpu',
      source: 'device-lost',
      reason: 'destroyed',
    });
    expect(losses[0]?.message).toMatch(/without a message/);
  });

  it('reports only the first of several loss signals', async () => {
    const { renderer, loseDevice } = webgpuRenderer();
    const target = new EventTarget();
    const losses: CoinGpuLoss[] = [];
    watchGpuLoss(renderer, (l) => losses.push(l), { rejections: target });
    target.dispatchEvent(rejection(new Error('Instance dropped in popErrorScope')));
    renderer.onDeviceLost({ api: 'WebGPU', message: 'lost', reason: 'unknown', originalEvent: {} });
    loseDevice({ message: 'lost', reason: 'unknown' });
    await flush();
    expect(losses).toEqual([
      {
        backend: 'webgpu',
        source: 'error-scope',
        message: 'Instance dropped in popErrorScope',
        reason: null,
      },
    ]);
  });

  it('silences lost-device rejections but leaves unrelated ones alone', () => {
    const { renderer } = webgpuRenderer();
    const target = new EventTarget();
    const losses: CoinGpuLoss[] = [];
    watchGpuLoss(renderer, (l) => losses.push(l), { rejections: target });
    const unrelated = rejection(new Error('fetch failed'));
    target.dispatchEvent(unrelated);
    expect(unrelated.defaultPrevented).toBe(false);
    expect(losses).toHaveLength(0);
    const lost = rejection('Instance dropped in popErrorScope');
    target.dispatchEvent(lost);
    expect(lost.defaultPrevented).toBe(true);
    expect(losses).toHaveLength(1);
  });

  it('never treats rejections as a loss on the WebGL backend', () => {
    const target = new EventTarget();
    const losses: CoinGpuLoss[] = [];
    watchGpuLoss(webglRenderer(), (l) => losses.push(l), { rejections: target });
    const event = rejection(new Error('Instance dropped in popErrorScope'));
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(losses).toHaveLength(0);
  });

  it('restores the previous handler and ignores the deliberate destroy after stop', async () => {
    const { renderer, original, loseDevice } = webgpuRenderer();
    const target = new EventTarget();
    const losses: CoinGpuLoss[] = [];
    const watch = watchGpuLoss(renderer, (l) => losses.push(l), { rejections: target });
    watch.stop();
    expect(renderer.onDeviceLost).toBe(original);
    loseDevice({ message: '', reason: 'destroyed' });
    const event = rejection(new Error('Instance dropped in popErrorScope'));
    target.dispatchEvent(event);
    await flush();
    expect(losses).toHaveLength(0);
    expect(event.defaultPrevented).toBe(false);
    expect(watch.loss).toBeNull();
  });

  it('keeps silencing stale rejections from a device that was already reported lost', () => {
    const { renderer } = webgpuRenderer();
    const target = new EventTarget();
    const losses: CoinGpuLoss[] = [];
    const watch = watchGpuLoss(renderer, (l) => losses.push(l), { rejections: target });
    target.dispatchEvent(rejection(new Error('Instance dropped in popErrorScope')));
    watch.stop();
    const stale = rejection(new Error('Instance dropped in popErrorScope'));
    target.dispatchEvent(stale);
    expect(stale.defaultPrevented).toBe(true);
    expect(losses).toHaveLength(1);
  });
});
