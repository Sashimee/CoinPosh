import {
  BackSide,
  Color,
  Mesh,
  MeshBasicNodeMaterial,
  SphereGeometry,
  type Node,
  type Texture,
  type Vector3,
} from 'three/webgpu';
import {
  dot,
  float,
  max,
  mix,
  normalize,
  positionLocal,
  pow,
  saturate,
  smoothstep,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import { decodeNoise, NOISE_CHANNELS, sampleNoiseAtlas } from './noise-texture.ts';

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
  /** Baked noise atlas the cloud band is read from (see `createNoiseTexture`). */
  readonly noise: Texture;
  /** Paints the streaky cloud band on the dome. Low quality tiers turn it off. */
  readonly clouds?: boolean;
}

export interface SunsetSky {
  readonly mesh: Mesh;
  readonly sunDirection: Vector3;
  /** Linear radiance seen along a backdrop-local direction. */
  radiance(direction: Node<'vec3'>, options?: { clouds?: boolean }): Node<'vec3'>;
  dispose(): void;
}

const SUN_DISC_COS_OUTER = Math.cos((0.62 * Math.PI) / 180);
const SUN_DISC_COS_INNER = Math.cos((0.48 * Math.PI) / 180);

function linear(hex: string): Node<'vec3'> {
  const c = new Color(hex);
  return vec3(c.r, c.g, c.b);
}

export function createSunsetSky(options: SunsetSkyOptions): SunsetSky {
  const { colors } = options;
  const sunDirection = options.sunDirection.clone().normalize();
  const sunUniform = uniform(sunDirection);
  const sunIntensity = uniform(options.sunIntensity ?? 60);

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

    if (clouds) {
      const lift = max(h, 0.0).add(0.035);
      const { cloud } = NOISE_CHANNELS;
      const stretched = vec2(
        d.x.div(lift).mul(0.18 / cloud.cellsX),
        d.z.div(lift).mul(0.75 / cloud.cellsY),
      ).add(0.37);
      const n = decodeNoise(sampleNoiseAtlas(options.noise, stretched), cloud);
      const band = smoothstep(0.02, 0.1, h).mul(float(1).sub(smoothstep(0.22, 0.5, h)));
      const coverage = smoothstep(0.0, 0.4, n).mul(band);
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

  const material = new MeshBasicNodeMaterial({ side: BackSide, fog: false });
  material.colorNode = radiance(positionLocal, { clouds: options.clouds ?? true });
  const radius = options.radius ?? 90;
  const geometry = new SphereGeometry(radius, 48, 24);
  const mesh = new Mesh(geometry, material);
  mesh.name = 'sunset-sky';
  mesh.frustumCulled = false;

  return {
    mesh,
    sunDirection,
    radiance,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
