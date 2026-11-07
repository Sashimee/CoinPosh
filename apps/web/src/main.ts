import { createAudioEngine, isAudioSupported } from './audio/index.ts';
import type { CoinField, CoinTierId } from './scene/coins/index.ts';
import type * as RivieraModule from './scene/venues/riviera/index.ts';
import type { RivieraVenue } from './scene/venues/riviera/index.ts';
import type { Stage } from './stage.ts';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** Instance slots per coin tier: the 250-coin table budget, shaped like a fusion pyramid. */
const COIN_CAPACITY: Readonly<Record<CoinTierId, number>> = {
  copper: 256,
  silver: 128,
  gold: 64,
  platinum: 32,
  diamond: 16,
  heirloom: 8,
};
// Copies COIN in packages/sim/src/coin.ts: the web app does not depend on @coinposh/sim.
const COIN_RADIUS = 0.0135;
const COIN_HALF_THICKNESS = 0.0013;

const canvas = document.querySelector<HTMLCanvasElement>('#stage');
if (!canvas) {
  throw new Error('CoinPosh boot failed: <canvas id="stage"> is missing from index.html');
}

bootAudio().catch((error: unknown) => {
  console.error('CoinPosh audio failed to start; the game continues without sound.', error);
});

void bootScene(canvas);

// The music loop is rendered offline now, before any gesture, so the first tap only has to
// unlock the context and the track starts without a render hitch.
async function bootAudio(): Promise<void> {
  if (!isAudioSupported()) {
    console.warn('[CoinPosh] Web Audio is unavailable in this browser; playing without sound.');
    return;
  }
  const audio = createAudioEngine();
  await audio.startMusic();
}

async function bootScene(target: HTMLCanvasElement): Promise<void> {
  let stage: Stage;
  let riviera: typeof RivieraModule;
  try {
    const [stageModule, venueModule] = await Promise.all([
      import('./stage.ts'),
      import('./scene/venues/riviera/index.ts'),
    ]);
    riviera = venueModule;
    stage = await stageModule.createStage(target, {
      look: riviera.RIVIERA_RENDER_LOOK,
      vignetteTint: riviera.RIVIERA_VIGNETTE_TINT,
      coins: { capacity: COIN_CAPACITY, radius: COIN_RADIUS },
    });
  } catch (error) {
    console.error('CoinPosh boot failed: the renderer could not start.', error);
    return;
  }
  let venue: RivieraVenue;
  try {
    venue = await riviera.createRivieraVenue(stage.scene, null, {
      quality: stage.profile.venueDetail,
      shadows: stage.look.shadows,
    });
  } catch (error) {
    console.error('CoinPosh boot failed: the Riviera venue could not load.', error);
    return;
  }
  attachVenue(stage, venue, riviera.applyCameraPreset);
  stage.castCoinShadowsFrom(venue.lighting.key);
  attachCoins(stage, createDemoTableSource(riviera.RIVIERA_TABLE));
  watchReducedMotion((reduced) => {
    venue.setReducedMotion(reduced);
    stage.coins.setReducedMotion(reduced);
  });
}

function attachVenue(
  stage: Stage,
  venue: RivieraVenue,
  applyCameraPreset: typeof RivieraModule.applyCameraPreset,
): void {
  stage.observeSize((width, height) => {
    applyCameraPreset(stage.camera, venue.cameraPreset(width / height));
  });
  stage.onFrame((deltaSeconds) => {
    venue.update(deltaSeconds);
  });
}

/**
 * Where the coins on screen come from. The sim worker bridge (T-1.03) replaces the demo
 * source with interpolated sim transforms written every frame. A source only places coins:
 * what a coin is worth only ever comes from the server.
 */
interface CoinTransformSource {
  /** Runs once per frame, before the stage uploads the field. */
  sync(field: CoinField): void;
}

function attachCoins(stage: Stage, source: CoinTransformSource): void {
  stage.onFrame(() => {
    source.sync(stage.coins);
  });
}

function watchReducedMotion(apply: (reduced: boolean) => void): void {
  if (typeof matchMedia !== 'function') return;
  const query = matchMedia(REDUCED_MOTION_QUERY);
  apply(query.matches);
  query.addEventListener('change', (event) => {
    apply(event.matches);
  });
}

interface CoinPlacement {
  readonly tier: CoinTierId;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
}

const TAU = Math.PI * 2;
const DEMO_SEED = 0xc0196051;
const DEMO_SPACING = 2 * COIN_RADIUS + 0.0006;
const DEMO_FLOOR_COINS = 150;
const DEMO_SHELF_COINS = 38;
const DEMO_STACKED_COINS = [44, 12] as const;
// Copper-heavy with a sprinkle of the rarer metals, so every coin material shows on boot.
const DEMO_TIER_WEIGHTS: readonly (readonly [CoinTierId, number])[] = [
  ['copper', 0.6],
  ['silver', 0.21],
  ['gold', 0.12],
  ['platinum', 0.04],
  ['diamond', 0.025],
  ['heirloom', 0.005],
];

/**
 * Demo Mode's table before the sim runs in the page: a settled, seeded layout of flat coins
 * across the lower playfield and the pusher shelf, a few stacked two and three high, written
 * once. Same seed, same table on every boot and device.
 */
function createDemoTableSource(table: typeof RivieraModule.RIVIERA_TABLE): CoinTransformSource {
  let written = false;
  return {
    sync(field) {
      if (written) return;
      written = true;
      writePlacements(field, demoTableLayout(table));
    },
  };
}

function demoTableLayout(table: typeof RivieraModule.RIVIERA_TABLE): CoinPlacement[] {
  const random = mulberry32(DEMO_SEED);
  const placements: CoinPlacement[] = [];
  const counts = new Map<CoinTierId, number>();
  const pickTier = (): CoinTierId => {
    for (;;) {
      let roll = random();
      for (const [tier, weight] of DEMO_TIER_WEIGHTS) {
        roll -= weight;
        if (roll > 0) continue;
        const count = counts.get(tier) ?? 0;
        if (count >= COIN_CAPACITY[tier]) break;
        counts.set(tier, count + 1);
        return tier;
      }
    }
  };
  const halfWidth = table.fieldHalfWidth - COIN_RADIUS - 0.003;

  const scatter = (
    target: number,
    floorY: number,
    zMin: number,
    zMax: number,
    bias: number,
  ): CoinPlacement[] => {
    const layer: CoinPlacement[] = [];
    for (let attempt = 0; layer.length < target && attempt < target * 200; attempt += 1) {
      const x = (random() * 2 - 1) * halfWidth;
      const z = zMin + (zMax - zMin) * random() ** bias;
      if (layer.some((coin) => Math.hypot(coin.x - x, coin.z - z) < DEMO_SPACING)) continue;
      layer.push({ tier: pickTier(), x, y: floorY + COIN_HALF_THICKNESS, z, yaw: random() * TAU });
    }
    return layer;
  };

  const stackOn = (base: readonly CoinPlacement[], target: number): CoinPlacement[] => {
    const layer: CoinPlacement[] = [];
    for (let attempt = 0; layer.length < target && attempt < target * 200; attempt += 1) {
      const under = base[Math.floor(random() * base.length)];
      if (!under) break;
      const angle = random() * TAU;
      const offset = COIN_RADIUS * (0.15 + random() * 0.4);
      const x = under.x + Math.cos(angle) * offset;
      const z = under.z + Math.sin(angle) * offset;
      if (Math.abs(x) > halfWidth) continue;
      if (layer.some((coin) => Math.hypot(coin.x - x, coin.z - z) < DEMO_SPACING)) continue;
      const y = under.y + 2 * COIN_HALF_THICKNESS;
      layer.push({ tier: pickTier(), x, y, z, yaw: random() * TAU });
    }
    return layer;
  };

  // The pusher face sits at its retracted position until the sim drives it.
  const pusherFace = table.pusherFrontZ + 0.0015;
  const floor = scatter(
    DEMO_FLOOR_COINS,
    0,
    pusherFace + COIN_RADIUS + 0.002,
    table.fieldFrontZ - COIN_RADIUS * 0.3,
    1.35,
  );
  const shelf = scatter(
    DEMO_SHELF_COINS,
    table.pusherHeight,
    table.backboardFrontZ + COIN_RADIUS + 0.004,
    table.pusherFrontZ - COIN_RADIUS - 0.012,
    1,
  );
  placements.push(...floor, ...shelf);
  let base: readonly CoinPlacement[] = floor;
  for (const target of DEMO_STACKED_COINS) {
    const layer = stackOn(base, target);
    placements.push(...layer);
    base = layer;
  }
  return placements;
}

function writePlacements(field: CoinField, placements: readonly CoinPlacement[]): void {
  const byTier = new Map<CoinTierId, CoinPlacement[]>();
  for (const coin of placements) {
    const list = byTier.get(coin.tier) ?? [];
    list.push(coin);
    byTier.set(coin.tier, list);
  }
  for (const [tier, coins] of byTier) {
    const positions = new Float32Array(coins.length * 3);
    const quaternions = new Float32Array(coins.length * 4);
    const ids = new Float64Array(coins.length);
    coins.forEach((coin, i) => {
      positions.set([coin.x, coin.y, coin.z], i * 3);
      quaternions.set([0, Math.sin(coin.yaw / 2), 0, Math.cos(coin.yaw / 2)], i * 4);
      ids[i] = i;
    });
    field.setTransforms(tier, positions, quaternions, coins.length, ids);
  }
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
