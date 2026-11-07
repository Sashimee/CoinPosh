// Dev-only turntable for the coin materials (served by `pnpm dev` at
// /src/scene/coins/lookdev/). Lighting here is a neutral studio stand-in; the real venue
// lighting and post stack live in scene/env and scene/post.
// It also rehearses GPU loss: a lost WebGPU device or WebGL context tears the stage down and
// rebuilds it on a fresh canvas with the WebGL2 backend (`?loseAfter=N` forces a loss after N
// frames). `verify.mjs` drives both paths headlessly.
import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  Color,
  DirectionalLight,
  Euler,
  Mesh,
  MeshPhysicalNodeMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Quaternion,
  Scene,
  WebGPURenderer,
} from 'three/webgpu';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { CoinField, type CoinFieldStats } from '../coin-field.ts';
import { NEAR_COIN_GEOMETRY } from '../geometry.ts';
import {
  acquireWebGL2Context,
  describeGpuLoss,
  watchGpuLoss,
  type CoinBackend,
  type GpuLossWatch,
} from '../gpu-health.ts';
import { COIN_TIER_IDS, isCoinTierId, type CoinTierId } from '../tiers.ts';

interface LookdevState {
  ready: boolean;
  requested: CoinBackend;
  backend: CoinBackend | null;
  boots: number;
  losses: string[];
  failed: string | null;
  stats: CoinFieldStats | null;
}

declare global {
  interface Window {
    __lookdev?: LookdevState;
  }
}

const params = new URLSearchParams(location.search);
const view = params.get('scene') ?? 'hero';
const fixedTime = params.has('t') ? Number(params.get('t')) : null;
const tierParam = params.get('tier') ?? 'gold';
const focusTier: CoinTierId = isCoinTierId(tierParam) ? tierParam : 'gold';
const loseAfter = params.has('loseAfter') ? Number(params.get('loseAfter')) : null;
const MAX_BOOTS = 3;

const state: LookdevState = {
  ready: false,
  requested: params.get('backend') === 'webgl' ? 'webgl2' : 'webgpu',
  backend: null,
  boots: 0,
  losses: [],
  failed: null,
  stats: null,
};
window.__lookdev = state;

const q = new Quaternion();
const e = new Euler();

interface Staged {
  positions: number[];
  quaternions: number[];
  ids: number[];
}

interface Stage {
  readonly renderer: WebGPURenderer;
  readonly canvas: HTMLCanvasElement;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly floor: Mesh;
  readonly coins: CoinField;
  readonly staged: Map<CoinTierId, Staged>;
  pileBuilt: boolean;
  dispose(): void;
}

let current: Stage | null = null;

function freshCanvas(): HTMLCanvasElement {
  const previous = document.querySelector<HTMLCanvasElement>('#lookdev');
  if (!previous) throw new Error('lookdev canvas is missing');
  // A canvas that ever handed out a WebGPU or lost WebGL context cannot host the next backend.
  const canvas = document.createElement('canvas');
  canvas.id = 'lookdev';
  previous.replaceWith(canvas);
  return canvas;
}

function createStage(renderer: WebGPURenderer, canvas: HTMLCanvasElement): Stage {
  const scene = new Scene();
  scene.background = new Color('#070b14');
  const pmrem = new PMREMGenerator(renderer);
  const environment = pmrem.fromScene(new RoomEnvironment(), 0.035).texture;
  scene.environment = environment;
  scene.environmentIntensity = 0.55;

  const key = new DirectionalLight('#fff1d6', 3.2);
  key.position.set(-3, 6, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -8;
  key.shadow.camera.right = 8;
  key.shadow.camera.top = 8;
  key.shadow.camera.bottom = -8;
  key.shadow.bias = -0.0004;
  const rim = new DirectionalLight('#9fc4ff', 2.4);
  rim.position.set(4, 2.5, -5);
  const fill = new DirectionalLight('#ffd0b0', 0.6);
  fill.position.set(5, 1, 3);
  scene.add(key, rim, fill);

  const floorMaterial = new MeshPhysicalNodeMaterial({
    color: '#0E1F3A',
    roughness: 0.55,
    clearcoat: 0.8,
    clearcoatRoughness: 0.12,
  });
  const floor = new Mesh(new PlaneGeometry(60, 60), floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const camera = new PerspectiveCamera(30, window.innerWidth / window.innerHeight, 0.05, 200);
  const coins = new CoinField({ capacity: 600, radius: view === 'pile' ? 0.42 : 1 });
  coins.bake(renderer, Number(params.get('res') ?? 1024));
  coins.setReducedMotion(params.has('still'));
  coins.castShadowsFrom(key);
  scene.add(coins.object);

  const stage: Stage = {
    renderer,
    canvas,
    scene,
    camera,
    floor,
    coins,
    staged: new Map(
      COIN_TIER_IDS.map((tier) => [tier, { positions: [], quaternions: [], ids: [] }]),
    ),
    pileBuilt: false,
    dispose() {
      void renderer.setAnimationLoop(null);
      coins.dispose();
      floor.geometry.dispose();
      floorMaterial.dispose();
      environment.dispose();
      pmrem.dispose();
      void renderer.dispose();
    },
  };
  return stage;
}

function stageCoin(s: Stage, tier: CoinTierId, id: number, x: number, y: number, z: number): void {
  const staged = s.staged.get(tier);
  if (!staged) throw new Error(`lookdev has no staging for ${tier}`);
  staged.positions.push(x, y, z);
  staged.quaternions.push(q.x, q.y, q.z, q.w);
  staged.ids.push(id);
}

function commit(s: Stage): void {
  for (const [tier, staged] of s.staged) {
    s.coins.setTransforms(
      tier,
      staged.positions,
      staged.quaternions,
      staged.ids.length,
      staged.ids,
    );
    staged.positions.length = 0;
    staged.quaternions.length = 0;
    staged.ids.length = 0;
  }
}

function placeHero(s: Stage, time: number): void {
  s.floor.visible = false;
  COIN_TIER_IDS.forEach((tier, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    e.set(1.05, 0.25 * Math.sin(time * 0.6 + i) - 0.12 * (col - 1), 0.0, 'XYZ');
    q.setFromEuler(e);
    stageCoin(s, tier, i, (col - 1) * 2.45, 1.25 - row * 2.45, 0);
  });
  commit(s);
  s.camera.position.set(0, 0, 13.5);
  s.camera.lookAt(0, 0, 0);
}

function placeMacro(s: Stage, time: number): void {
  s.floor.visible = false;
  e.set(1.2 + 0.08 * Math.sin(time * 0.5), 0.35 * Math.sin(time * 0.4), 0, 'XYZ');
  q.setFromEuler(e);
  stageCoin(s, focusTier, 0, 0, 0, 0);
  commit(s);
  s.camera.position.set(0, 0, 4.6);
  s.camera.lookAt(0, 0, 0);
}

function placeEdge(s: Stage, time: number): void {
  s.floor.visible = false;
  for (let i = 0; i < 3; i += 1) {
    e.set(0.25 + i * 0.12, time * 0.3 + i * 0.7, 0.1, 'XYZ');
    q.setFromEuler(e);
    stageCoin(s, focusTier, i, (i - 1) * 2.15, 0, -i * 0.4);
  }
  commit(s);
  s.camera.position.set(0, 0.6, 7.8);
  s.camera.lookAt(0, 0, 0);
}

function placePile(s: Stage): void {
  s.floor.visible = true;
  if (s.pileBuilt) return;
  s.pileBuilt = true;
  let seed = 1234567;
  const random = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const weights: Record<CoinTierId, number> = {
    copper: 0.38,
    silver: 0.26,
    gold: 0.18,
    platinum: 0.1,
    diamond: 0.06,
    heirloom: 0.02,
  };
  // Dart-thrown layers that never interpenetrate, so the frame reads as a settled pile:
  // coins in a layer keep a full diameter apart and each layer rests above the tilted tops
  // of the one below.
  const r = s.coins.radius;
  const halfThickness = NEAR_COIN_GEOMETRY.halfThickness * r;
  const maxTilt = 0.07;
  const layerHeight = 2 * halfThickness + 2 * r * Math.sin(maxTilt) + 0.004;
  const layers: { x: number; z: number }[][] = [[], [], []];
  let id = 0;
  for (let attempt = 0; attempt < 6000 && id < 520; attempt += 1) {
    const layer = Math.min(2, Math.floor(random() ** 1.6 * 3));
    const x = (random() - 0.5) * (9 - layer * 2.2);
    const z = (random() - 0.5) * (14 - layer * 3.5) - 2;
    const placed = layers[layer];
    if (!placed || placed.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < (2.02 * r) ** 2)) continue;
    placed.push({ x, z });
    let pick = random();
    let tier: CoinTierId = 'copper';
    for (const t of COIN_TIER_IDS) {
      pick -= weights[t];
      if (pick <= 0) {
        tier = t;
        break;
      }
    }
    const tiltX = layer === 0 ? 0 : (random() - 0.5) * 2 * maxTilt * 0.7;
    const tiltZ = layer === 0 ? 0 : (random() - 0.5) * 2 * maxTilt * 0.7;
    e.set(tiltX, random() * Math.PI * 2, tiltZ, 'YXZ');
    q.setFromEuler(e);
    const lift = r * Math.sin(Math.hypot(tiltX, tiltZ));
    stageCoin(s, tier, id, x, layer * layerHeight + halfThickness + lift + 0.001, z);
    id += 1;
  }
  commit(s);
  const zoom = Number(params.get('zoom') ?? 1);
  s.camera.position.set(0, 3.6 * zoom, 7.2 * zoom - 2.2 * (zoom - 1));
  s.camera.lookAt(0, 0, -2.2);
}

function forceLoss(renderer: WebGPURenderer): void {
  const backend = renderer.backend as {
    device?: { destroy(): void };
    gl?: WebGL2RenderingContext;
  };
  if (backend.device) {
    backend.device.destroy();
    return;
  }
  const lose = backend.gl?.getExtension('WEBGL_lose_context');
  if (!lose) throw new Error('lookdev loseAfter: WEBGL_lose_context is unavailable');
  lose.loseContext();
}

function resize(s: Stage): void {
  s.camera.aspect = window.innerWidth / window.innerHeight;
  s.camera.updateProjectionMatrix();
  s.renderer.setSize(window.innerWidth, window.innerHeight, false);
}

async function boot(forceWebGL: boolean): Promise<void> {
  state.boots += 1;
  state.ready = false;
  let renderer: WebGPURenderer;
  let canvas: HTMLCanvasElement;
  if (forceWebGL) {
    const acquired = await acquireWebGL2Context(freshCanvas);
    if (acquired.attempt > 1) {
      console.info(`[coins] WebGL2 context came back on attempt ${acquired.attempt}`);
    }
    canvas = acquired.canvas;
    renderer = new WebGPURenderer({
      canvas,
      context: acquired.context,
      antialias: true,
      forceWebGL,
    });
  } else {
    canvas = freshCanvas();
    renderer = new WebGPURenderer({ canvas, antialias: true });
  }
  renderer.toneMapping = params.get('tonemap') === 'aces' ? ACESFilmicToneMapping : AgXToneMapping;
  renderer.toneMappingExposure = Number(params.get('exposure') ?? 1.05);
  renderer.shadowMap.enabled = true;
  renderer.setPixelRatio(Number(params.get('dpr') ?? 1));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  await renderer.init();

  let watch: GpuLossWatch | null = null;
  watch = watchGpuLoss(
    renderer,
    (loss) => {
      void renderer.setAnimationLoop(null);
      state.ready = false;
      const next = state.boots >= MAX_BOOTS ? 'reload' : 'webgl2';
      const line = describeGpuLoss(loss, next);
      state.losses.push(line);
      if (next === 'reload') {
        state.failed = line;
        console.error(line);
        return;
      }
      console.warn(line);
      watch?.stop();
      stage.dispose();
      current = null;
      boot(true).catch(reportBootFailure);
    },
    { rejections: window },
  );
  state.backend = watch.backend;
  console.info(`[coins] lookdev boot ${state.boots} rendering on ${watch.backend}`);

  const stage = createStage(renderer, canvas);
  current = stage;
  resize(stage);

  const start = performance.now();
  let frames = 0;
  const forcedLossFrame = state.boots === 1 ? loseAfter : null;
  await renderer.setAnimationLoop(() => {
    const time = fixedTime ?? (performance.now() - start) / 1000;
    if (view === 'macro') placeMacro(stage, time);
    else if (view === 'edge') placeEdge(stage, time);
    else if (view === 'pile') placePile(stage);
    else placeHero(stage, time);
    state.stats = stage.coins.update(stage.camera, canvas.clientHeight);
    renderer.render(stage.scene, stage.camera);
    frames += 1;
    if (forcedLossFrame !== null && frames === forcedLossFrame) {
      forceLoss(renderer);
      return;
    }
    state.ready = frames > 3 && (forcedLossFrame === null || frames > forcedLossFrame);
    if (fixedTime !== null && frames > 4 && forcedLossFrame === null)
      void renderer.setAnimationLoop(null);
  });
}

function reportBootFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  state.failed = `[coins] lookdev could not start a renderer: ${message}`;
  console.error(state.failed);
}

window.addEventListener('resize', () => {
  if (current) resize(current);
});

boot(state.requested === 'webgl2').catch(reportBootFailure);
