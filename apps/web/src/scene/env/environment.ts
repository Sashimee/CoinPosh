import { EquirectangularReflectionMapping, type DataTexture, type Scene } from 'three/webgpu';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import veniceSunsetUrl from './hdri/venice_sunset_512.hdr?url';

export interface HdriAsset {
  readonly url: string;
  /** Yaw (radians, about +Y) of the brightest sky region in three's equirect convention. */
  readonly sunYaw: number;
}

/**
 * Poly Haven "Venice Sunset", CC0, pre-graded and downsampled offline by `hdri/bake-hdri.mjs`.
 * Source, grade and checksum are recorded in hdri/SOURCES.md.
 */
export const SUNSET_HDRI: HdriAsset = {
  url: veniceSunsetUrl,
  sunYaw: (307.25 / 512 - 0.5) * 2 * Math.PI,
};

export interface EnvironmentOptions {
  readonly hdri: HdriAsset;
  /** Yaw of the venue's sun; the HDRI is rotated so its glow sits behind the venue's sun. */
  readonly sunYaw: number;
  readonly intensity: number;
}

/**
 * Lights the scene with an HDRI used only for image-based lighting and reflections; the
 * visible backdrop is procedural. WebGPURenderer pre-filters equirect environments into a
 * PMREM on first use, so no PMREMGenerator is needed here.
 */
export async function applyHdriEnvironment(
  scene: Scene,
  options: EnvironmentOptions,
): Promise<DataTexture> {
  const texture = await new HDRLoader().loadAsync(options.hdri.url).catch((error: unknown) => {
    throw new Error(
      `Venue environment HDRI failed to load from ${options.hdri.url}; check that the asset was bundled`,
      { cause: error },
    );
  });
  texture.mapping = EquirectangularReflectionMapping;
  texture.name = 'venue-hdri';
  scene.environment = texture;
  scene.environmentIntensity = options.intensity;
  scene.environmentRotation.set(0, options.hdri.sunYaw - options.sunYaw, 0);
  return texture;
}
