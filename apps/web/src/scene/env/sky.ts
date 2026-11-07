import {
  BackSide,
  ClampToEdgeWrapping,
  Color,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  NoColorSpace,
  RepeatWrapping,
  SphereGeometry,
  type DataTexture,
  type Node,
  type Texture,
  type Vector3,
  type WebGPURenderer,
} from 'three/webgpu';
import {
  atan,
  cos,
  dot,
  float,
  max,
  mix,
  mx_fractal_noise_float,
  normalize,
  positionLocal,
  pow,
  saturate,
  sin,
  smoothstep,
  sqrt,
  texture as sampleTexture,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { bakeTexture } from './bake.ts';

export interface SunsetSkyColors {
  readonly zenith: string;
  readonly upper: string;
  readonly rose: string;
  readonly horizon: string;
  readonly haze: string;
  readonly sun: string;
  readonly cloudShadow: string;
}

export interface SunsetSkyOptions {
  readonly colors: SunsetSkyColors;
  /** Direction towards the sun in the backdrop's local frame; normalised on use. */
  readonly sunDirection: Vector3;
  /** Linear HDR multiplier on the sun disc, so it blooms and glints in reflections. */
  readonly sunIntensity?: number;
  readonly radius?: number;
  /** Cloud coverage from {@link bakeCloudCoverage}; without it the sky is clear. */
  readonly clouds?: Texture | null;
}

export interface SunsetSky {
  readonly mesh: Mesh;
  readonly sunDirection: Vector3;
  /** Linear radiance seen along a backdrop-local direction. */
  radiance(direction: Node<'vec3'>, options?: { clouds?: boolean }): Node<'vec3'>;
  /**
   * A few ALU ops approximating the sky just above the horizon (no gradient stack, clouds or
   * sun disc), for distance haze where the full radiance would be wasted.
   */
  horizonRadiance(direction: Node<'vec3'>): Node<'vec3'>;
  dispose(): void;
}

const SUN_DISC_COS_OUTER = Math.cos((0.62 * Math.PI) / 180);
const SUN_DISC_COS_INNER = Math.cos((0.48 * Math.PI) / 180);
/** Clouds live between the horizon and h = sin(elevation) = 0.5; the bake covers that band. */
const CLOUD_MAX_HEIGHT = 0.5;
const CLOUD_TEXTURE_SIZE = { width: 2048, height: 512 } as const;

function linear(hex: string): Node<'vec3'> {
  const c = new Color(hex);
  return vec3(c.r, c.g, c.b);
}

/**
 * Bakes the cloud layer's fractal noise into an equirect band: U is azimuth measured from -Z
 * (so the wrap sits behind the player) and V is height h = d.y from 0 to 0.5. Coverage is in
 * the red channel. The bake is periodic in U because it is driven by sin/cos of the azimuth.
 */
export function bakeCloudCoverage(
  renderer: WebGPURenderer,
  textureScale = 1,
): Promise<DataTexture> {
  const width = Math.max(256, Math.round(CLOUD_TEXTURE_SIZE.width * textureScale));
  const height = Math.max(64, Math.round(CLOUD_TEXTURE_SIZE.height * textureScale));
  return bakeTexture(
    renderer,
    (uv) => {
      const azimuth = uv.x.mul(Math.PI * 2);
      const h = uv.y.mul(CLOUD_MAX_HEIGHT);
      const r = sqrt(float(1).sub(h.mul(h)));
      const dx = sin(azimuth).mul(r).negate();
      const dz = cos(azimuth).mul(r).negate();
      const lift = max(h, 0.0).add(0.035);
      const stretched = vec3(dx.div(lift).mul(0.18), dz.div(lift).mul(0.75), 3.1);
      const n = mx_fractal_noise_float(stretched, 4, 2.0, 0.5);
      const band = smoothstep(0.02, 0.1, h).mul(float(1).sub(smoothstep(0.22, 0.5, h)));
      const coverage = smoothstep(0.0, 0.4, n).mul(band);
      return vec4(coverage, coverage, coverage, 1);
    },
    {
      name: 'sky/cloud-coverage',
      width,
      height,
      colorSpace: NoColorSpace,
      wrapS: RepeatWrapping,
      wrapT: ClampToEdgeWrapping,
    },
  ).then((texture) => {
    // The dome magnifies this texture everywhere, and mip selection across the azimuth wrap
    // would draw a seam, so it is sampled from the base level only.
    texture.minFilter = LinearFilter;
    texture.generateMipmaps = false;
    return texture;
  });
}

export function createSunsetSky(options: SunsetSkyOptions): SunsetSky {
  const { colors } = options;
  const sunDirection = options.sunDirection.clone().normalize();
  const sunUniform = uniform(sunDirection);
  const sunIntensity = uniform(options.sunIntensity ?? 60);
  const cloudMap = options.clouds ?? null;

  const zenith = linear(colors.zenith);
  const upper = linear(colors.upper);
  const rose = linear(colors.rose);
  const horizon = linear(colors.horizon);
  const haze = linear(colors.haze);
  const sunColor = linear(colors.sun);
  const cloudShadow = linear(colors.cloudShadow);

  const radiance = (direction: Node<'vec3'>, { clouds = false } = {}): Node<'vec3'> => {
    const d = normalize(direction);
    const h = d.y;
    const cosSun = dot(d, sunUniform);
    const towardSun = saturate(cosSun.mul(0.5).add(0.5));

    let sky = mix(horizon, rose, smoothstep(0.0, 0.07, h));
    sky = mix(sky, upper, smoothstep(0.05, 0.24, h));
    sky = mix(sky, zenith, smoothstep(0.2, 0.75, h));
    const lowBand = float(1).sub(smoothstep(0.0, 0.18, h));
    sky = sky.add(haze.mul(pow(towardSun, 14).mul(lowBand).mul(0.75)));
    sky = mix(sky, haze, pow(saturate(float(1).sub(h.abs().mul(32))), 3).mul(0.35));

    if (clouds && cloudMap) {
      const azimuth = atan(d.x.negate(), d.z.negate());
      const cloudUv = vec2(azimuth.div(Math.PI * 2), h.div(CLOUD_MAX_HEIGHT));
      const coverage = sampleTexture(cloudMap, cloudUv).r;
      const lit = mix(cloudShadow, horizon.mul(1.35), pow(towardSun, 3));
      const silver = haze.mul(pow(towardSun, 18).mul(2.4));
      sky = mix(sky, lit.add(silver), coverage.mul(0.9));
    }

    const halo = pow(saturate(cosSun), 48)
      .mul(0.55)
      .add(pow(saturate(cosSun), 900).mul(4.0));
    const disc = smoothstep(SUN_DISC_COS_OUTER, SUN_DISC_COS_INNER, cosSun);
    const aboveHorizon = smoothstep(-0.004, 0.004, h);
    sky = sky.add(sunColor.mul(halo.mul(aboveHorizon.mul(0.7).add(0.3))));
    sky = sky.add(sunColor.mul(disc.mul(sunIntensity).mul(aboveHorizon)));
    return sky;
  };

  const horizonRadiance = (direction: Node<'vec3'>): Node<'vec3'> => {
    const d = normalize(direction);
    const cosSun = saturate(dot(d, sunUniform));
    const towardSun = cosSun.mul(0.5).add(0.5);
    const glow = mix(horizon.add(haze.mul(pow(towardSun, 14).mul(0.75))), haze, 0.35);
    return glow.add(sunColor.mul(pow(cosSun, 48).mul(0.36)));
  };

  const material = new MeshBasicNodeMaterial({ side: BackSide, fog: false });
  material.colorNode = radiance(positionLocal, { clouds: true });
  const radius = options.radius ?? 90;
  const geometry = new SphereGeometry(radius, 48, 24);
  const mesh = new Mesh(geometry, material);
  mesh.name = 'sunset-sky';
  mesh.frustumCulled = false;

  return {
    mesh,
    sunDirection,
    radiance,
    horizonRadiance,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
