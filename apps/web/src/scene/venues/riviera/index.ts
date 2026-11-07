import {
  AgXToneMapping,
  Group,
  PCFShadowMap,
  type Scene,
  type ShadowMapType,
  type Texture,
  type Vector3,
  type ToneMapping,
  type WebGPURenderer,
} from 'three/webgpu';
import { applyHdriEnvironment, environmentYaw, SUNSET_HDRI } from '../../env/environment.ts';
import { createOcean } from '../../env/ocean.ts';
import { bakeCloudCoverage, createSunsetSky } from '../../env/sky.ts';
import { CALM_SEA, DeckSway, type SwayPose } from '../../env/sway.ts';
import { createRivieraDeck } from './deck.ts';
import {
  RIVIERA_DECK,
  RIVIERA_SUN_DIRECTION,
  rivieraCameraPreset,
  type CameraPreset,
} from './layout.ts';
import { createRivieraLighting, type RivieraLighting } from './lighting.ts';
import { createRivieraMaterials, disposeMaterials, setMaterialEnvironment } from './materials.ts';
import { rivieraTokens, rivieraTones } from './palette.ts';
import { resolveRivieraQuality, type RivieraQuality, type RivieraQualityTier } from './quality.ts';
import { createRivieraTable, type RivieraTable } from './table.ts';
import { bakePlanks, CABIN_SOLE, DECK_PLANKING } from './wood.ts';

export { rivieraTokens, rivieraTones, paletteCssVariables } from './palette.ts';
export {
  RIVIERA_SUN_DIRECTION,
  RIVIERA_TABLE,
  rivieraCameraPreset,
  applyCameraPreset,
} from './layout.ts';
export type { CameraPreset } from './layout.ts';
export { RIVIERA_QUALITY, resolveRivieraQuality } from './quality.ts';
export type { RivieraQuality, RivieraQualityTier } from './quality.ts';

const ENVIRONMENT_INTENSITY = 0.32;
/** Lacquer and gelcoat see the environment brighter so their clearcoats mirror the sunset. */
const LACQUER_ENVIRONMENT_INTENSITY = 1.15;
const GELCOAT_ENVIRONMENT_INTENSITY = 1.1;
const REDUCED_MOTION_WAVE_RATE = 0.3;

export interface RendererSettings {
  readonly toneMapping: ToneMapping;
  readonly toneMappingExposure: number;
  readonly shadowMapType: ShadowMapType;
}

/** The venue's renderer state, per the art bible: AgX at a slightly low exposure. */
export const rivieraRendererSettings: RendererSettings = Object.freeze({
  toneMapping: AgXToneMapping,
  toneMappingExposure: 0.85,
  shadowMapType: PCFShadowMap,
});

/**
 * Applies {@link rivieraRendererSettings}. The venue factory leaves the renderer alone, so the
 * stage calls this when the venue is mounted and again whenever it rebuilds the renderer.
 */
export function applyRivieraRendererSettings(
  renderer: WebGPURenderer,
  options: { readonly shadows?: boolean } = {},
): void {
  renderer.toneMapping = rivieraRendererSettings.toneMapping;
  renderer.toneMappingExposure = rivieraRendererSettings.toneMappingExposure;
  renderer.shadowMap.enabled = options.shadows ?? true;
  renderer.shadowMap.type = rivieraRendererSettings.shadowMapType;
}

export interface RivieraVenueOptions {
  /** Shadow-casting key light. Quality tiers (T-1.06) may turn it off on low-end devices. */
  readonly shadows?: boolean;
  /** Freezes deck sway and slows the sea. Defaults to the OS `prefers-reduced-motion`. */
  readonly reducedMotion?: boolean;
  /** Render-cost tier or overrides (on top of `high`). Rebuild the venue to change it. */
  readonly quality?: RivieraQualityTier | Partial<RivieraQuality>;
}

export interface RivieraVenue {
  readonly id: 'riviera';
  readonly root: Group;
  readonly table: RivieraTable;
  readonly lighting: RivieraLighting;
  readonly tokens: typeof rivieraTokens;
  readonly quality: RivieraQuality;
  /** Deck sway hook: read `sway.pose` or `sway.subscribe(...)` to move cameras or props. */
  readonly sway: DeckSway;
  readonly sunDirection: Vector3;
  cameraPreset(aspect: number): CameraPreset;
  /** 0 = pusher retracted, 1 = full stroke. Drive it from the sim's pusher phase. */
  setPusherStroke(stroke01: number): void;
  setReducedMotion(reduced: boolean): void;
  /** Call once per rendered frame with the frame delta. */
  update(deltaSeconds: number): SwayPose;
  dispose(): void;
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Awaits every texture; if any fails, disposes the ones that loaded and rethrows. */
async function settleTextures<const T extends readonly Promise<Texture>[]>(
  tasks: T,
): Promise<{ -readonly [K in keyof T]: Texture }> {
  const results = await Promise.allSettled(tasks);
  const loaded = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failure) {
    for (const texture of loaded) texture.dispose();
    throw failure.reason;
  }
  return loaded as { -readonly [K in keyof T]: Texture };
}

/**
 * Builds the Riviera Yacht venue into `scene`: the lacquered table, the teak deck and stern
 * rail, the procedural sunset sky and sea, the HDRI environment and the venue's lights. It bakes
 * the procedural teak and cloud textures once with `renderer` and otherwise leaves the renderer
 * untouched; call {@link applyRivieraRendererSettings} for tonemapping and shadows. Resolves
 * once the environment and bakes are ready so the first frame is fully lit.
 */
export async function createRivieraVenue(
  scene: Scene,
  renderer: WebGPURenderer,
  options: RivieraVenueOptions = {},
): Promise<RivieraVenue> {
  const shadows = options.shadows ?? true;
  const quality = resolveRivieraQuality(options.quality);
  let reducedMotion = options.reducedMotion ?? prefersReducedMotion();
  const sunDirection = RIVIERA_SUN_DIRECTION.clone();
  const sunYaw = Math.atan2(sunDirection.z, sunDirection.x);
  const anisotropy = quality.textureScale < 1 ? 4 : 8;

  const previousEnvironment = scene.environment;
  const [sole, deckTexture, clouds, environment] = await settleTextures([
    bakePlanks(renderer, CABIN_SOLE, quality.textureScale, anisotropy),
    bakePlanks(renderer, DECK_PLANKING, quality.textureScale, anisotropy),
    bakeCloudCoverage(renderer, quality.textureScale),
    applyHdriEnvironment(scene, renderer, {
      hdri: SUNSET_HDRI,
      sunYaw,
      intensity: ENVIRONMENT_INTENSITY,
    }),
  ]).catch((error: unknown) => {
    scene.environment = previousEnvironment;
    throw error;
  });
  const textures = [sole, deckTexture, clouds, environment];

  const root = new Group();
  root.name = 'venue-riviera';

  const materials = createRivieraMaterials({ sole, deck: deckTexture }, quality);
  const environmentRotation = environmentYaw(SUNSET_HDRI, sunYaw);
  setMaterialEnvironment(
    materials.lacquer,
    environment,
    environmentRotation,
    LACQUER_ENVIRONMENT_INTENSITY,
  );
  setMaterialEnvironment(
    materials.gelcoat,
    environment,
    environmentRotation,
    GELCOAT_ENVIRONMENT_INTENSITY,
  );
  const table = createRivieraTable(materials, shadows);
  const deck = createRivieraDeck(materials, shadows);
  const lighting = createRivieraLighting({ sunDirection, shadows });

  const backdrop = new Group();
  backdrop.name = 'riviera-backdrop';
  const sky = createSunsetSky({
    sunDirection,
    clouds,
    colors: {
      zenith: rivieraTones.skyZenith,
      upper: rivieraTones.skyUpper,
      rose: rivieraTones.skyRose,
      horizon: rivieraTones.skyHorizon,
      haze: rivieraTones.skyHaze,
      sun: rivieraTones.sun,
      cloudShadow: rivieraTones.cloudShadow,
    },
  });
  const ocean = createOcean({
    sky,
    deepColor: rivieraTones.seaDeep,
    shallowColor: rivieraTones.seaShallow,
    glintColor: rivieraTones.skyHaze,
    level: RIVIERA_DECK.seaLevel,
    swells: quality.swells,
    ripples: quality.ripples,
  });
  backdrop.add(sky.mesh, ocean.mesh);

  root.add(backdrop, deck.group, table.group, lighting.group);
  scene.add(root);

  const sway = new DeckSway(CALM_SEA, reducedMotion ? 0 : 1);

  return {
    id: 'riviera',
    root,
    table,
    lighting,
    tokens: rivieraTokens,
    quality,
    sway,
    sunDirection: sunDirection.clone(),
    cameraPreset: rivieraCameraPreset,
    setPusherStroke: (stroke01) => {
      table.setPusherStroke(stroke01);
    },
    setReducedMotion(reduced) {
      reducedMotion = reduced;
      sway.intensity = reduced ? 0 : 1;
    },
    update(deltaSeconds) {
      const dt = Math.min(Math.max(deltaSeconds, 0), 0.25);
      ocean.time.value += dt * (reducedMotion ? REDUCED_MOTION_WAVE_RATE : 1);
      const pose = sway.update(dt);
      backdrop.rotation.set(-pose.pitch, 0, -pose.roll);
      backdrop.position.y = -pose.heave;
      return pose;
    },
    dispose() {
      scene.remove(root);
      if (scene.environment === environment) scene.environment = null;
      disposeMaterials(materials);
      for (const texture of textures) texture.dispose();
      table.dispose();
      deck.dispose();
      sky.dispose();
      ocean.dispose();
      lighting.dispose();
    },
  };
}
