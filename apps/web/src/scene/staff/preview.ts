import { STAFF_ROLES, type StaffRole, type StaffStatus } from '@coinposh/shared';
import { PerspectiveCamera, Scene, Vector3, WebGPURenderer } from 'three/webgpu';
import { detectBackend } from '../../backend.ts';
import { createPostPipeline } from '../post/postPipeline.ts';
import { pixelRatioFor, QUALITY_PROFILES, qualityOverrideFrom } from '../quality/tiers.ts';
import { createRivieraVenue, RIVIERA_TABLE } from '../venues/riviera/index.ts';
import { createStaffFigure, type StaffFigure } from './index.ts';

/**
 * Dev-only capture bench for the staff, served by Vite at /src/scene/staff/preview.html. The
 * household stands on the table's playfield under the venue's light and post grade, on a manual
 * clock a capture script drives through `window.__staff`. Flags: `webgl`, `reduced`,
 * `quality=<tier>`, `role=<role>` (one figure, close up), `status=<status>` and `view=close`.
 */
interface StaffBench {
  ready: boolean;
  backend: string;
  error?: string;
  /** Starts every figure's action from the next frame. */
  act(): void;
  setStatus(status: StaffStatus): void;
  /** Sets the clock to `t` seconds and renders `frames` frames there. */
  seek(t: number, frames?: number): Promise<void>;
}

declare global {
  interface Window {
    __staff?: StaffBench;
  }
}

const params = new URLSearchParams(location.search);
const reduced = params.has('reduced');
const quality = QUALITY_PROFILES[qualityOverrideFrom(location.search) ?? 'high'];
const only = params.get('role');
const roles: readonly StaffRole[] = STAFF_ROLES.filter((role) => only === null || role === only);
const statusFlag = params.get('status');
const status: StaffStatus =
  statusFlag === 'onLeave' || statusFlag === 'vacant' ? statusFlag : 'employed';
const close = params.get('view') === 'close' || roles.length === 1;
const STAND = new Vector3(0, 0, RIVIERA_TABLE.fieldFrontZ - 0.06);

async function boot(bench: StaffBench): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#preview');
  if (!canvas) throw new Error('staff preview.html is missing #preview');
  const renderer = new WebGPURenderer({
    canvas,
    antialias: false,
    forceWebGL: params.has('webgl'),
  });
  await renderer.init();
  bench.backend = detectBackend(renderer.backend);
  const scene = new Scene();
  const camera = new PerspectiveCamera(30, 1, 0.01, 120);
  const venue = await createRivieraVenue(scene, null, {
    reducedMotion: reduced,
    quality: quality.venueDetail,
  });
  const post = createPostPipeline(renderer, scene, camera, quality, { reducedMotion: reduced });
  post.setLook(venue.look);
  const width = Math.max(canvas.clientWidth, 1);
  const height = Math.max(canvas.clientHeight, 1);
  renderer.setPixelRatio(pixelRatioFor(quality, devicePixelRatio));
  renderer.setSize(width, height, false);
  camera.aspect = width / height;

  const spacing = 0.05;
  const figures: StaffFigure[] = roles.map((role, i) => {
    const slot = i - (roles.length - 1) / 2;
    const figure = createStaffFigure(role, {
      status,
      reducedMotion: reduced,
      quality: quality.tier,
      phase: i * 1.7,
    });
    figure.object3d.position.copy(STAND).add(new Vector3(slot * spacing, 0, 0));
    figure.object3d.rotation.y = slot * -0.25;
    scene.add(figure.object3d);
    return figure;
  });

  const fit = close ? { width: 0.07, height: 0.09 } : { width: 0.17, height: 0.1 };
  const target = new Vector3(0, 0.04, 0).add(STAND);
  const halfFov = (camera.fov * Math.PI) / 360;
  const distance = Math.max(
    fit.height / 2 / Math.tan(halfFov),
    fit.width / 2 / (Math.tan(halfFov) * camera.aspect),
  );
  const direction = new Vector3(0.3, 0.32, 1).normalize();
  camera.position.copy(target).addScaledVector(direction, distance);
  camera.lookAt(target);
  camera.updateProjectionMatrix();

  let t = 0;
  let clockMs = 0;
  let resolveFrame: (() => void) | null = null;
  await renderer.setAnimationLoop(() => {
    for (const figure of figures) figure.update(t);
    venue.update(1 / 60);
    post.render((clockMs += 1000 / 60));
    const done = resolveFrame;
    resolveFrame = null;
    done?.();
  });
  const nextFrame = (): Promise<void> =>
    new Promise((resolve) => {
      resolveFrame = resolve;
    });
  await venue.environmentReady;
  for (let i = 0; i < 20; i++) await nextFrame();

  bench.act = () => {
    for (const figure of figures) figure.act();
  };
  bench.setStatus = (next) => {
    for (const figure of figures) figure.setStatus(next);
  };
  bench.seek = async (time, frames = 1) => {
    t = time;
    for (let i = 0; i < frames; i++) await nextFrame();
  };
  bench.ready = true;
}

const bench: StaffBench = {
  ready: false,
  backend: '',
  act: () => undefined,
  setStatus: () => undefined,
  seek: () => Promise.reject(new Error('The staff bench is still booting')),
};
window.__staff = bench;
boot(bench).catch((error: unknown) => {
  bench.error = error instanceof Error ? error.message : String(error);
  console.error('[staff preview] boot failed', error);
});
