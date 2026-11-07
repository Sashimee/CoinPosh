import { Group, type Scene, type Texture, type Vector3 } from 'three/webgpu';
import {
  applyHdriEnvironment,
  SUNSET_HDRI,
  type EnvironmentOptions,
} from '../../env/environment.ts';
import { createNoiseTexture } from '../../env/noise-texture.ts';
import { applyRenderLook, type LookRenderer, type RenderLook } from '../../post/look.ts';
import { createOcean } from '../../env/ocean.ts';
import { createSunsetSky } from '../../env/sky.ts';
import { CALM_SEA, DeckSway, type SwayPose } from '../../env/sway.ts';
import { createRivieraDeck } from './deck.ts';
import {
  RIVIERA_DECK,
  RIVIERA_SUN_DIRECTION,
  rivieraCameraPreset,
  type CameraPreset,
} from './layout.ts';
import { createRivieraLighting, type RivieraLighting } from './lighting.ts';
import { createRivieraMaterials, disposeMaterials, type RivieraQuality } from './materials.ts';
import { rivieraTokens, rivieraTones } from './palette.ts';
import { createRivieraTable, type RivieraTable } from './table.ts';

export { rivieraTokens, rivieraTones, paletteCssVariables } from './palette.ts';
export { RIVIERA_TABLE, rivieraCameraPreset, applyCameraPreset } from './layout.ts';
export type { CameraPreset } from './layout.ts';
export type { RivieraQuality } from './materials.ts';

const SUN_DIRECTION = RIVIERA_SUN_DIRECTION;
const REDUCED_MOTION_WAVE_RATE = 0.3;
const MAX_FRAME_DELTA = 0.25;

/**
 * The Riviera grade from the art bible: AgX at 0.85 and a restrained 0.32 IBL, with the
 * key light's shadow map. Hand it to the post pipeline (`createAdaptiveRendering` /
 * `post.setLook`), which is the only writer of these renderer settings.
 */
export const RIVIERA_RENDER_LOOK: RenderLook = {
  exposure: 0.85,
  environmentIntensity: 0.32,
  shadows: true,
};

/** The sunset rim light; the post vignette leans toward it so the frame edges glow warm. */
export const RIVIERA_VIGNETTE_TINT = rivieraTones.rimWarm;

export type EnvironmentLoader = (scene: Scene, options: EnvironmentOptions) => Promise<Texture>;

export interface RivieraVenueOptions {
  /**
   * Shadow-casting key light; must match the `shadows` of the look the renderer was given.
   * Defaults to `RIVIERA_RENDER_LOOK.shadows`.
   */
  readonly shadows?: boolean;
  /**
   * `low` drops the deck's clearcoat, the sea's near-hull ripples and the sky's cloud band
   * for weak GPUs; `high` (the default) is the full look. Set by the quality tiers (T-1.06).
   */
  readonly quality?: RivieraQuality;
  /** Freezes deck sway and slows the sea. Defaults to the OS `prefers-reduced-motion`. */
  readonly reducedMotion?: boolean;
  /**
   * Installs the image-based lighting on the scene and resolves with the texture it set.
   * Defaults to loading the bundled sunset HDRI; tests inject a stand-in.
   */
  readonly loadEnvironment?: EnvironmentLoader;
}

export interface RivieraVenue {
  readonly id: 'riviera';
  readonly root: Group;
  readonly table: RivieraTable;
  readonly lighting: RivieraLighting;
  readonly tokens: typeof rivieraTokens;
  /** Deck sway hook: read `sway.pose` or `sway.subscribe(...)` to move cameras or props. */
  readonly sway: DeckSway;
  readonly sunDirection: Vector3;
  readonly quality: RivieraQuality;
  /** The grade this venue was built for; its `shadows` matches the venue's shadow casters. */
  readonly look: RenderLook;
  /** Seconds of sea animation so far; advances slower than real time under reduced motion. */
  readonly waveTime: number;
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

/**
 * Builds the Riviera Yacht venue into `scene`: the lacquered table, the teak deck and stern
 * rail, the procedural sunset sky and sea, the HDRI environment and the venue's lights.
 * Resolves once the HDRI is loaded so the first frame is fully lit.
 *
 * The game passes `null` for `renderer`: its post pipeline owns tonemapping, exposure, the
 * shadow map and the IBL intensity, fed with `venue.look`. A harness that renders without
 * the post pipeline passes its renderer and the venue applies `look` through
 * `applyRenderLook`.
 */
export async function createRivieraVenue(
  scene: Scene,
  renderer: LookRenderer | null,
  options: RivieraVenueOptions = {},
): Promise<RivieraVenue> {
  const shadows = options.shadows ?? RIVIERA_RENDER_LOOK.shadows;
  const look: RenderLook = { ...RIVIERA_RENDER_LOOK, shadows };
  const quality = options.quality ?? 'high';
  const loadEnvironment = options.loadEnvironment ?? applyHdriEnvironment;
  let reducedMotion = options.reducedMotion ?? prefersReducedMotion();

  if (renderer) applyRenderLook(renderer, scene, look);

  const root = new Group();
  root.name = 'venue-riviera';

  const noise = createNoiseTexture();
  const materials = createRivieraMaterials({ noise, quality });
  const table = createRivieraTable(materials, shadows);
  const deck = createRivieraDeck(materials, shadows);
  const lighting = createRivieraLighting({ sunDirection: SUN_DIRECTION, shadows });

  const backdrop = new Group();
  backdrop.name = 'riviera-backdrop';
  const sky = createSunsetSky({
    noise,
    clouds: quality === 'high',
    sunDirection: SUN_DIRECTION,
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
    noise,
    ripples: quality === 'high',
    sky,
    deepColor: rivieraTones.seaDeep,
    shallowColor: rivieraTones.seaShallow,
    glintColor: rivieraTones.skyHaze,
    level: RIVIERA_DECK.seaLevel,
  });
  backdrop.add(sky.mesh, ocean.mesh);

  root.add(backdrop, deck.group, table.group, lighting.group);

  const disposeParts = (): void => {
    disposeMaterials(materials);
    noise.dispose();
    table.dispose();
    deck.dispose();
    sky.dispose();
    ocean.dispose();
    lighting.dispose();
  };

  let environment: Texture;
  try {
    environment = await loadEnvironment(scene, {
      hdri: SUNSET_HDRI,
      sunYaw: Math.atan2(SUN_DIRECTION.z, SUN_DIRECTION.x),
    });
  } catch (error) {
    disposeParts();
    throw error;
  }
  scene.add(root);

  const sway = new DeckSway(CALM_SEA, reducedMotion ? 0 : 1);

  return {
    id: 'riviera',
    root,
    table,
    lighting,
    tokens: rivieraTokens,
    sway,
    sunDirection: SUN_DIRECTION.clone(),
    quality,
    look,
    get waveTime() {
      return ocean.time.value;
    },
    cameraPreset: rivieraCameraPreset,
    setPusherStroke: (stroke01) => {
      table.setPusherStroke(stroke01);
    },
    setReducedMotion(reduced) {
      reducedMotion = reduced;
      sway.intensity = reduced ? 0 : 1;
    },
    update(deltaSeconds) {
      const dt = Number.isFinite(deltaSeconds)
        ? Math.min(Math.max(deltaSeconds, 0), MAX_FRAME_DELTA)
        : 0;
      ocean.time.value += dt * (reducedMotion ? REDUCED_MOTION_WAVE_RATE : 1);
      const pose = sway.update(dt);
      backdrop.rotation.set(-pose.pitch, 0, -pose.roll);
      backdrop.position.y = -pose.heave;
      return pose;
    },
    dispose() {
      scene.remove(root);
      if (scene.environment === environment) scene.environment = null;
      environment.dispose();
      disposeParts();
    },
  };
}
