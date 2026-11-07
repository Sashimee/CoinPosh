import {
  BackSide,
  BoxGeometry,
  DoubleSide,
  Color,
  CylinderGeometry,
  DirectionalLight,
  InstancedMesh,
  LatheGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  MeshPhysicalNodeMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  SphereGeometry,
  SpotLight,
  Vector2,
  type BufferGeometry,
  type Material,
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu';

/** Matches the 300-body cap in the rendering budget, minus the crust that is frozen. */
export const BENCH_COIN_COUNT = 260;
const COIN_RADIUS = 0.17;
const COIN_THICKNESS = 0.045;

const GOLD = '#D4AF37';
const SILVER = '#D9DCE1';
const COPPER = '#C47A4D';
const NAVY_LACQUER = '#0E1F3A';
const TEAK = '#C9A27A';
const CHAMPAGNE = '#F3E5C0';
const CORAL_SUNSET = '#FF7A59';
const SEA_GLASS = '#7FD1C7';

export interface BenchScene {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  dispose(): void;
}

/**
 * A stand-in for a busy table: a full tray of instanced anisotropic coins on clearcoat
 * lacquer, a velvet sheen backdrop, an environment map and rim lights. It exercises the
 * same shading paths as a venue so the benchmark measures what the game will draw.
 */
export function createBenchScene(renderer: WebGPURenderer): BenchScene {
  const scene = new Scene();
  scene.background = new Color('#05070d');
  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];

  const environment = createStudioEnvironment(renderer);
  scene.environment = environment;
  scene.environmentIntensity = 0.9;

  const camera = new PerspectiveCamera(38, 1, 0.1, 40);
  camera.position.set(0, 2.15, 3.35);
  camera.lookAt(0, 0.05, -0.35);
  const size = renderer.getDrawingBufferSize(new Vector2());
  camera.aspect = size.x / Math.max(size.y, 1);
  camera.updateProjectionMatrix();

  const lacquer = new MeshPhysicalNodeMaterial({
    color: NAVY_LACQUER,
    roughness: 0.42,
    metalness: 0,
    specularIntensity: 0.25,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
  });
  const tableGeometry = new BoxGeometry(4.2, 0.2, 3.4);
  const table = new Mesh(tableGeometry, lacquer);
  table.position.set(0, -0.1, -0.6);
  scene.add(table);

  const teak = new MeshPhysicalNodeMaterial({
    color: TEAK,
    roughness: 0.48,
    clearcoat: 0.7,
    clearcoatRoughness: 0.12,
  });
  const railGeometry = new CylinderGeometry(0.06, 0.06, 4.3, 32, 1);
  railGeometry.rotateZ(Math.PI / 2);
  const rail = new Mesh(railGeometry, teak);
  rail.position.set(0, 0.02, 1.13);
  scene.add(rail);

  const velvet = new MeshPhysicalNodeMaterial({
    color: '#0A1326',
    roughness: 0.9,
    sheen: 1,
    sheenRoughness: 0.45,
    sheenColor: new Color(CHAMPAGNE).multiplyScalar(0.55),
    side: BackSide,
  });
  const backdropGeometry = new CylinderGeometry(
    4.2,
    4.2,
    7,
    96,
    1,
    true,
    Math.PI * 0.6,
    Math.PI * 0.8,
  );
  const backdrop = new Mesh(backdropGeometry, velvet);
  backdrop.position.set(0, 1.5, 1.2);
  scene.add(backdrop);

  const coinGeometry = createCoinGeometry();
  const gold = new MeshPhysicalNodeMaterial({
    color: '#ffffff',
    metalness: 1,
    roughness: 0.3,
    anisotropy: 0.45,
    clearcoat: 0.25,
    clearcoatRoughness: 0.08,
  });
  const coins = new InstancedMesh(coinGeometry, gold, BENCH_COIN_COUNT);
  scatterCoins(coins);
  scene.add(coins);

  const key = new DirectionalLight('#FFE7C7', 3.2);
  key.position.set(-2.2, 4, 2.6);
  scene.add(key);

  const coralRim = new SpotLight(CORAL_SUNSET, 9, 9, 0.6, 0.6, 2);
  coralRim.position.set(2.6, 1.3, -3.4);
  coralRim.target.position.set(0, 0, -0.2);
  scene.add(coralRim, coralRim.target);

  const seaRim = new SpotLight(SEA_GLASS, 6, 9, 0.6, 0.6, 2);
  seaRim.position.set(-2.8, 1.1, -3.2);
  seaRim.target.position.set(0, 0, -0.2);
  scene.add(seaRim, seaRim.target);

  geometries.push(tableGeometry, railGeometry, backdropGeometry, coinGeometry);
  materials.push(lacquer, teak, velvet, gold);

  return {
    scene,
    camera,
    dispose() {
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      coins.dispose();
      environment.dispose();
    },
  };
}

/**
 * A dark product-photography studio: a warm overhead softbox, two coloured strip lights
 * and a near-black cyclorama. Lacquer and metal then reflect crisp highlight shapes
 * instead of the flat grey a bright room would give them.
 */
function createStudioEnvironment(renderer: WebGPURenderer): Texture {
  const studio = new Scene();
  const parts: { geometry: BufferGeometry; material: Material }[] = [];
  const add = (geometry: BufferGeometry, color: Color, place: (mesh: Mesh) => void): void => {
    const material = new MeshBasicNodeMaterial({ color, side: DoubleSide });
    const mesh = new Mesh(geometry, material);
    place(mesh);
    studio.add(mesh);
    parts.push({ geometry, material });
  };
  add(new SphereGeometry(10, 32, 16), new Color('#07080c'), () => undefined);
  add(new PlaneGeometry(7, 2.5), new Color('#FFE4C2').multiplyScalar(5), (mesh) => {
    mesh.position.set(0, 5.5, -5);
    mesh.lookAt(0, 0, 0);
  });
  add(new PlaneGeometry(1, 6), new Color(SEA_GLASS).multiplyScalar(0.8), (mesh) => {
    mesh.position.set(-7, 2, -3);
    mesh.lookAt(0, 0, 0);
  });
  add(new PlaneGeometry(1, 6), new Color(CORAL_SUNSET).multiplyScalar(1.1), (mesh) => {
    mesh.position.set(7, 2, -3);
    mesh.lookAt(0, 0, 0);
  });
  add(new PlaneGeometry(8, 1.2), new Color(CHAMPAGNE).multiplyScalar(1.6), (mesh) => {
    mesh.position.set(0, 2.5, 8);
    mesh.lookAt(0, 0, 0);
  });
  const pmrem = new PMREMGenerator(renderer);
  const texture = pmrem.fromScene(studio, 0.02).texture;
  pmrem.dispose();
  for (const { geometry, material } of parts) {
    geometry.dispose();
    material.dispose();
  }
  return texture;
}

function createCoinGeometry(): BufferGeometry {
  const r = COIN_RADIUS;
  const h = COIN_THICKNESS / 2;
  const profile = [
    new Vector2(0, -h + 0.006),
    new Vector2(r * 0.8, -h + 0.006),
    new Vector2(r * 0.84, -h),
    new Vector2(r * 0.96, -h),
    new Vector2(r, -h + 0.008),
    new Vector2(r, h - 0.008),
    new Vector2(r * 0.96, h),
    new Vector2(r * 0.84, h),
    new Vector2(r * 0.8, h - 0.006),
    new Vector2(0, h - 0.006),
  ];
  const geometry = new LatheGeometry(profile, 72);
  geometry.computeTangents();
  return geometry;
}

/** Coins settle in staggered hex layers, as on a real pusher bed, so none interpenetrate. */
function scatterCoins(coins: InstancedMesh): void {
  const random = mulberry32(0xc01d);
  const dummy = new Object3D();
  const gold = new Color(GOLD);
  const silver = new Color(SILVER);
  const copper = new Color(COPPER);
  const pitch = COIN_RADIUS * 2 + 0.012;
  const rowPitch = pitch * Math.sqrt(3) * 0.5;
  const columns = 11;
  const rows = 10;
  let placed = 0;
  for (let layer = 0; placed < coins.count; layer++) {
    const offset = layer % 2 === 0 ? 0 : pitch * 0.5;
    const keep = layer === 0 ? 1 : Math.max(0.25, 1.15 - layer * 0.3);
    for (let row = 0; row < rows && placed < coins.count; row++) {
      for (let column = 0; column < columns && placed < coins.count; column++) {
        if (random() > keep) continue;
        const x = (column - (columns - 1) / 2) * pitch + (row % 2) * pitch * 0.5 + offset;
        const z = 0.75 - row * rowPitch - (layer % 2) * rowPitch * 0.33;
        dummy.position.set(x, COIN_THICKNESS * (0.5 + layer), z);
        dummy.rotation.set(0, random() * Math.PI * 2, 0);
        dummy.updateMatrix();
        coins.setMatrixAt(placed, dummy.matrix);
        const roll = random();
        coins.setColorAt(placed, roll < 0.62 ? gold : roll < 0.84 ? silver : copper);
        placed++;
      }
    }
  }
  coins.instanceMatrix.needsUpdate = true;
  if (coins.instanceColor !== null) coins.instanceColor.needsUpdate = true;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
