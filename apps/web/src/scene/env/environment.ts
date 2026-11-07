import {
  DataTexture,
  EquirectangularReflectionMapping,
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  type Scene,
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import veniceSunsetUrl from './hdri/venice_sunset_512.ktx2?url';

export interface HdriAsset {
  readonly url: string;
  /** Yaw (radians, about +Y) of the brightest sky region in three's equirect convention. */
  readonly sunYaw: number;
}

/**
 * Poly Haven "Venice Sunset", CC0, pre-graded and packed as a zstd RGBA16F KTX2 by
 * `hdri/derive-environment.mjs`. Source, licence and derivation are in hdri/SOURCES.md.
 */
export const SUNSET_HDRI: HdriAsset = {
  url: veniceSunsetUrl,
  sunYaw: (614.5 / 1024 - 0.5) * 2 * Math.PI,
};

export interface EnvironmentOptions {
  readonly hdri: HdriAsset;
  /** Yaw of the venue's sun; the HDRI is rotated so its glow sits behind the venue's sun. */
  readonly sunYaw: number;
  readonly intensity: number;
}

/** Rotation about +Y that lines the HDRI's sun up with the venue's sun. */
export function environmentYaw(hdri: HdriAsset, venueSunYaw: number): number {
  return hdri.sunYaw - venueSunYaw;
}

/**
 * Lights the scene with an HDRI used only for image-based lighting and reflections; the
 * visible backdrop is procedural. WebGPURenderer pre-filters equirect environments into a
 * PMREM on first use, so no PMREMGenerator is needed here. The renderer is only used to
 * initialise the KTX2 loader; the returned texture keeps its texels on the CPU so a rebuilt
 * renderer re-uploads it after a device loss.
 */
export async function applyHdriEnvironment(
  scene: Scene,
  renderer: WebGPURenderer,
  options: EnvironmentOptions,
): Promise<Texture> {
  const loader = new KTX2Loader().detectSupport(renderer);
  let texture: Texture;
  try {
    texture = await loader.loadAsync(options.hdri.url);
  } catch (error) {
    throw new Error(
      `Venue environment HDRI failed to load from ${options.hdri.url}; check that the asset was bundled`,
      { cause: error },
    );
  } finally {
    loader.dispose();
  }
  if (!(texture instanceof DataTexture) || texture.type !== HalfFloatType) {
    throw new Error('Venue HDRI must decode to an uncompressed half-float texture');
  }
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = LinearSRGBColorSpace;
  texture.mapping = EquirectangularReflectionMapping;
  texture.name = 'venue-hdri';
  texture.needsUpdate = true;
  scene.environment = texture;
  scene.environmentIntensity = options.intensity;
  scene.environmentRotation.set(0, environmentYaw(options.hdri, options.sunYaw), 0);
  return texture;
}
