import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUALITY_PROFILES } from './scene/quality/tiers.ts';
import type * as Tiers from './scene/quality/tiers.ts';

const events: string[] = [];
const rendererBehaviour = { failFirstFrame: false, failNextFrame: false };
const frameState = {
  loop: null as ((time: number) => void) | null,
  coinUpdates: 0,
  suspend: vi.fn(),
};

vi.mock('three/webgpu', () => {
  class Color {
    constructor(readonly value: number) {}
  }
  class Scene {
    background: unknown = null;
    add = vi.fn();
    remove = vi.fn();
  }
  class PerspectiveCamera {
    aspect = 1;
    updateProjectionMatrix = vi.fn();
  }
  class Timer {
    connect = vi.fn();
    update = vi.fn();
    getDelta = () => 0;
    getElapsed = () => 0;
    dispose = vi.fn();
  }
  class WebGPURenderer {
    backend = { isWebGPUBackend: true };
    setClearColor = vi.fn();
    setSize = vi.fn();
    init() {
      events.push('renderer.init');
      return Promise.resolve();
    }
    setAnimationLoop(loop: ((time: number) => void) | null) {
      events.push(loop === null ? 'loop:stop' : 'loop:start');
      frameState.loop = loop;
      return Promise.resolve();
    }
    dispose() {
      events.push('renderer.dispose');
      return Promise.resolve();
    }
  }
  return { Color, Scene, PerspectiveCamera, Timer, WebGPURenderer };
});

vi.mock('./scene/coins/index.ts', () => ({
  CoinField: class {
    object = {};
    update = () => {
      frameState.coinUpdates += 1;
    };
    bake = () => events.push('coins.bake');
    setCastShadows = vi.fn();
    castShadowsFrom = vi.fn();
    dispose = vi.fn();
  },
  watchGpuLoss: () => ({ loss: null, stop: vi.fn() }),
}));

vi.mock('./scene/quality/index.ts', async () => {
  const tiers = await vi.importActual<typeof Tiers>('./scene/quality/tiers.ts');
  return {
    DEFAULT_RENDER_LOOK: { exposure: 1, environmentIntensity: 1, shadows: true },
    qualityOverrideFrom: tiers.qualityOverrideFrom,
    createAdaptiveRendering: () => {
      events.push('quality:picked');
      return Promise.resolve({
        profile: tiers.QUALITY_PROFILES.low,
        post: { setLook: vi.fn() },
        governor: { suspend: frameState.suspend },
        render: () => {
          events.push('frame:drawn');
          if (rendererBehaviour.failFirstFrame) throw new Error('first frame failed');
          if (rendererBehaviour.failNextFrame) {
            rendererBehaviour.failNextFrame = false;
            throw new Error('frame failed');
          }
        },
        dispose: () => events.push('adaptive.dispose'),
      });
    },
  };
});

const { createStage, STAGE_BOOT_STEPS } = await import('./stage.ts');

class FakeResizeObserver {
  observe = vi.fn();
  disconnect = vi.fn();
}

function fakeCanvas(): HTMLCanvasElement {
  const canvas = {
    clientWidth: 390,
    clientHeight: 844,
    attributes: [],
    setAttribute: vi.fn(),
    replaceWith: vi.fn(),
  };
  return canvas as unknown as HTMLCanvasElement;
}

const COINS = { capacity: 8, radius: 0.17 };

beforeEach(() => {
  events.length = 0;
  rendererBehaviour.failFirstFrame = false;
  rendererBehaviour.failNextFrame = false;
  frameState.loop = null;
  frameState.coinUpdates = 0;
  frameState.suspend.mockClear();
  performance.clearMarks();
  vi.stubGlobal('document', { createElement: fakeCanvas });
  vi.stubGlobal('window', {});
  vi.stubGlobal('location', { search: '' });
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  const mark = performance.mark.bind(performance);
  vi.spyOn(performance, 'mark').mockImplementation((name, options) => {
    events.push(`mark:${name}`);
    return mark(name, options);
  });
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  performance.clearMarks();
});

function bootMarks(): string[] {
  return performance
    .getEntriesByType('mark')
    .map((entry) => entry.name)
    .filter((name) => name.startsWith('coinposh:boot:'));
}

describe('createStage boot marks', () => {
  it('marks renderer init, the quality pick and the first compiled frame, in that order', async () => {
    const stage = await createStage(fakeCanvas(), { coins: COINS });
    expect(STAGE_BOOT_STEPS).toEqual(['renderer-init', 'benchmark', 'first-compile']);
    expect(bootMarks()).toEqual([
      'coinposh:boot:renderer-init',
      'coinposh:boot:benchmark',
      'coinposh:boot:first-compile',
    ]);
    expect(stage.profile).toBe(QUALITY_PROFILES.low);
    await stage.dispose();
  });

  it('places each mark right after the step it times, and starts the loop after the first frame', async () => {
    const stage = await createStage(fakeCanvas(), { coins: COINS });
    expect(events).toEqual([
      'renderer.init',
      'mark:coinposh:boot:renderer-init',
      'quality:picked',
      'mark:coinposh:boot:benchmark',
      'coins.bake',
      'frame:drawn',
      'mark:coinposh:boot:first-compile',
      'loop:start',
    ]);
    await stage.dispose();
  });

  it('releases the renderer and skips the first-compile mark when the first frame throws', async () => {
    rendererBehaviour.failFirstFrame = true;
    await expect(createStage(fakeCanvas(), { coins: COINS })).rejects.toThrow('first frame failed');
    expect(bootMarks()).not.toContain('coinposh:boot:first-compile');
    expect(events).toContain('adaptive.dispose');
    expect(events).toContain('renderer.dispose');
    expect(events).not.toContain('loop:start');
    expect(console.warn).toHaveBeenCalledWith(
      '[CoinPosh] WebGPU renderer failed to start, retrying on WebGL2',
      expect.any(Error),
    );
  });
});

function runLoopFrame(time = 16): void {
  if (frameState.loop === null) throw new Error('The animation loop is not running.');
  frameState.loop(time);
}

describe('Stage.drawFrame', () => {
  it('draws a still frame without advancing the stage and suspends the governor', async () => {
    const stage = await createStage(fakeCanvas(), { coins: COINS });
    const listener = vi.fn();
    stage.onFrame(listener);
    const coinUpdatesBefore = frameState.coinUpdates;
    const drawn = stage.drawFrame();
    events.length = 0;

    runLoopFrame();

    await expect(drawn).resolves.toBeUndefined();
    expect(events).toEqual(['frame:drawn']);
    expect(listener).not.toHaveBeenCalled();
    expect(frameState.coinUpdates).toBe(coinUpdatesBefore);
    expect(frameState.suspend).toHaveBeenCalledTimes(1);
    await stage.dispose();
  });

  it('advances the stage on a frame nobody waits on, without suspending the governor', async () => {
    const stage = await createStage(fakeCanvas(), { coins: COINS });
    const listener = vi.fn();
    stage.onFrame(listener);
    const coinUpdatesBefore = frameState.coinUpdates;

    runLoopFrame();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(frameState.coinUpdates).toBe(coinUpdatesBefore + 1);
    expect(frameState.suspend).not.toHaveBeenCalled();
    await stage.dispose();
  });

  it('rejects every waiter with the error of a still frame that fails to render, then rethrows it', async () => {
    const stage = await createStage(fakeCanvas(), { coins: COINS });
    const first = stage.drawFrame();
    const second = stage.drawFrame();
    rendererBehaviour.failNextFrame = true;

    expect(() => {
      runLoopFrame();
    }).toThrow('frame failed');

    await expect(first).rejects.toThrow('frame failed');
    await expect(second).rejects.toThrow('frame failed');
    expect(frameState.suspend).not.toHaveBeenCalled();
    await stage.dispose();
  });

  it('settles a waiter only once: the frame after a still frame advances again', async () => {
    const stage = await createStage(fakeCanvas(), { coins: COINS });
    const listener = vi.fn();
    stage.onFrame(listener);
    const drawn = stage.drawFrame();
    runLoopFrame(16);
    await drawn;

    runLoopFrame(32);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(frameState.suspend).toHaveBeenCalledTimes(1);
    await stage.dispose();
  });

  it('resolves a pending waiter on dispose, and resolves at once once disposed', async () => {
    const stage = await createStage(fakeCanvas(), { coins: COINS });
    const pending = stage.drawFrame();

    await stage.dispose();

    await expect(pending).resolves.toBeUndefined();
    events.length = 0;
    await expect(stage.drawFrame()).resolves.toBeUndefined();
    expect(events).toEqual([]);
  });
});
