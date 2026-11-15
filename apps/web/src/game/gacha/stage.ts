import {
  ACESFilmicToneMapping,
  AmbientLight,
  DirectionalLight,
  HemisphereLight,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import { createGachaMachine, type GachaEvent, type GachaMachine } from '../../scene/gacha/index.ts';
import { releaseRenderer } from '../../vfx/scratch/surface.ts';

const FIT = { width: 0.36, height: 0.52 } as const;
const TARGET = new Vector3(0, 0.215, 0.02);
const DIRECTION = new Vector3(0.36, 0.2, 1).normalize();
const MAX_PIXEL_RATIO = 1.75;

export interface GachaStage {
  readonly machine: GachaMachine;
  readonly canvas: HTMLCanvasElement;
  resize(): void;
  dispose(): void;
}

export interface GachaStageOptions {
  readonly host: HTMLElement;
  readonly reducedMotion: boolean;
  readonly onEvent: (event: GachaEvent) => void;
}

async function startRenderer(host: HTMLElement): Promise<{
  renderer: WebGPURenderer;
  canvas: HTMLCanvasElement;
}> {
  let lastError: unknown = null;
  for (const forceWebGL of [false, true]) {
    const canvas = document.createElement('canvas');
    canvas.className = 'cp-gacha-canvas';
    host.append(canvas);
    const renderer = new WebGPURenderer({ canvas, alpha: true, antialias: true, forceWebGL });
    try {
      await renderer.init();
      return { renderer, canvas };
    } catch (error) {
      lastError = error;
      await releaseRenderer(renderer, canvas);
      canvas.remove();
    }
  }
  throw new Error('The capsule machine could not start WebGPU or WebGL2', { cause: lastError });
}

function lightScene(scene: Scene): void {
  scene.add(new HemisphereLight(0xfff3dc, 0x1b2340, 1.4));
  scene.add(new AmbientLight(0xffffff, 0.35));
  const key = new DirectionalLight(0xfff1d6, 2.6);
  key.position.set(0.6, 1.2, 1);
  const rim = new DirectionalLight(0xc8d8ff, 1.2);
  rim.position.set(-0.8, 0.6, -0.6);
  scene.add(key, rim);
}

/**
 * The capsule machine in its own small renderer inside the gacha sheet. It renders only while
 * the sheet is open, framed like the dev bench's hero view.
 */
export async function createGachaStage(options: GachaStageOptions): Promise<GachaStage> {
  const { renderer, canvas } = await startRenderer(options.host);
  renderer.toneMapping = ACESFilmicToneMapping;
  const scene = new Scene();
  lightScene(scene);
  const camera = new PerspectiveCamera(30, 1, 0.02, 20);
  const machine = createGachaMachine({
    reducedMotion: options.reducedMotion,
    quality: 'low',
    onEvent: options.onEvent,
  });
  machine.object3d.rotation.y = 0.1;
  scene.add(machine.object3d);

  const resize = () => {
    const width = Math.max(canvas.clientWidth, 1);
    const height = Math.max(canvas.clientHeight, 1);
    renderer.setPixelRatio(Math.min(devicePixelRatio, MAX_PIXEL_RATIO));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    const halfFov = (camera.fov * Math.PI) / 360;
    const distance = Math.max(
      FIT.height / 2 / Math.tan(halfFov),
      FIT.width / 2 / (Math.tan(halfFov) * camera.aspect),
    );
    camera.position.copy(TARGET).addScaledVector(DIRECTION, distance);
    camera.lookAt(TARGET);
    camera.updateProjectionMatrix();
  };
  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  await renderer.setAnimationLoop(() => {
    renderer.render(scene, camera);
  });

  let disposed = false;
  return {
    machine,
    canvas,
    resize,
    dispose() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      void renderer.setAnimationLoop(null);
      machine.dispose();
      void releaseRenderer(renderer, canvas).finally(() => {
        canvas.remove();
      });
    },
  };
}
