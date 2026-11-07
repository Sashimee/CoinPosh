import {
  AgXToneMapping,
  Group,
  PCFShadowMap,
  Vector3,
  type DataTexture,
  type Scene,
  type WebGPURenderer,
} from 'three/webgpu';
import { applyHdriEnvironment, SUNSET_HDRI } from '../../env/environment.ts';
import { createOcean } from '../../env/ocean.ts';
import { createSunsetSky } from '../../env/sky.ts';
import { CALM_SEA, DeckSway, type SwayPose } from '../../env/sway.ts';
import { createRivieraDeck } from './deck.ts';
import { RIVIERA_DECK, rivieraCameraPreset, type CameraPreset } from './layout.ts';
import { createRivieraLighting, type RivieraLighting } from './lighting.ts';
import { createRivieraMaterials, disposeMaterials } from './materials.ts';
import { rivieraTokens, rivieraTones } from './palette.ts';
import { createRivieraTable, type RivieraTable } from './table.ts';

export { rivieraTokens, rivieraTones, paletteCssVariables } from './palette.ts';
export { RIVIERA_TABLE, rivieraCameraPreset, applyCameraPreset } from './layout.ts';
export type { CameraPreset } from './layout.ts';

/** Bearing of the low sunset, behind the table and a little to port. */
const SUN_DIRECTION = new Vector3(-0.42, 0.03, -0.9).normalize();
const EXPOSURE = 0.85;
const ENVIRONMENT_INTENSITY = 0.32;
const ENVIRONMENT_GRADE = { maxRadiance: 6, tint: [1.15, 0.86, 0.72] } as const;
const REDUCED_MOTION_WAVE_RATE = 0.3;

export interface RivieraVenueOptions {
  /** Shadow-casting key light. Quality tiers (T-1.06) may turn it off on low-end devices. */
  readonly shadows?: boolean;
  /** Freezes deck sway and slows the sea. Defaults to the OS `prefers-reduced-motion`. */
  readonly reducedMotion?: boolean;
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
 * rail, the procedural sunset sky and sea, the HDRI environment and the venue's lights. It
 * also sets the renderer's AgX tonemapping and exposure for this venue. Resolves once the
 * HDRI is loaded so the first frame is fully lit.
 */
export async function createRivieraVenue(
  scene: Scene,
  renderer: WebGPURenderer,
  options: RivieraVenueOptions = {},
): Promise<RivieraVenue> {
  const shadows = options.shadows ?? true;
  let reducedMotion = options.reducedMotion ?? prefersReducedMotion();

  renderer.toneMapping = AgXToneMapping;
  renderer.toneMappingExposure = EXPOSURE;
  renderer.shadowMap.enabled = shadows;
  renderer.shadowMap.type = PCFShadowMap;

  const root = new Group();
  root.name = 'venue-riviera';

  const materials = createRivieraMaterials();
  const table = createRivieraTable(materials, shadows);
  const deck = createRivieraDeck(materials, shadows);
  const lighting = createRivieraLighting({ sunDirection: SUN_DIRECTION, shadows });

  const backdrop = new Group();
  backdrop.name = 'riviera-backdrop';
  const sky = createSunsetSky({
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
    sky,
    deepColor: rivieraTones.seaDeep,
    shallowColor: rivieraTones.seaShallow,
    glintColor: rivieraTones.skyHaze,
    level: RIVIERA_DECK.seaLevel,
  });
  backdrop.add(sky.mesh, ocean.mesh);

  root.add(backdrop, deck.group, table.group, lighting.group);

  let environment: DataTexture;
  try {
    environment = await applyHdriEnvironment(scene, {
      hdri: SUNSET_HDRI,
      sunYaw: Math.atan2(SUN_DIRECTION.z, SUN_DIRECTION.x),
      intensity: ENVIRONMENT_INTENSITY,
      grade: ENVIRONMENT_GRADE,
    });
  } catch (error) {
    disposeMaterials(materials);
    table.dispose();
    deck.dispose();
    sky.dispose();
    ocean.dispose();
    lighting.dispose();
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
      environment.dispose();
      disposeMaterials(materials);
      table.dispose();
      deck.dispose();
      sky.dispose();
      ocean.dispose();
      lighting.dispose();
    },
  };
}
