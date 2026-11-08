// Dev-only coin lookdev on the real Riviera table (served by `pnpm dev` at
// /src/scene/coins/lookdev/table.html): the game's stage, post chain, venue lighting and camera
// preset, with a hand-placed front row of copper, silver and gold at the payout lip and a heap
// behind it. `verify.mjs` screenshots it at 390x844 and reads back the HDR scene pass so a
// coin highlight can be held against the bloom threshold and the backboard sunburst.
//
// Flags: `quality=low|medium|high` (default high), `t=<s>` venue time, `cam=x,y,z&look=x,y,z`
// overrides the preset camera for a close look.
import { COIN, PLAYFIELD } from '@coinposh/sim/layout';
import {
  FloatType,
  Quaternion,
  RenderTarget,
  Vector3,
  type Object3D,
  type WebGPURenderer,
} from 'three/webgpu';
import { isQualityTier } from '../../quality/tiers.ts';
import { applyCameraPreset, createRivieraVenue } from '../../venues/riviera/index.ts';
import { createStage, type Stage } from '../../../stage.ts';
import { COIN_TIER_IDS, type CoinTierId } from '../tiers.ts';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HdrStats {
  /** Brightest scene-linear luminance, what the bloom high-pass compares to its threshold. */
  readonly peak: number;
  /** Share of the group's pixels above the bloom threshold. */
  readonly overThreshold: number;
  /** Mean scene-linear colour, normalised to a mean channel of 1. */
  readonly tint: readonly [number, number, number];
  readonly pixels: number;
  /** The group's screen pixels, top row first, as alternating run lengths starting with a gap. */
  readonly mask: readonly number[];
}

export interface HdrReport {
  readonly bloomThreshold: number;
  readonly sunburst: HdrStats;
  readonly coins: HdrStats;
  readonly tiers: Partial<Record<CoinTierId, HdrStats>>;
}

interface TableState {
  ready: boolean;
  failed: string | null;
  backend: string | null;
  quality: string | null;
  frontRow: Rect | null;
  measure?: () => Promise<HdrReport>;
}

declare global {
  interface Window {
    __table?: TableState;
  }
}

const params = new URLSearchParams(location.search);
const qualityParam = params.get('quality') ?? 'high';
const quality = isQualityTier(qualityParam) ? qualityParam : 'high';
const venueTime = Number(params.get('t') ?? 1);
const FRONT_ROW: readonly CoinTierId[] = ['copper', 'silver', 'gold'];

const state: TableState = {
  ready: false,
  failed: null,
  backend: null,
  quality: null,
  frontRow: null,
};
window.__table = state;

function vectorParam(name: string): Vector3 | null {
  const raw = params.get(name);
  if (!raw) return null;
  const parts = raw.split(',').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n)))
    throw new Error(`table lookdev flag ${name} must be three comma-separated numbers: "${raw}"`);
  return new Vector3(parts[0], parts[1], parts[2]);
}

interface Placed {
  readonly tier: CoinTierId;
  readonly position: Vector3;
  readonly quaternion: Quaternion;
}

function layoutCoins(): { coins: Placed[]; frontRow: Vector3[] } {
  const r = COIN.radius;
  const rest = COIN.halfThickness + 0.0002;
  let seed = 20261108;
  const random = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const coins: Placed[] = [];
  const frontRow: Vector3[] = [];
  const flat = (yaw: number, tilt = 0): Quaternion =>
    new Quaternion()
      .setFromAxisAngle(new Vector3(0, 1, 0), yaw)
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), tilt));

  const pitch = 2 * r + 0.0012;
  const count = Math.floor((2 * (PLAYFIELD.fieldHalfWidth - 0.004)) / pitch);
  const z0 = PLAYFIELD.fieldFrontZ - r * 0.7;
  for (let i = 0; i < count; i += 1) {
    const x = (i - (count - 1) / 2) * pitch;
    const position = new Vector3(x, rest, z0 + (random() - 0.5) * 0.002);
    frontRow.push(position);
    coins.push({
      tier: FRONT_ROW[i % FRONT_ROW.length] ?? 'gold',
      position,
      quaternion: flat(random() * Math.PI * 2),
    });
  }

  const weights: readonly (readonly [CoinTierId, number])[] = [
    ['copper', 0.5],
    ['silver', 0.24],
    ['gold', 0.16],
    ['platinum', 0.05],
    ['diamond', 0.03],
    ['heirloom', 0.02],
  ];
  const pick = (): CoinTierId => {
    let roll = random();
    for (const [tier, weight] of weights) {
      roll -= weight;
      if (roll <= 0) return tier;
    }
    return 'copper';
  };
  const placed: Vector3[] = [...frontRow];
  for (let attempt = 0; attempt < 4000 && coins.length < 150; attempt += 1) {
    const x = (random() * 2 - 1) * (PLAYFIELD.fieldHalfWidth - r);
    const z = z0 - 2 * r - random() * 0.14;
    if (placed.some((p) => p.y < r && (p.x - x) ** 2 + (p.z - z) ** 2 < (2.05 * r) ** 2)) continue;
    const position = new Vector3(x, rest, z);
    placed.push(position);
    coins.push({ tier: pick(), position, quaternion: flat(random() * Math.PI * 2) });
    if (random() < 0.3) {
      const tilt = (random() - 0.5) * 0.16;
      coins.push({
        tier: pick(),
        position: new Vector3(
          x + (random() - 0.5) * r * 0.6,
          rest + 2 * COIN.halfThickness + Math.abs(tilt) * r + 0.0002,
          z + (random() - 0.5) * r * 0.6,
        ),
        quaternion: flat(random() * Math.PI * 2, tilt),
      });
    }
  }
  return { coins, frontRow };
}

function upload(stage: Stage, coins: readonly Placed[]): void {
  for (const tier of COIN_TIER_IDS) {
    const mine = coins.filter((c) => c.tier === tier);
    const positions = mine.flatMap((c) => c.position.toArray());
    const quaternions = mine.flatMap((c) => c.quaternion.toArray());
    stage.coins.setTransforms(
      tier,
      positions,
      quaternions,
      mine.length,
      mine.map((coin) => coins.indexOf(coin)),
    );
  }
}

function screenRect(stage: Stage, points: readonly Vector3[]): Rect {
  const width = stage.canvas.clientWidth;
  const height = stage.canvas.clientHeight;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const p = new Vector3();
  for (const centre of points) {
    for (const [dx, dz] of [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ] as const) {
      p.set(centre.x + dx * COIN.radius, centre.y, centre.z + dz * COIN.radius);
      p.project(stage.camera);
      const sx = ((p.x + 1) / 2) * width;
      const sy = ((1 - p.y) / 2) * height;
      minX = Math.min(minX, sx);
      maxX = Math.max(maxX, sx);
      minY = Math.min(minY, sy);
      maxY = Math.max(maxY, sy);
    }
  }
  const pad = 6;
  return {
    x: Math.max(0, Math.floor(minX - pad)),
    y: Math.max(0, Math.floor(minY - pad)),
    width: Math.min(width, Math.ceil(maxX + pad)) - Math.max(0, Math.floor(minX - pad)),
    height: Math.min(height, Math.ceil(maxY + pad)) - Math.max(0, Math.floor(minY - pad)),
  };
}

function luminance(px: ArrayLike<number>, i: number): number {
  return 0.2126 * (px[i] ?? 0) + 0.7152 * (px[i + 1] ?? 0) + 0.0722 * (px[i + 2] ?? 0);
}

// Renders the scene pass without post into a float target, the same linear HDR the bloom
// high-pass reads, once with everything and once per hidden group: the pixels that change are
// that group's. The coin shadow caster stays on, so hiding coins leaves their shadows behind
// and only the coins' own pixels change.
async function measureHdr(stage: Stage, sunburst: Object3D): Promise<HdrReport> {
  const renderer: WebGPURenderer = stage.renderer;
  const width = stage.canvas.clientWidth;
  const height = stage.canvas.clientHeight;
  const threshold = stage.profile.bloom.threshold;
  // WebGL reads rows bottom-up; WebGPU copies them top-down.
  const bottomUp = stage.backend === 'webgl2';
  const target = new RenderTarget(width, height, { type: FloatType, depthBuffer: true });
  const read = async (hide: readonly Object3D[]): Promise<Float32Array> => {
    const was = hide.map((o) => o.visible);
    hide.forEach((o) => (o.visible = false));
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    renderer.render(stage.scene, stage.camera);
    renderer.setRenderTarget(previous);
    hide.forEach((o, i) => (o.visible = was[i] ?? true));
    const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height);
    return new Float32Array(pixels);
  };
  const statsWhereChanged = (all: Float32Array, without: Float32Array): HdrStats => {
    let peak = 0;
    let over = 0;
    let pixels = 0;
    const sum = [0, 0, 0];
    const covered = new Uint8Array(width * height);
    for (let i = 0; i < all.length; i += 4) {
      const delta =
        Math.abs((all[i] ?? 0) - (without[i] ?? 0)) +
        Math.abs((all[i + 1] ?? 0) - (without[i + 1] ?? 0)) +
        Math.abs((all[i + 2] ?? 0) - (without[i + 2] ?? 0));
      if (delta <= 1e-3) continue;
      const lum = luminance(all, i);
      peak = Math.max(peak, lum);
      if (lum > threshold) over += 1;
      pixels += 1;
      const texel = i / 4;
      const row = Math.floor(texel / width);
      covered[(bottomUp ? height - 1 - row : row) * width + (texel % width)] = 1;
      for (let c = 0; c < 3; c += 1) sum[c] = (sum[c] ?? 0) + Math.min(all[i + c] ?? 0, 4);
    }
    const mean = ((sum[0] ?? 0) + (sum[1] ?? 0) + (sum[2] ?? 0)) / 3 || 1;
    const tint = sum.map((v) => Number((v / mean).toFixed(3))) as [number, number, number];
    const mask: number[] = [];
    let run = 0;
    let value = 0;
    for (const bit of covered) {
      if (bit === value) {
        run += 1;
        continue;
      }
      mask.push(run);
      value = bit;
      run = 1;
    }
    mask.push(run);
    return { peak, overThreshold: over / Math.max(pixels, 1), tint, pixels, mask };
  };
  const tierMeshes = (tier: CoinTierId): Object3D[] => [
    stage.coins.mesh(tier, 'near'),
    stage.coins.mesh(tier, 'far'),
  ];
  try {
    const all = await read([]);
    const tiers: Partial<Record<CoinTierId, HdrStats>> = {};
    for (const tier of COIN_TIER_IDS) {
      const meshes = tierMeshes(tier);
      tiers[tier] = statsWhereChanged(all, await read(meshes));
    }
    return {
      bloomThreshold: threshold,
      sunburst: statsWhereChanged(all, await read([sunburst])),
      coins: statsWhereChanged(all, await read(COIN_TIER_IDS.flatMap(tierMeshes))),
      tiers,
    };
  } finally {
    target.dispose();
  }
}

async function boot(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#table');
  if (!canvas) throw new Error('table lookdev canvas #table is missing');
  const riviera = await import('../../venues/riviera/index.ts');
  const stage = await createStage(canvas, {
    look: riviera.RIVIERA_RENDER_LOOK,
    vignetteTint: riviera.RIVIERA_VIGNETTE_TINT,
    quality,
    coins: { capacity: 96, radius: COIN.radius },
  });
  const venue = await createRivieraVenue(stage.scene, null, {
    quality: stage.profile.venueDetail,
    shadows: stage.look.shadows,
  });
  for (let left = venueTime; left > 0; left -= 0.25) venue.update(Math.min(left, 0.25));
  stage.castCoinShadowsFrom(venue.lighting.key);
  venue.setReducedMotion(true);
  stage.coins.setReducedMotion(true);

  const sunburst = stage.scene.getObjectByName('table-gold');
  if (!sunburst) throw new Error('table lookdev: the venue has no table-gold mesh (sunburst)');

  const cam = vectorParam('cam');
  const look = vectorParam('look');
  const { coins, frontRow } = layoutCoins();
  let frames = 0;
  stage.onFrame(() => {
    applyCameraPreset(stage.camera, venue.cameraPreset(stage.camera.aspect));
    if (cam) stage.camera.position.copy(cam);
    if (cam || look)
      stage.camera.lookAt(look ?? frontRow[Math.floor(frontRow.length / 2)] ?? new Vector3());
    stage.camera.updateProjectionMatrix();
    upload(stage, coins);
    frames += 1;
    if (frames === 8) {
      state.frontRow = screenRect(stage, frontRow);
      state.backend = stage.backend;
      state.quality = stage.profile.tier;
      state.measure = () => measureHdr(stage, sunburst);
      state.ready = true;
    }
  });
}

boot().catch((error: unknown) => {
  state.failed = error instanceof Error ? error.message : String(error);
  console.error('[coins] table lookdev could not start', error);
});
