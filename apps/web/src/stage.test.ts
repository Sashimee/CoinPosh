import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUALITY_PROFILES } from './scene/quality/tiers.ts';
import type * as Tiers from './scene/quality/tiers.ts';

const events: string[] = [];
const rendererBehaviour = { failFirstFrame: false };

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
    setAnimationLoop(loop: unknown) {
      events.push(loop === null ? 'loop:stop' : 'loop:start');
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
    update = vi.fn();
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
        render: () => {
          events.push('frame:drawn');
          if (rendererBehaviour.failFirstFrame) throw new Error('first frame failed');
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
