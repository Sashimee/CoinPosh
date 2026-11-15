import {
  COIN_TIERS,
  COLLECTIBLE_COIN_VARIANTS,
  type CoinTier,
  type CollectibleCoinVariant,
} from '@coinposh/shared';
import { COIN, PLAYFIELD } from '@coinposh/sim/layout';
import { Quaternion, Vector3 } from 'three/webgpu';
import { createStage } from '../../../stage.ts';
import { isQualityTier } from '../../quality/tiers.ts';
import { applyCameraPreset, createRivieraVenue } from '../../venues/riviera/index.ts';
import { loadCoinVariants } from './lazy.ts';

/**
 * Dev-only look-dev harness for the variant coins, served by Vite at
 * /src/scene/coins/variants/preview.html: on the game's stage and Riviera table, columns of a
 * plain strike then foil, proof, first strike and misprint, one row per tier, seen from the
 * play camera. Flags: `tiers=gold,silver` picks the rows (default copper, silver, gold),
 * `close` looks down on the front row, `glint` sweeps every variant's mint glint every two
 * seconds and `glint=<s>` freezes `s` seconds into it, `reduced` plays the reduced-motion
 * variants, `nobadges` hides the colourblind badges, `quality=low|medium|high` picks the tier
 * and `cam=x,y,z&look=x,y,z` moves the camera. The stage falls back to WebGL2 by itself where
 * WebGPU is missing.
 */
interface VariantPreviewState {
  ready: boolean;
  failed: string | null;
  backend: string | null;
  quality: string | null;
  coins: number;
  badges: number;
  drawCalls: number;
}

declare global {
  interface Window {
    __variantPreview?: VariantPreviewState;
  }
}

const params = new URLSearchParams(location.search);
const qualityParam = params.get('quality') ?? 'high';
const quality = isQualityTier(qualityParam) ? qualityParam : 'high';
const reduced = params.has('reduced');
const state: VariantPreviewState = {
  ready: false,
  failed: null,
  backend: null,
  quality: null,
  coins: 0,
  badges: 0,
  drawCalls: 0,
};
window.__variantPreview = state;

function vectorParam(name: string): Vector3 | null {
  const raw = params.get(name);
  if (!raw) return null;
  const parts = raw.split(',').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`Variant preview flag ${name} must be three comma-separated numbers: "${raw}"`);
  }
  return new Vector3(parts[0], parts[1], parts[2]);
}

function shownTiers(): readonly CoinTier[] {
  const raw = params.get('tiers');
  if (!raw) return ['gold', 'silver', 'copper'];
  return raw.split(',').map((name) => {
    const tier = COIN_TIERS.find((t) => t === name);
    if (!tier)
      throw new Error(`Variant preview flag tiers takes ${COIN_TIERS.join(', ')}: "${name}"`);
    return tier;
  });
}

interface Cell {
  readonly tier: CoinTier;
  readonly variant: CollectibleCoinVariant | 'none';
  readonly id: number;
  readonly position: Vector3;
  readonly quaternion: Quaternion;
}

function layout(tiers: readonly CoinTier[]): Cell[] {
  const columns = ['none', ...COLLECTIBLE_COIN_VARIANTS] as const;
  const pitch = 2 * COIN.radius + 0.005;
  const rest = COIN.halfThickness + 0.0002;
  const front = PLAYFIELD.fieldFrontZ - COIN.radius * 0.9;
  const cells: Cell[] = [];
  tiers.forEach((tier, row) => {
    columns.forEach((variant, column) => {
      const id = row * columns.length + column;
      cells.push({
        tier,
        variant,
        id,
        position: new Vector3(
          (column - (columns.length - 1) / 2) * pitch,
          rest,
          front - row * pitch,
        ),
        quaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), id * 0.83),
      });
    });
  });
  return cells;
}

async function boot(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#preview');
  if (!canvas) throw new Error('Variant preview canvas #preview is missing');
  const riviera = await import('../../venues/riviera/index.ts');
  const stage = await createStage(canvas, {
    look: riviera.RIVIERA_RENDER_LOOK,
    vignetteTint: riviera.RIVIERA_VIGNETTE_TINT,
    quality,
    coins: { capacity: 32, radius: COIN.radius },
  });
  const venue = await createRivieraVenue(stage.scene, null, {
    quality: stage.profile.venueDetail,
    shadows: stage.look.shadows,
  });
  for (let left = 1; left > 0; left -= 0.25) venue.update(Math.min(left, 0.25));
  stage.castCoinShadowsFrom(venue.lighting.key);
  venue.setReducedMotion(true);
  stage.coins.setReducedMotion(reduced);

  const { VariantCoinField } = await loadCoinVariants();
  const field = new VariantCoinField({
    capacity: 8,
    radius: COIN.radius,
    faces: (tier) => stage.coins.faceTexture(tier),
    castShadow: stage.profile.coinShadows,
  });
  field.setReducedMotion(reduced);
  field.setBadges(!params.has('nobadges'));
  stage.scene.add(field.object);

  const cells = layout(shownTiers());
  for (const tier of COIN_TIERS) {
    const plain = cells.filter((c) => c.tier === tier && c.variant === 'none');
    stage.coins.setTransforms(
      tier,
      plain.flatMap((c) => c.position.toArray()),
      plain.flatMap((c) => c.quaternion.toArray()),
      plain.length,
      plain.map((c) => c.id),
    );
    for (const variant of COLLECTIBLE_COIN_VARIANTS) {
      const mine = cells.filter((c) => c.tier === tier && c.variant === variant);
      field.setTransforms(
        tier,
        variant,
        mine.flatMap((c) => c.position.toArray()),
        mine.flatMap((c) => c.quaternion.toArray()),
        mine.length,
        mine.map((c) => c.id),
      );
    }
  }
  const glintAll = (): void => {
    for (const cell of cells) {
      if (cell.variant !== 'none') field.glint(cell.tier, cell.variant, cell.id);
    }
  };

  const glint = params.get('glint');
  const frozenGlint = glint !== null && glint !== '' ? Number(glint) : null;
  if (frozenGlint !== null) {
    glintAll();
    field.update(stage.camera, stage.canvas.clientHeight, frozenGlint);
  }
  const close = params.has('close');
  const cam = vectorParam('cam');
  const look = vectorParam('look');
  const frontZ = cells[0]?.position.z ?? 0;
  let nextGlint = 0.5;
  let elapsedSeconds = 0;
  let frames = 0;
  stage.onFrame((delta) => {
    applyCameraPreset(stage.camera, venue.cameraPreset(stage.camera.aspect));
    if (close) stage.camera.position.set(0, 0.075, frontZ + 0.11);
    if (cam) stage.camera.position.copy(cam);
    if (close || cam || look) stage.camera.lookAt(look ?? new Vector3(0, 0, frontZ - 0.012));
    stage.camera.updateProjectionMatrix();
    elapsedSeconds += delta;
    if (glint === '' && elapsedSeconds >= nextGlint) {
      glintAll();
      nextGlint += 2;
    }
    const stats = field.update(
      stage.camera,
      stage.canvas.clientHeight,
      frozenGlint === null ? delta : 0,
    );
    state.coins = stats.coins;
    state.badges = stats.badges;
    state.drawCalls = stats.drawCalls;
    frames += 1;
    if (frames === 8) {
      state.backend = stage.backend;
      state.quality = stage.profile.tier;
      state.ready = true;
    }
  });
}

boot().catch((error: unknown) => {
  state.failed = error instanceof Error ? error.message : String(error);
  console.error('[coins] variant preview could not start', error);
});
