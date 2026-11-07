import {
  DataUtils,
  EquirectangularReflectionMapping,
  HalfFloatType,
  type DataTexture,
  type Scene,
} from 'three/webgpu';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import veniceSunsetUrl from './hdri/venice_sunset_1k.hdr?url';

export interface HdriAsset {
  readonly url: string;
  /** Yaw (radians, about +Y) of the brightest sky region in three's equirect convention. */
  readonly sunYaw: number;
}

/** Poly Haven "Venice Sunset", CC0. Source and licence are recorded in hdri/SOURCES.md. */
export const SUNSET_HDRI: HdriAsset = {
  url: veniceSunsetUrl,
  sunYaw: (614.5 / 1024 - 0.5) * 2 * Math.PI,
};

export interface EnvironmentOptions {
  readonly hdri: HdriAsset;
  /** Yaw of the venue's sun; the HDRI is rotated so its glow sits behind the venue's sun. */
  readonly sunYaw: number;
  readonly intensity: number;
  /** Optional grade baked into the HDRI texels before it is PMREM-filtered. */
  readonly grade?: RadianceGrade;
}

export interface RadianceGrade {
  /**
   * Caps every texel's brightest channel, preserving hue. The venue lights its sun with an
   * analytic rim light, so the HDRI's own sun is clipped to stop it flooding rough surfaces
   * with a second, unshadowed sun once PMREM-blurred.
   */
  readonly maxRadiance: number;
  /** Linear RGB multiplier, so a photographed sky can be warmed to match the painted one. */
  readonly tint: readonly [number, number, number];
}

/** Applies a {@link RadianceGrade} in place to RGBA half-float texels; returns texels clipped. */
export function gradeHalfFloatRadiance(data: Uint16Array, grade: RadianceGrade): number {
  const { maxRadiance, tint } = grade;
  if (!(maxRadiance > 0)) throw new RangeError(`maxRadiance must be positive, got ${maxRadiance}`);
  if (tint.some((channel) => !(channel >= 0))) {
    throw new RangeError(`tint channels must be non-negative, got ${tint.join(', ')}`);
  }
  let clipped = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    const r = DataUtils.fromHalfFloat(data[i] ?? 0) * tint[0];
    const g = DataUtils.fromHalfFloat(data[i + 1] ?? 0) * tint[1];
    const b = DataUtils.fromHalfFloat(data[i + 2] ?? 0) * tint[2];
    const peak = Math.max(r, g, b);
    const scale = peak > maxRadiance ? maxRadiance / peak : 1;
    if (scale < 1) clipped += 1;
    data[i] = DataUtils.toHalfFloat(r * scale);
    data[i + 1] = DataUtils.toHalfFloat(g * scale);
    data[i + 2] = DataUtils.toHalfFloat(b * scale);
  }
  return clipped;
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
  if (options.grade) {
    const data: unknown = texture.image.data;
    if (texture.type !== HalfFloatType || !(data instanceof Uint16Array)) {
      throw new Error('Venue HDRI must decode to half-float RGBA data to be graded');
    }
    gradeHalfFloatRadiance(data, options.grade);
    texture.needsUpdate = true;
  }
  texture.mapping = EquirectangularReflectionMapping;
  texture.name = 'venue-hdri';
  scene.environment = texture;
  scene.environmentIntensity = options.intensity;
  scene.environmentRotation.set(0, options.hdri.sunYaw - options.sunYaw, 0);
  return texture;
}
