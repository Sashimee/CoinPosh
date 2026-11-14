import { describe, expect, it, vi } from 'vitest';
import type { WebGPURenderer } from 'three/webgpu';
import {
  foilNeedsFrame,
  IDLE_FRAME_SECONDS,
  releaseRenderer,
  SurfacePool,
  type ReusableSurface,
} from './surface.ts';

/** Counts the GPU contexts its surfaces hold, as a browser would. */
function contextCounter() {
  let live = 0;
  let peak = 0;
  let started = 0;
  let resets = 0;
  const start = (): Promise<ReusableSurface> => {
    started += 1;
    live += 1;
    peak = Math.max(peak, live);
    let freed = false;
    const surface: ReusableSurface = {
      kind: 'webgl2',
      canvas: {} as HTMLCanvasElement,
      stamp: vi.fn(),
      flakes: vi.fn(),
      glints: vi.fn(),
      setPointer: vi.fn(),
      setClear: vi.fn(),
      setFade: vi.fn(),
      setTimeScale: vi.fn(),
      frame: vi.fn(),
      resize: vi.fn(),
      reset: () => {
        resets += 1;
      },
      dispose: () => {
        if (freed) throw new Error('surface freed twice');
        freed = true;
        live -= 1;
      },
    };
    return Promise.resolve(surface);
  };
  return {
    start,
    get resets() {
      return resets;
    },
    get live() {
      return live;
    },
    get peak() {
      return peak;
    },
    get started() {
      return started;
    },
  };
}

describe('scratch surface pool', () => {
  it('keeps one live context while the player works through a stack of cards', async () => {
    const contexts = contextCounter();
    const pool = new SurfacePool(contexts.start);
    for (let card = 0; card < 40; card++) {
      const surface = await pool.acquire();
      surface.stamp({ x: 0.5, y: 0.5 }, 0.1);
      surface.dispose();
    }
    expect(contexts.started).toBe(1);
    expect(contexts.peak).toBe(1);
    pool.drain();
    expect(contexts.live).toBe(0);
  });

  it('hands each card a whole foil: the surface is reset going out and coming back', async () => {
    const contexts = contextCounter();
    const pool = new SurfacePool(contexts.start);
    const first = await pool.acquire();
    expect(contexts.resets).toBe(1);
    first.dispose();
    expect(contexts.resets).toBe(2);
    const second = await pool.acquire();
    expect(second.canvas).toBe(first.canvas);
    expect(contexts.resets).toBe(3);
    second.dispose();
    pool.drain();
  });

  it('frees the extra surface of two cards open at once, keeping one', async () => {
    const contexts = contextCounter();
    const pool = new SurfacePool(contexts.start);
    const a = await pool.acquire();
    const b = await pool.acquire();
    expect(contexts.live).toBe(2);
    a.dispose();
    b.dispose();
    expect(contexts.live).toBe(1);
    pool.drain();
    expect(contexts.live).toBe(0);
  });

  it('ignores a closed card that keeps drawing on the surface it gave back', async () => {
    const contexts = contextCounter();
    const pool = new SurfacePool(contexts.start);
    const stale = await pool.acquire();
    stale.dispose();
    const fresh = await pool.acquire();
    stale.stamp({ x: 0.2, y: 0.2 }, 0.1);
    stale.frame(1 / 60);
    stale.dispose();
    expect(contexts.live).toBe(1);
    fresh.dispose();
    pool.drain();
  });

  it('lets a failed start through so the card can fall back', async () => {
    const pool = new SurfacePool(() => Promise.reject(new Error('no backend')));
    await expect(pool.acquire()).rejects.toThrow('no backend');
  });
});

describe('renderer release', () => {
  function renderer(backend: object) {
    return {
      backend,
      dispose: vi.fn(() => Promise.resolve()),
    } as unknown as Pick<WebGPURenderer, 'backend' | 'dispose'>;
  }

  it('loses the WebGL2 context three would leave alive on a canvas it did not make', async () => {
    const loseContext = vi.fn();
    const gl = {
      getExtension: (name: string) => (name === 'WEBGL_lose_context' ? { loseContext } : null),
    };
    const canvas = { width: 1140, height: 1140 };
    await releaseRenderer(renderer({ gl }), canvas);
    expect(loseContext).toHaveBeenCalledOnce();
    expect(canvas).toEqual({ width: 0, height: 0 });
  });

  it('leaves WebGPU to three, which destroys the device it requested', async () => {
    const getExtension = vi.fn();
    const canvas = { width: 600, height: 600 };
    await releaseRenderer(renderer({ isWebGPUBackend: true, gl: { getExtension } }), canvas);
    expect(getExtension).not.toHaveBeenCalled();
    expect(canvas).toEqual({ width: 0, height: 0 });
  });

  it('still loses the context when three fails to dispose', async () => {
    const loseContext = vi.fn();
    const broken = {
      backend: { gl: { getExtension: () => ({ loseContext }) } },
      dispose: () => Promise.reject(new Error('dispose failed')),
    } as unknown as Pick<WebGPURenderer, 'backend' | 'dispose'>;
    await expect(releaseRenderer(broken, { width: 1, height: 1 })).rejects.toThrow(
      'dispose failed',
    );
    expect(loseContext).toHaveBeenCalledOnce();
  });
});

describe('foil frame gate', () => {
  const idle = { stamps: 0, particles: 0, animating: false, sinceDraw: 0 };

  it('sleeps when only the sheen moves, between idle redraws', () => {
    expect(foilNeedsFrame(idle)).toBe(false);
    expect(foilNeedsFrame({ ...idle, sinceDraw: IDLE_FRAME_SECONDS * 0.9 })).toBe(false);
    expect(foilNeedsFrame({ ...idle, sinceDraw: IDLE_FRAME_SECONDS })).toBe(true);
  });

  it('draws every frame while there is scratching, flakes or a dissolve to show', () => {
    expect(foilNeedsFrame({ ...idle, stamps: 1 })).toBe(true);
    expect(foilNeedsFrame({ ...idle, particles: 3 })).toBe(true);
    expect(foilNeedsFrame({ ...idle, animating: true })).toBe(true);
  });
});
