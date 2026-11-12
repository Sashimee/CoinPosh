import { RARITIES, type Rarity } from '@coinposh/shared';
import i18next from 'i18next';
import {
  Mesh,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGPURenderer,
  type Object3D,
} from 'three/webgpu';
import { detectBackend } from '../../../backend.ts';
import { createPostPipeline } from '../../../scene/post/postPipeline.ts';
import {
  pixelRatioFor,
  QUALITY_PROFILES,
  qualityOverrideFrom,
} from '../../../scene/quality/tiers.ts';
import { applyCameraPreset, createRivieraVenue } from '../../../scene/venues/riviera/index.ts';
import { createVfx } from '../../index.ts';
import { UnboxCinematic } from './cinematic.ts';
import { UNBOX_HEROES } from './hero.ts';
import { UnboxAssets } from './stage.ts';

/**
 * Dev-only capture bench for the crate unbox, served by Vite at
 * /src/vfx/cinematics/unbox/preview.html. It mounts the venue, the post pass and the juice the
 * way the table does, builds the unbox assets at boot like the director, then steps the
 * cinematic frame by frame on `window.__unbox.step(dt)` so a capture script can screenshot and
 * measure each frame. Flags: `webgl`, `reduced`, `rarity=<rarity>`, `overlay` (draws the
 * measured crate box), `hero=<hero>` (the prop on the pedestal, charm by default),
 * `quality=<tier>` (the quality profile and its pixel-ratio cap, high by default) and `cold`
 * (builds the assets on the first unbox frame instead, as before the primer, to show the stall
 * it removes).
 */
interface FrameRecord {
  readonly index: number;
  readonly elapsedMs: number;
  /** Crate body and lid extent in NDC, as the GPU draws them through the kicked camera. */
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly widthShare: number;
  readonly heightShare: number;
  readonly onScreen: boolean;
  readonly lidBurst: boolean;
  readonly flare: number;
  readonly flashStretch: number;
  readonly flashes: number;
  readonly renderMs: number;
  /** Main-thread time spent building the cinematic, on the mount frame only. */
  readonly mountMs: number;
  readonly cardShown: boolean;
  /** The hero prop's extent in NDC, for luminance probes of the reveal. */
  readonly hero: { minX: number; maxX: number; minY: number; maxY: number };
}

interface UnboxBench {
  ready: boolean;
  backend: string;
  primed: boolean;
  error?: string;
  frames: FrameRecord[];
  start(): Promise<FrameRecord>;
  step(dt: number): Promise<FrameRecord>;
  readonly cardShown: boolean;
}

declare global {
  interface Window {
    __unbox?: UnboxBench;
  }
}

const params = new URLSearchParams(location.search);
const reduced = params.has('reduced');
const rarity: Rarity = RARITIES.find((r) => r === params.get('rarity')) ?? 'legendary';
const cold = params.has('cold');
const hero = UNBOX_HEROES.find((h) => h === params.get('hero')) ?? 'charm';
const quality = QUALITY_PROFILES[qualityOverrideFrom(location.search) ?? 'high'];
document.body.toggleAttribute('data-overlay', params.has('overlay'));

const vertex = new Vector3();

function extent(crate: Object3D, camera: PerspectiveCamera) {
  crate.updateWorldMatrix(true, true);
  camera.updateMatrixWorld();
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  crate.traverseVisible((object) => {
    if (!(object instanceof Mesh)) return;
    const { geometry, matrixWorld } = object as Mesh;
    const positions = geometry.getAttribute('position');
    for (let i = 0; i < positions.count; i++) {
      vertex.fromBufferAttribute(positions, i).applyMatrix4(matrixWorld).project(camera);
      minX = Math.min(minX, vertex.x);
      maxX = Math.max(maxX, vertex.x);
      minY = Math.min(minY, vertex.y);
      maxY = Math.max(maxY, vertex.y);
    }
  });
  return { minX, maxX, minY, maxY };
}

async function boot(bench: UnboxBench): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#preview');
  const box = document.querySelector<HTMLElement>('#bbox');
  if (!canvas || !box) throw new Error('unbox preview.html is missing #preview or #bbox');
  await i18next.init({ lng: 'en', fallbackLng: 'en', resources: {} });
  const renderer = new WebGPURenderer({
    canvas,
    antialias: false,
    forceWebGL: params.has('webgl'),
  });
  await renderer.init();
  const backend = detectBackend(renderer.backend);
  bench.backend = backend;
  const scene = new Scene();
  const camera = new PerspectiveCamera(42, 1, 0.05, 120);
  const venue = await createRivieraVenue(scene, renderer, {
    reducedMotion: reduced,
    quality: quality.venueDetail,
  });
  venue.setPusherStroke(0.35);
  const post = createPostPipeline(renderer, scene, camera, quality, {
    reducedMotion: reduced,
  });
  const width = Math.max(canvas.clientWidth, 1);
  const height = Math.max(canvas.clientHeight, 1);
  renderer.setPixelRatio(pixelRatioFor(quality, devicePixelRatio));
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  applyCameraPreset(camera, venue.cameraPreset(camera.aspect));
  camera.updateProjectionMatrix();
  const vfx = createVfx({
    scene,
    camera,
    renderer,
    backend,
    i18n: i18next,
    quality: quality.tier,
    reducedMotion: reduced,
    post,
    seed: 42,
  });
  await vfx.warmup(() => {
    post.render(performance.now());
  });

  let assets = cold ? null : new UnboxAssets(scene);
  let unbox: UnboxCinematic | null = null;
  let cardShown = false;
  let clockMs = 0;
  let idleFrames = 0;
  const record = (renderMs: number, mountMs: number): FrameRecord => {
    if (!unbox) throw new Error('The unbox bench recorded a frame before start()');
    const e = extent(unbox.stage.crateObject, camera);
    const stats = vfx.stats;
    const frame: FrameRecord = {
      index: bench.frames.length,
      elapsedMs: unbox.elapsed,
      ...e,
      widthShare: (e.maxX - e.minX) / 2,
      heightShare: (e.maxY - e.minY) / 2,
      onScreen: e.minX >= -1 && e.maxX <= 1 && e.minY >= -1 && e.maxY <= 1,
      lidBurst: unbox.stage.lidVisible && unbox.pose.lidOpen > 0,
      flare: unbox.stage.flareLevel,
      flashStretch: stats.flashStretch,
      flashes: stats.flashes,
      renderMs,
      mountMs,
      cardShown,
      hero: unbox.stage.heroObject.visible
        ? extent(unbox.stage.heroObject, camera)
        : { minX: 0, maxX: 0, minY: 0, maxY: 0 },
    };
    box.style.left = `${((e.minX + 1) / 2) * width}px`;
    box.style.width = `${((e.maxX - e.minX) / 2) * width}px`;
    box.style.top = `${((1 - e.maxY) / 2) * height}px`;
    box.style.height = `${((e.maxY - e.minY) / 2) * height}px`;
    bench.frames.push(frame);
    return frame;
  };

  const mount = (): number => {
    if (unbox) throw new Error('The unbox bench plays one crate per page load');
    const marker = document.createElement('div');
    marker.className = 'crate-reveal';
    document.body.append(marker);
    const begin = performance.now();
    assets ??= new UnboxAssets(scene);
    unbox = new UnboxCinematic({
      parent: scene,
      assets,
      camera,
      framing: (aspect) => venue.cameraPreset(aspect),
      at: new Vector3(0.01, -0.075, 0.4),
      rarity,
      hero,
      reducedMotion: reduced,
      vfx,
      onBeat: (beat) => {
        if (beat.kind === 'reveal') cardShown = true;
      },
    });
    return performance.now() - begin;
  };

  /** One request per animation frame: the post pass only renders anew on a new frame. */
  let pending: { readonly dt: number | null; resolve(frame: FrameRecord): void } | null = null;
  await renderer.setAnimationLoop(() => {
    const request = pending;
    pending = null;
    if (!request) {
      if (unbox) return;
      const effect = vfx.update(1 / 60);
      venue.update(effect);
      post.render((clockMs += 1000 / 60));
      if (++idleFrames >= IDLE_FRAMES) bench.ready = true;
      return;
    }
    let mountMs = 0;
    if (request.dt === null) {
      mountMs = mount();
    } else if (unbox) {
      clockMs += request.dt * 1000;
      const effect = vfx.update(request.dt);
      unbox.update(effect);
      venue.update(effect);
    }
    const begin = performance.now();
    post.render(clockMs);
    request.resolve(record(performance.now() - begin, mountMs));
  });
  const ask = (dt: number | null): Promise<FrameRecord> => {
    if (pending) throw new Error('The unbox bench takes one frame request at a time');
    if (dt !== null && !unbox) throw new Error('Call __unbox.start() before step()');
    return new Promise((resolve) => {
      pending = { dt, resolve };
    });
  };
  bench.start = () => ask(null);
  bench.step = (dt) => ask(dt);
  Object.defineProperty(bench, 'primed', { get: () => assets !== null && !assets.priming });
  Object.defineProperty(bench, 'cardShown', { get: () => cardShown });
}

/** Table frames drawn before the bench reports ready, as the table runs before a crate falls. */
const IDLE_FRAMES = 30;

const bench: UnboxBench = {
  ready: false,
  backend: '',
  primed: false,
  frames: [],
  start: () => Promise.reject(new Error('The unbox bench is still booting')),
  step: () => Promise.reject(new Error('The unbox bench is still booting')),
  cardShown: false,
};
window.__unbox = bench;
boot(bench).catch((error: unknown) => {
  bench.error = error instanceof Error ? error.message : String(error);
  console.error('[unbox preview] boot failed', error);
});
