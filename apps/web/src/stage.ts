import { Color, PerspectiveCamera, Scene, WebGPURenderer } from 'three/webgpu';
import { detectBackend, reportBackend, type RenderBackend } from './backend.ts';

const MAX_PIXEL_RATIO = 2;

export interface Stage {
  readonly renderer: WebGPURenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly backend: RenderBackend;
  dispose(): Promise<void>;
}

export async function createStage(canvas: HTMLCanvasElement): Promise<Stage> {
  const renderer = new WebGPURenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setClearColor(0x000000, 1);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
  await renderer.init();

  const backend = detectBackend(renderer.backend);
  reportBackend(backend);

  const scene = new Scene();
  scene.background = new Color(0x000000);
  const camera = new PerspectiveCamera(40, 1, 0.1, 100);

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

  await renderer.setAnimationLoop(() => {
    renderer.render(scene, camera);
  });

  return {
    renderer,
    scene,
    camera,
    backend,
    async dispose() {
      observer.disconnect();
      await renderer.setAnimationLoop(null);
      await renderer.dispose();
    },
  };
}
