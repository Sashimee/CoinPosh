import { PerspectiveCamera, Scene, Timer, Vector3, WebGPURenderer } from 'three/webgpu';
import {
  applyCameraPreset,
  createRivieraVenue,
  type EnvironmentSource,
} from '../venues/riviera/index.ts';
import { CHARM_KINDS, type CharmKind, type CharmView, isCharmKind } from './index.ts';
import { loadCharmViews } from './lazy.ts';

/**
 * Dev-only look-dev harness for the charms, served by Vite at
 * /src/scene/charms/preview.html: the six charms in a row on the Riviera table, lit by the
 * venue. Query flags: `kind=<id>` shows one charm close up, `act` activates every charm every
 * two seconds and `act=<s>` freezes `s` seconds into an activation (with `t`), `t=<s>`
 * freezes the idle clock, `reduced` plays the reduced-motion variants, `quality=low` builds
 * the low tier, `webgl` forces the WebGL2 backend, and `cam=x,y,z&look=x,y,z&fov=n`
 * overrides the camera.
 */
interface CharmPreviewStats {
  ready: boolean;
  environment: EnvironmentSource | 'loading';
  backend: string;
  drawCalls: number;
  triangles: number;
  frames: number;
  error?: string;
}

declare global {
  interface Window {
    __charmPreview?: CharmPreviewStats;
  }
}

const params = new URLSearchParams(location.search);
const quality = params.get('quality') === 'low' ? 'low' : 'high';
const reduced = params.has('reduced');
const stats: CharmPreviewStats = {
  ready: false,
  environment: 'loading',
  backend: '',
  drawCalls: 0,
  triangles: 0,
  frames: 0,
};
window.__charmPreview = stats;

const ROW_Z = -0.03;
const ROW_SPACING = 0.056;

function vectorParam(name: string): Vector3 | null {
  const raw = params.get(name);
  if (!raw) return null;
  const parts = raw.split(',').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`Preview flag ${name} must be three comma-separated numbers, got "${raw}"`);
  }
  return new Vector3(parts[0], parts[1], parts[2]);
}

function shownKinds(): readonly CharmKind[] {
  const kind = params.get('kind');
  if (kind === null) return CHARM_KINDS;
  if (!isCharmKind(kind))
    throw new Error(`Preview flag kind must be one of ${CHARM_KINDS.join(', ')}, got "${kind}"`);
  return [kind];
}

async function boot(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#preview');
  if (!canvas) throw new Error('Preview canvas #preview is missing');
  const renderer = new WebGPURenderer({ canvas, antialias: true, forceWebGL: params.has('webgl') });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  await renderer.init();
  stats.backend = 'isWebGPUBackend' in renderer.backend ? 'webgpu' : 'webgl2';

  const scene = new Scene();
  const camera = new PerspectiveCamera(30, 1, 0.01, 120);
  const venue = await createRivieraVenue(scene, renderer, { reducedMotion: reduced, quality });
  void venue.environmentReady.then((source) => {
    stats.environment = source;
  });
  venue.setPusherStroke(0.3);

  const { createCharmView } = await loadCharmViews();
  const kinds = shownKinds();
  const views: CharmView[] = kinds.map((kind, i) => {
    const view = createCharmView(kind, { quality, reducedMotion: reduced, phase: i * 1.37 });
    view.object3d.position.set((i - (kinds.length - 1) / 2) * ROW_SPACING, 0, ROW_Z);
    scene.add(view.object3d);
    return view;
  });

  const single = kinds.length === 1;
  const defaultCam = single
    ? new Vector3(0, 0.07, ROW_Z + 0.13)
    : new Vector3(0, 0.12, ROW_Z + 0.36);
  const defaultLook = new Vector3(0, single ? 0.02 : 0.018, ROW_Z);
  const frame = (): void => {
    const width = Math.max(canvas.clientWidth, 1);
    const height = Math.max(canvas.clientHeight, 1);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    applyCameraPreset(camera, venue.cameraPreset(camera.aspect));
    camera.position.copy(vectorParam('cam') ?? defaultCam);
    camera.lookAt(vectorParam('look') ?? defaultLook);
    camera.fov = Number(params.get('fov') ?? (single ? 32 : 30));
    camera.near = 0.01;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(frame).observe(canvas);
  frame();

  const frozen = params.get('t');
  const act = params.get('act');
  if (frozen !== null) {
    const t = Number(frozen);
    for (let left = t; left > 0; left -= 0.25) venue.update(Math.min(left, 0.25));
    if (act !== null && act !== '') {
      for (const view of views) {
        view.activate();
        view.setIdle(t - Number(act));
      }
    }
    for (const view of views) view.setIdle(t);
  }

  const timer = new Timer();
  let nextActivation = 0.6;
  await renderer.setAnimationLoop((now: number) => {
    timer.update(now);
    if (frozen === null) {
      const t = timer.getElapsed();
      venue.update(timer.getDelta());
      if (act !== null && t >= nextActivation) {
        for (const view of views) view.activate();
        nextActivation += 2;
      }
      for (const view of views) view.setIdle(t);
    }
    renderer.render(scene, camera);
    stats.frames += 1;
    stats.drawCalls = renderer.info.render.drawCalls;
    stats.triangles = renderer.info.render.triangles;
    stats.ready = stats.environment !== 'loading';
  });
}

boot().catch((error: unknown) => {
  stats.error = error instanceof Error ? error.message : String(error);
  console.error('Charm preview failed to start', error);
});
