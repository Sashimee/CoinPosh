import { Color, PerspectiveCamera, Scene, WebGPUBackend, WebGPURenderer } from 'three/webgpu';
import { detectBackend, fallbackBackend, reportBackend, type RenderBackend } from './backend.ts';

const MAX_PIXEL_RATIO = 2;
// Right after a device loss the GPU process is still restarting and getContext('webgl2')
// returns null for a moment, so the rebuild backs off instead of giving up on the first try.
const REBUILD_RETRY_DELAYS_MS = [0, 250, 500, 1000, 2000] as const;

export interface Stage {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: WebGPURenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly backend: RenderBackend;
  dispose(): Promise<void>;
}

interface ActiveRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: WebGPURenderer;
  readonly backend: RenderBackend;
  readonly observer: ResizeObserver;
  stopped: boolean;
}

export async function createStage(canvas: HTMLCanvasElement): Promise<Stage> {
  const scene = new Scene();
  scene.background = new Color(0x000000);
  const camera = new PerspectiveCamera(40, 1, 0.1, 100);
  let disposed = false;
  let active: ActiveRenderer;

  const rebuild = async (lost: ActiveRenderer, next: RenderBackend): Promise<void> => {
    await stopRenderer(lost);
    let target = lost.canvas;
    for (const delay of REBUILD_RETRY_DELAYS_MS) {
      await wait(delay);
      if (disposed) return;
      target = replaceCanvas(target);
      try {
        active = await startRenderer(target, next, scene, camera, onDeviceLost);
        return;
      } catch (error) {
        console.warn(`[CoinPosh] ${next} restart failed, retrying`, error);
      }
    }
    throw new Error(
      `${next} could not start after ${REBUILD_RETRY_DELAYS_MS.length} attempts; reload the page`,
    );
  };

  const onDeviceLost = (lost: ActiveRenderer, next: RenderBackend): void => {
    if (disposed) return;
    void rebuild(lost, next).catch((error: unknown) => {
      console.error('CoinPosh: the renderer lost its GPU device and could not restart.', error);
    });
  };

  const start = async (
    target: HTMLCanvasElement,
    attempt: RenderBackend,
  ): Promise<ActiveRenderer> => {
    try {
      return await startRenderer(target, attempt, scene, camera, onDeviceLost);
    } catch (error) {
      const next = fallbackBackend(attempt);
      if (next === null) throw error;
      console.warn('[CoinPosh] WebGPU renderer failed to start, retrying on WebGL2', error);
      return startRenderer(replaceCanvas(target), next, scene, camera, onDeviceLost);
    }
  };

  active = await start(canvas, 'webgpu');

  return {
    get canvas() {
      return active.canvas;
    },
    get renderer() {
      return active.renderer;
    },
    get backend() {
      return active.backend;
    },
    scene,
    camera,
    async dispose() {
      disposed = true;
      await stopRenderer(active);
    },
  };
}

async function startRenderer(
  canvas: HTMLCanvasElement,
  attempt: RenderBackend,
  scene: Scene,
  camera: PerspectiveCamera,
  onDeviceLost: (lost: ActiveRenderer, next: RenderBackend) => void,
): Promise<ActiveRenderer> {
  const renderer = new WebGPURenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
    forceWebGL: attempt === 'webgl2',
  });
  renderer.setClearColor(0x000000, 1);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
  try {
    await renderer.init();
  } catch (error) {
    await renderer.dispose();
    throw error;
  }

  const backend = detectBackend(renderer.backend);
  reportBackend(backend);

  const resize = (): void => {
    const width = Math.max(canvas.clientWidth, 1);
    const height = Math.max(canvas.clientHeight, 1);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  const active: ActiveRenderer = { canvas, renderer, backend, observer, stopped: false };
  const next = fallbackBackend(backend);
  const gpuBackend = renderer.backend;
  if (
    next !== null &&
    gpuBackend instanceof WebGPUBackend &&
    'device' in gpuBackend &&
    gpuBackend.device instanceof GPUDevice
  ) {
    const device = gpuBackend.device;
    const fallBack = (message: string): void => {
      if (active.stopped) return;
      console.warn(`[CoinPosh] WebGPU device lost (${message}), rebuilding on WebGL2`);
      onDeviceLost(active, next);
    };
    renderer.onDeviceLost = (info) => {
      fallBack(info.message);
    };
    // three skips onDeviceLost when the reason is 'destroyed', but browsers also destroy
    // devices they reclaim (seen in headless Chromium), so the device itself is watched too.
    void device.lost.then((info) => {
      fallBack(info.message);
    });
  }

  await renderer.setAnimationLoop(() => {
    renderer.render(scene, camera);
  });
  return active;
}

async function stopRenderer(active: ActiveRenderer): Promise<void> {
  active.stopped = true;
  active.observer.disconnect();
  await active.renderer.setAnimationLoop(null);
  await active.renderer.dispose();
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A canvas that has handed out a WebGPU context returns null for getContext('webgl2'),
// so the WebGL2 renderer needs a fresh element in the same DOM slot.
function replaceCanvas(old: HTMLCanvasElement): HTMLCanvasElement {
  const fresh = document.createElement('canvas');
  for (const { name, value } of Array.from(old.attributes)) {
    fresh.setAttribute(name, value);
  }
  old.replaceWith(fresh);
  return fresh;
}
