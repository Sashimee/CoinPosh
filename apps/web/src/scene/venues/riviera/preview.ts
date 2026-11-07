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
import { applyCameraPreset, createRivieraVenue, type RivieraQuality } from './index.ts';
import { RIVIERA_TABLE } from './layout.ts';
import { rivieraTokens } from './palette.ts';

/**
 * Dev-only look-dev harness for the venue, served by Vite at
 * /src/scene/venues/riviera/preview.html. Query flags: `webgl` forces the WebGL2 backend,
 * `t=<s>` freezes time there, `stroke=<0..1>` sets the pusher, `coins` drops stand-in coins
 * for scale, `probe` adds a chrome sphere to check environment alignment, and
 * `cam=x,y,z&look=x,y,z&fov=n` overrides the preset camera, and `env=<n>` / `lights=<n>`
 * override the environment intensity and scale the venue lights for look-dev. `quality=low`
 * builds the low tier.
 *
 * Timing: `frameMs` is the p50/p95 of the requestAnimationFrame interval over the last
 * {@link SAMPLE_WINDOW} frames (what the player feels, capped by vsync). With `gpu`, `gpuMs`
 * is the p50/p95 of the GPU render-pass time from timestamp queries; it stays null where the
 * backend lacks `timestamp-query` / `EXT_disjoint_timer_query_webgl2`.
 */
interface Percentiles {
  p50: number;
  p95: number;
}

interface PreviewStats {
  ready: boolean;
  backend: string;
  quality: RivieraQuality;
  drawCalls: number;
  triangles: number;
  frames: number;
  frameMs: Percentiles | null;
  gpuMs: Percentiles | null;
  error?: string;
}

const SAMPLE_WINDOW = 240;

declare global {
  interface Window {
    __preview?: PreviewStats;
  }
}

const params = new URLSearchParams(location.search);
const quality = params.get('quality') === 'low' ? 'low' : 'high';
const stats: PreviewStats = {
  ready: false,
  backend: '',
  quality,
  drawCalls: 0,
  triangles: 0,
  frames: 0,
  frameMs: null,
  gpuMs: null,
};
window.__preview = stats;

class SampleWindow {
  private readonly samples: number[] = [];

  push(value: number): void {
    this.samples.push(value);
    if (this.samples.length > SAMPLE_WINDOW) this.samples.shift();
  }

  percentiles(): Percentiles | null {
    if (this.samples.length === 0) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const at = (q: number): number =>
      sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN;
    return { p50: at(0.5), p95: at(0.95) };
  }
}

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
  const renderer = new WebGPURenderer({
    canvas,
    antialias: true,
    forceWebGL: params.has('webgl'),
    trackTimestamp: params.has('gpu'),
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  await renderer.init();
  stats.backend = 'isWebGPUBackend' in renderer.backend ? 'webgpu' : 'webgl2';
  const gpuTimed =
    params.has('gpu') &&
    renderer.hasFeature(
      stats.backend === 'webgpu' ? 'timestamp-query' : 'EXT_disjoint_timer_query_webgl2',
    );

  const scene = new Scene();
  const camera = new PerspectiveCamera(42, 1, 0.05, 120);
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
    for (const light of [
      venue.lighting.key,
      venue.lighting.rimWarm,
      venue.lighting.rimCool,
      venue.lighting.fill,
    ]) {
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
  const intervals = new SampleWindow();
  const gpuTimes = new SampleWindow();
  let previous: number | null = null;
  await renderer.setAnimationLoop((now: number) => {
    timer.update(now);
    const dt = timer.getDelta();
    if (frozen === null) venue.update(dt);
    if (previous !== null) intervals.push(now - previous);
    previous = now;
    renderer.render(scene, camera);
    if (gpuTimed) {
      void renderer.resolveTimestampsAsync('render').then((ms) => {
        if (ms !== undefined && ms > 0) gpuTimes.push(ms);
        stats.gpuMs = gpuTimes.percentiles();
      });
    }
    stats.frames += 1;
    stats.frameMs = intervals.percentiles();
    stats.drawCalls = renderer.info.render.drawCalls;
    stats.triangles = renderer.info.render.triangles;
    stats.ready = true;
  });
}

boot().catch((error: unknown) => {
  stats.error = error instanceof Error ? error.message : String(error);
  console.error('Riviera preview failed to start', error);
});
