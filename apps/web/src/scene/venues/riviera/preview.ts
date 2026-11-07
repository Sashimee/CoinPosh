import {
  CylinderGeometry,
  Mesh,
  MeshPhysicalNodeMaterial,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  Timer,
  Vector3,
  WebGPURenderer,
  type Object3D,
} from 'three/webgpu';
import {
  applyCameraPreset,
  applyRivieraRendererSettings,
  createRivieraVenue,
  type RivieraQualityTier,
} from './index.ts';
import { RIVIERA_TABLE } from './layout.ts';
import { rivieraTokens } from './palette.ts';

/**
 * Dev-only look-dev harness for the venue, served by Vite at
 * /src/scene/venues/riviera/preview.html. Query flags: `webgl` forces the WebGL2 backend,
 * `t=<s>` freezes time there, `stroke=<0..1>` sets the pusher, `coins` drops stand-in coins
 * for scale, `probe` adds a chrome sphere to check environment alignment, and
 * `cam=x,y,z&look=x,y,z&fov=n` overrides the preset camera, and `env=<n>` / `lights=<n>`
 * override the environment intensity and scale the venue lights for look-dev, and
 * `quality=high|medium|low` picks a render tier. `gpu` enables GPU timestamp queries where the
 * backend supports them; `frameMs` is CPU submit time and `intervalMs` the smoothed time
 * between frames, which includes GPU time once the GPU is the bottleneck.
 */
interface PreviewStats {
  ready: boolean;
  backend: string;
  drawCalls: number;
  triangles: number;
  frameMs: number;
  intervalMs: number;
  gpuMs: number | null;
  quality: string;
  error?: string;
}

declare global {
  interface Window {
    __preview?: PreviewStats;
  }
}

const params = new URLSearchParams(location.search);
const stats: PreviewStats = {
  ready: false,
  backend: '',
  drawCalls: 0,
  triangles: 0,
  frameMs: 0,
  intervalMs: 0,
  gpuMs: null,
  quality: '',
};

function qualityParam(): RivieraQualityTier {
  const raw = params.get('quality') ?? 'high';
  if (raw !== 'high' && raw !== 'medium' && raw !== 'low') {
    throw new Error(`Preview flag quality must be high, medium or low, got "${raw}"`);
  }
  return raw;
}
window.__preview = stats;

function vectorParam(name: string): Vector3 | null {
  const raw = params.get(name);
  if (!raw) return null;
  const parts = raw.split(',').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`Preview flag ${name} must be three comma-separated numbers, got "${raw}"`);
  }
  return new Vector3(parts[0], parts[1], parts[2]);
}

function standInCoins(): Object3D[] {
  const material = new MeshPhysicalNodeMaterial({
    color: rivieraTokens['gold-brushed'],
    metalness: 1,
    roughness: 0.22,
  });
  const geometry = new CylinderGeometry(0.0195, 0.0195, 0.0036, 40);
  const coins: Object3D[] = [];
  let seed = 7;
  const random = (): number => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 70; i += 1) {
    const coin = new Mesh(geometry, material);
    const onPusher = i < 14;
    const x = (random() * 2 - 1) * (RIVIERA_TABLE.fieldHalfWidth - 0.03);
    const z = onPusher ? -0.33 - random() * 0.15 : -0.2 + random() * 0.54;
    const y = (onPusher ? RIVIERA_TABLE.pusherHeight : 0) + 0.0018 + (random() < 0.2 ? 0.0036 : 0);
    coin.position.set(x, y, z);
    coin.rotation.set((random() - 0.5) * 0.06, random() * Math.PI, (random() - 0.5) * 0.06);
    coin.castShadow = true;
    coin.receiveShadow = true;
    coins.push(coin);
  }
  return coins;
}

async function boot(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#preview');
  if (!canvas) throw new Error('Preview canvas #preview is missing');
  const trackTimestamp = params.has('gpu');
  const renderer = new WebGPURenderer({
    canvas,
    antialias: true,
    forceWebGL: params.has('webgl'),
    trackTimestamp,
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  await renderer.init();
  stats.backend = 'isWebGPUBackend' in renderer.backend ? 'webgpu' : 'webgl2';

  const scene = new Scene();
  const camera = new PerspectiveCamera(42, 1, 0.05, 120);
  const quality = qualityParam();
  stats.quality = quality;
  applyRivieraRendererSettings(renderer);
  const venue = await createRivieraVenue(scene, renderer, {
    reducedMotion: params.has('reduced'),
    quality,
  });

  if (params.has('coins')) scene.add(...standInCoins());
  if (params.has('probe')) {
    const probe = new Mesh(
      new SphereGeometry(0.06, 48, 32),
      new MeshPhysicalNodeMaterial({ color: '#ffffff', metalness: 1, roughness: 0 }),
    );
    probe.position.set(0, 0.2, 0.05);
    scene.add(probe);
  }
  venue.setPusherStroke(Number(params.get('stroke') ?? 0.35));
  const envIntensity = params.get('env');
  if (envIntensity !== null) scene.environmentIntensity = Number(envIntensity);
  const lightScale = params.get('lights');
  if (lightScale !== null) {
    const { key, rimWarm, rimCool, fill } = venue.lighting;
    for (const light of [key, rimWarm, rimCool, fill]) {
      light.intensity *= Number(lightScale);
    }
  }

  const frame = (): void => {
    const width = Math.max(canvas.clientWidth, 1);
    const height = Math.max(canvas.clientHeight, 1);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    applyCameraPreset(camera, venue.cameraPreset(camera.aspect));
    const cam = vectorParam('cam');
    const look = vectorParam('look');
    if (cam) camera.position.copy(cam);
    if (cam || look) camera.lookAt(look ?? new Vector3(0, 0.04, -0.08));
    const fov = params.get('fov');
    if (fov) camera.fov = Number(fov);
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(frame).observe(canvas);
  frame();

  const frozen = params.get('t');
  if (frozen !== null) {
    for (let left = Number(frozen); left > 0; left -= 0.25) venue.update(Math.min(left, 0.25));
  }

  const timer = new Timer();
  let smoothed = 0;
  let interval = 0;
  let last = 0;
  let resolving = false;
  await renderer.setAnimationLoop((now: number) => {
    if (last !== 0) interval = interval === 0 ? now - last : interval * 0.9 + (now - last) * 0.1;
    last = now;
    stats.intervalMs = interval;
    timer.update(now);
    const dt = timer.getDelta();
    if (frozen === null) venue.update(dt);
    const start = performance.now();
    renderer.render(scene, camera);
    const ms = performance.now() - start;
    smoothed = smoothed === 0 ? ms : smoothed * 0.9 + ms * 0.1;
    stats.frameMs = smoothed;
    stats.drawCalls = renderer.info.render.drawCalls;
    stats.triangles = renderer.info.render.triangles;
    stats.ready = true;
    if (trackTimestamp && !resolving) {
      resolving = true;
      void renderer
        .resolveTimestampsAsync()
        .then(() => {
          const gpu = renderer.info.render.timestamp;
          if (gpu > 0) stats.gpuMs = gpu;
        })
        .finally(() => {
          resolving = false;
        });
    }
  });
}

boot().catch((error: unknown) => {
  stats.error = error instanceof Error ? error.message : String(error);
  console.error('Riviera preview failed to start', error);
});
