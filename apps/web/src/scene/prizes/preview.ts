import {
  PRIZE_FAMILIES,
  PRIZE_RARITIES,
  type PrizeFamily,
  type PrizeRarity,
} from '@coinposh/shared';
import { COIN, PLAYFIELD } from '@coinposh/sim/layout';
import { Vector3 } from 'three/webgpu';
import { createStage } from '../../stage.ts';
import { isQualityTier } from '../quality/tiers.ts';
import { applyCameraPreset, createRivieraVenue } from '../venues/riviera/index.ts';
import { loadPrizes } from './lazy.ts';

/**
 * Dev-only look-dev harness for the prizes, served by Vite at /src/scene/prizes/preview.html:
 * on the game's stage and Riviera table, one column per rarity and one row per family, seen
 * from the play camera. Flags: `families=cufflinks,carKeys` picks the rows (default watch and
 * perfume: the lower tier shows two rows before the pusher hides the rest),
 * `rarities=rare,legendary` the columns, `close` looks down on the front row, `glint` sweeps
 * every prize's highlight every three seconds and `glint=<s>` freezes `s` seconds into it,
 * `reduced` plays the reduced-motion variants, `quality=low|medium|high` picks the tier and
 * `cam=x,y,z&look=x,y,z` moves the camera. The stage falls back to WebGL2 by itself where
 * WebGPU is missing.
 */
interface PrizePreviewState {
  ready: boolean;
  failed: string | null;
  backend: string | null;
  quality: string | null;
  prizes: number;
  drawCalls: number;
}

declare global {
  interface Window {
    __prizePreview?: PrizePreviewState;
  }
}

const params = new URLSearchParams(location.search);
const qualityParam = params.get('quality') ?? 'high';
const quality = isQualityTier(qualityParam) ? qualityParam : 'high';
const reduced = params.has('reduced');
const state: PrizePreviewState = {
  ready: false,
  failed: null,
  backend: null,
  quality: null,
  prizes: 0,
  drawCalls: 0,
};
window.__prizePreview = state;

function vectorParam(name: string): Vector3 | null {
  const raw = params.get(name);
  if (!raw) return null;
  const parts = raw.split(',').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`Prize preview flag ${name} must be three comma-separated numbers: "${raw}"`);
  }
  return new Vector3(parts[0], parts[1], parts[2]);
}

function listParam<T extends string>(
  name: string,
  all: readonly T[],
  fallback: readonly T[] = all,
): readonly T[] {
  const raw = params.get(name);
  if (!raw) return fallback;
  return raw.split(',').map((value) => {
    const found = all.find((item) => item === value);
    if (!found) throw new Error(`Prize preview flag ${name} takes ${all.join(', ')}: "${value}"`);
    return found;
  });
}

async function boot(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#preview');
  if (!canvas) throw new Error('Prize preview canvas #preview is missing');
  const riviera = await import('../venues/riviera/index.ts');
  const stage = await createStage(canvas, {
    look: riviera.RIVIERA_RENDER_LOOK,
    vignetteTint: riviera.RIVIERA_VIGNETTE_TINT,
    quality,
    coins: { capacity: 1, radius: COIN.radius },
  });
  const venue = await createRivieraVenue(stage.scene, null, {
    quality: stage.profile.venueDetail,
    shadows: stage.look.shadows,
  });
  for (let left = 1; left > 0; left -= 0.25) venue.update(Math.min(left, 0.25));
  venue.setReducedMotion(true);

  const { createPrizeKit } = await loadPrizes();
  const kit = createPrizeKit({
    quality: stage.profile.tier,
    castShadow: stage.profile.coinShadows,
  });
  const families: readonly PrizeFamily[] = listParam(
    'families',
    PRIZE_FAMILIES,
    PRIZE_FAMILIES.slice(0, 2),
  );
  const rarities: readonly PrizeRarity[] = listParam('rarities', PRIZE_RARITIES);
  const pitchX = Math.min(0.068, (2 * PLAYFIELD.fieldHalfWidth - 0.02) / rarities.length);
  const pitchZ = 0.1;
  const frontZ = PLAYFIELD.fieldFrontZ - 0.055;
  const views = families.flatMap((family, row) =>
    rarities.map((rarity, column) => {
      const view = kit.create(family, { rarity, reducedMotion: reduced });
      view.object3d.position.set(
        (column - (rarities.length - 1) / 2) * pitchX,
        view.halfExtents.y,
        frontZ - row * pitchZ,
      );
      view.object3d.rotation.y = (column - (rarities.length - 1) / 2) * 0.12;
      stage.scene.add(view.object3d);
      return view;
    }),
  );
  state.prizes = views.length;
  state.drawCalls = views.reduce((sum, view) => sum + view.drawCalls, 0);

  const glint = params.get('glint');
  const frozenGlint = glint !== null && glint !== '' ? Number(glint) : null;
  if (frozenGlint !== null) {
    for (const view of views) {
      view.glint();
      view.update(frozenGlint);
    }
  }
  const close = params.has('close');
  const cam = vectorParam('cam');
  const look = vectorParam('look');
  let nextGlint = 0.6;
  let elapsedSeconds = 0;
  let frames = 0;
  stage.onFrame((delta) => {
    applyCameraPreset(stage.camera, venue.cameraPreset(stage.camera.aspect));
    if (close) stage.camera.position.set(0, 0.075, frontZ + 0.1);
    if (cam) stage.camera.position.copy(cam);
    if (close || cam || look) stage.camera.lookAt(look ?? new Vector3(0, 0, frontZ - 0.01));
    stage.camera.updateProjectionMatrix();
    elapsedSeconds += delta;
    if (glint === '' && elapsedSeconds >= nextGlint) {
      for (const view of views) view.glint();
      nextGlint += 3;
    }
    for (const view of views) view.update(frozenGlint === null ? delta : 0);
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
  console.error('[prizes] preview could not start', error);
});
