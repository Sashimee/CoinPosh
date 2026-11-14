import type { Rarity } from '@coinposh/shared';
import { PerspectiveCamera, Scene, Vector3, WebGPURenderer } from 'three/webgpu';
import { detectBackend } from '../../backend.ts';
import { createPostPipeline } from '../post/postPipeline.ts';
import { pixelRatioFor, QUALITY_PROFILES, qualityOverrideFrom } from '../quality/tiers.ts';
import { createRivieraVenue, RIVIERA_TABLE } from '../venues/riviera/index.ts';
import { createGachaMachine, type GachaEvent, type GachaTicker } from './index.ts';

/**
 * Dev-only capture bench for the capsule machine, served by Vite at
 * /src/scene/gacha/preview.html. The machine stands on the table's playfield under the venue's
 * key light and is graded by the post pass, and runs on a manual ticker so a capture script
 * drives it frame by frame through `window.__gacha`. Flags: `webgl`, `reduced`,
 * `quality=<tier>` and `view=hero|close` (the whole machine, or the tray and the opened capsule).
 */
interface GachaBench {
  ready: boolean;
  backend: string;
  error?: string;
  events: string[];
  crank(progress: number): void;
  dispense(rarity: Rarity): void;
  pop(rarity: Rarity): void;
  reset(): void;
  /** Advances the machine by `frames` steps of `dt` seconds, rendering each one. */
  step(dt: number, frames?: number): Promise<number>;
}

declare global {
  interface Window {
    __gacha?: GachaBench;
  }
}

const params = new URLSearchParams(location.search);
const reduced = params.has('reduced');
const quality = QUALITY_PROFILES[qualityOverrideFrom(location.search) ?? 'high'];
const close = params.get('view') === 'close';
const STAND = new Vector3(0, 0, RIVIERA_TABLE.fieldFrontZ - 0.12);

async function boot(bench: GachaBench): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#preview');
  if (!canvas) throw new Error('gacha preview.html is missing #preview');
  const renderer = new WebGPURenderer({
    canvas,
    antialias: false,
    forceWebGL: params.has('webgl'),
  });
  await renderer.init();
  bench.backend = detectBackend(renderer.backend);
  const scene = new Scene();
  const camera = new PerspectiveCamera(30, 1, 0.02, 120);
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

  const fit = close ? { width: 0.17, height: 0.15 } : { width: 0.34, height: 0.5 };
  const target = new Vector3(0, close ? 0.085 : 0.215, close ? 0.11 : 0.02).add(STAND);
  const halfFov = (camera.fov * Math.PI) / 360;
  const distance = Math.max(
    fit.height / 2 / Math.tan(halfFov),
    fit.width / 2 / (Math.tan(halfFov) * camera.aspect),
  );
  const direction = new Vector3(0.36, close ? 0.42 : 0.2, 1).normalize();
  camera.position.copy(target).addScaledVector(direction, distance);
  camera.lookAt(target);
  camera.updateProjectionMatrix();

  let now = 0;
  let frame: (() => void) | null = null;
  const ticker: GachaTicker = {
    now: () => now,
    request: (next) => {
      frame = next;
      return next;
    },
    cancel: () => {
      frame = null;
    },
  };
  const machine = createGachaMachine({
    reducedMotion: reduced,
    quality: quality.tier === 'low' ? 'low' : 'high',
    ticker,
    onEvent: (event: GachaEvent) => bench.events.push(event.kind),
  });
  machine.object3d.position.copy(STAND);
  machine.object3d.rotation.y = 0.1;
  scene.add(machine.object3d);

  let clockMs = 0;
  let resolveFrame: (() => void) | null = null;
  await renderer.setAnimationLoop(() => {
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

  const fail = (error: unknown): void => {
    bench.error = error instanceof Error ? error.message : String(error);
  };
  bench.crank = (progress) => {
    machine.crank(progress);
  };
  bench.dispense = (rarity) => {
    machine.dispense(rarity).catch(fail);
  };
  bench.pop = (rarity) => {
    machine.pop(rarity).catch(fail);
  };
  bench.reset = () => {
    machine.reset();
  };
  bench.step = async (dt, frames = 1) => {
    for (let i = 0; i < frames; i++) {
      now += dt * 1000;
      const run = frame;
      frame = null;
      run?.();
      await nextFrame();
    }
    return now;
  };
  bench.ready = true;
}

const bench: GachaBench = {
  ready: false,
  backend: '',
  events: [],
  crank: () => undefined,
  dispense: () => undefined,
  pop: () => undefined,
  reset: () => undefined,
  step: () => Promise.reject(new Error('The gacha bench is still booting')),
};
window.__gacha = bench;
boot(bench).catch((error: unknown) => {
  bench.error = error instanceof Error ? error.message : String(error);
  console.error('[gacha preview] boot failed', error);
});
