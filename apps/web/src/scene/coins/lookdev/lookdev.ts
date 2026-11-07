// Dev-only turntable for the coin materials (served by `pnpm dev` at
// /src/scene/coins/lookdev/). Lighting here is a neutral studio stand-in; the real venue
// lighting and post stack live in scene/env and scene/post.
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
import { CoinField } from '../coin-field.ts';
import { COIN_TIER_IDS, isCoinTierId, type CoinTierId } from '../tiers.ts';

declare global {
  interface Window {
    __lookdev?: { ready: boolean; backend: string; stats: unknown };
  }
}

const params = new URLSearchParams(location.search);
const view = params.get('scene') ?? 'hero';
const fixedTime = params.has('t') ? Number(params.get('t')) : null;
const tierParam = params.get('tier') ?? 'gold';
const focusTier: CoinTierId = isCoinTierId(tierParam) ? tierParam : 'gold';

const canvas = document.querySelector<HTMLCanvasElement>('#lookdev');
if (!canvas) throw new Error('lookdev canvas is missing');

const renderer = new WebGPURenderer({
  canvas,
  antialias: true,
  forceWebGL: params.get('backend') === 'webgl',
});
renderer.toneMapping = params.get('tonemap') === 'aces' ? ACESFilmicToneMapping : AgXToneMapping;
renderer.toneMappingExposure = Number(params.get('exposure') ?? 1.05);
renderer.shadowMap.enabled = true;
renderer.setPixelRatio(Number(params.get('dpr') ?? 1));
renderer.setSize(window.innerWidth, window.innerHeight, false);
await renderer.init();

const scene = new Scene();
scene.background = new Color('#070b14');
const pmrem = new PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.035).texture;
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

const q = new Quaternion();
const e = new Euler();
let seed = 1234567;
const random = (): number => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

interface Staged {
  positions: number[];
  quaternions: number[];
  ids: number[];
}
const staged = new Map<CoinTierId, Staged>(
  COIN_TIER_IDS.map((tier) => [tier, { positions: [], quaternions: [], ids: [] }]),
);

function stage(tier: CoinTierId, id: number, x: number, y: number, z: number): void {
  const s = staged.get(tier);
  if (!s) throw new Error(`lookdev has no staging for ${tier}`);
  s.positions.push(x, y, z);
  s.quaternions.push(q.x, q.y, q.z, q.w);
  s.ids.push(id);
}

function commit(): void {
  for (const [tier, s] of staged) {
    coins.setTransforms(tier, s.positions, s.quaternions, s.ids.length, s.ids);
    s.positions.length = 0;
    s.quaternions.length = 0;
    s.ids.length = 0;
  }
}

function placeHero(time: number): void {
  floor.visible = false;
  COIN_TIER_IDS.forEach((tier, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    e.set(1.05, 0.25 * Math.sin(time * 0.6 + i) - 0.12 * (col - 1), 0.0, 'XYZ');
    q.setFromEuler(e);
    stage(tier, i, (col - 1) * 2.45, 1.25 - row * 2.45, 0);
  });
  commit();
  camera.position.set(0, 0, 13.5);
  camera.lookAt(0, 0, 0);
}

function placeMacro(time: number): void {
  floor.visible = false;
  e.set(1.2 + 0.08 * Math.sin(time * 0.5), 0.35 * Math.sin(time * 0.4), 0, 'XYZ');
  q.setFromEuler(e);
  stage(focusTier, 0, 0, 0, 0);
  commit();
  camera.position.set(0, 0, 4.6);
  camera.lookAt(0, 0, 0);
}

function placeEdge(time: number): void {
  floor.visible = false;
  for (let i = 0; i < 3; i += 1) {
    e.set(0.25 + i * 0.12, time * 0.3 + i * 0.7, 0.1, 'XYZ');
    q.setFromEuler(e);
    stage(focusTier, i, (i - 1) * 2.15, 0, -i * 0.4);
  }
  commit();
  camera.position.set(0, 0.6, 7.8);
  camera.lookAt(0, 0, 0);
}

let pileBuilt = false;
function placePile(): void {
  floor.visible = true;
  if (pileBuilt) return;
  pileBuilt = true;
  const weights: Record<CoinTierId, number> = {
    copper: 0.38,
    silver: 0.26,
    gold: 0.18,
    platinum: 0.1,
    diamond: 0.06,
    heirloom: 0.02,
  };
  const total = 520;
  for (let id = 0; id < total; id += 1) {
    let pick = random();
    let tier: CoinTierId = 'copper';
    for (const t of COIN_TIER_IDS) {
      pick -= weights[t];
      if (pick <= 0) {
        tier = t;
        break;
      }
    }
    const layer = Math.floor(random() * 3);
    const x = (random() - 0.5) * 9;
    const z = (random() - 0.5) * 14 - 2;
    e.set((random() - 0.5) * 0.35, random() * Math.PI * 2, (random() - 0.5) * 0.35, 'YXZ');
    q.setFromEuler(e);
    stage(tier, id, x, 0.045 + layer * 0.085, z);
  }
  commit();
  const zoom = Number(params.get('zoom') ?? 1);
  camera.position.set(0, 3.6 * zoom, 7.2 * zoom - 2.2 * (zoom - 1));
  camera.lookAt(0, 0, -2.2);
}

const start = performance.now();
let frames = 0;
await renderer.setAnimationLoop(() => {
  const time = fixedTime ?? (performance.now() - start) / 1000;
  if (view === 'macro') placeMacro(time);
  else if (view === 'edge') placeEdge(time);
  else if (view === 'pile') placePile();
  else placeHero(time);
  const stats = coins.update(camera, canvas.clientHeight);
  renderer.render(scene, camera);
  frames += 1;
  window.__lookdev = {
    ready: frames > 3,
    backend: (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
      ? 'webgpu'
      : 'webgl2',
    stats,
  };
  if (fixedTime !== null && frames > 4) void renderer.setAnimationLoop(null);
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});
camera.aspect = window.innerWidth / window.innerHeight;
camera.updateProjectionMatrix();
