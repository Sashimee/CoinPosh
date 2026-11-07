import {
  CircleGeometry,
  Color,
  Mesh,
  MeshBasicNodeMaterial,
  Vector2,
  type Node,
} from 'three/webgpu';
import {
  cameraPosition,
  cos,
  dot,
  float,
  length,
  max,
  mix,
  modelWorldMatrixInverse,
  mx_noise_vec3,
  normalize,
  positionLocal,
  pow,
  reflect,
  saturate,
  smoothstep,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { SunsetSky } from './sky.ts';

export interface OceanOptions {
  readonly sky: SunsetSky;
  readonly deepColor: string;
  readonly shallowColor: string;
  /** Colour of the sun's glitter path on the swell. */
  readonly glintColor: string;
  /** Sea level in the backdrop's local frame (below the deck). */
  readonly level: number;
  readonly radius?: number;
  /** Swells summed per pixel, longest first; defaults to all {@link SWELL_COUNT}. */
  readonly swells?: number;
  /** Fine noise ripples near the hull. Defaults to on. */
  readonly ripples?: boolean;
}

export interface Ocean {
  readonly mesh: Mesh;
  /** Seconds of wave animation; the venue advances it (slower under reduced motion). */
  readonly time: { value: number };
  dispose(): void;
}

interface Swell {
  readonly wavelength: number;
  /** Heading in degrees from +Z towards +X. */
  readonly heading: number;
  readonly steepness: number;
  readonly phase: number;
}

const GRAVITY = 9.81;

// Irregular headings and phases, with steepness falling off for the short waves, so no two
// swells line up into the regular corrugation an evenly spaced set reads as.
const SWELLS: readonly Swell[] = [
  { wavelength: 11, heading: 33, steepness: 0.017, phase: 3.43 },
  { wavelength: 6.7, heading: 6.8, steepness: 0.02, phase: 1.1 },
  { wavelength: 3.9, heading: -71, steepness: 0.022, phase: 5.2 },
  { wavelength: 2.35, heading: 18.3, steepness: 0.02, phase: 0.45 },
  { wavelength: 1.42, heading: 118, steepness: 0.017, phase: 1.74 },
  { wavelength: 0.86, heading: -45.2, steepness: 0.014, phase: 3.87 },
  { wavelength: 0.53, heading: 22.7, steepness: 0.011, phase: 2.6 },
  { wavelength: 0.31, heading: -47.5, steepness: 0.008, phase: 5.69 },
];

export const SWELL_COUNT = SWELLS.length;

function linear(hex: string): Node<'vec3'> {
  const c = new Color(hex);
  return vec3(c.r, c.g, c.b);
}

/**
 * Backdrop sea: a flat disc shaded per pixel. Slopes come from analytic sums of deep-water
 * swells (dispersion ω = √(g·k)), each faded out once it falls below a pixel to avoid shimmer,
 * plus fine noise ripples near the hull. Reflections sample the same sky function as the dome
 * (without clouds), so the sun glitter path matches the sky; the far haze uses the sky's cheap
 * horizon approximation, which converges on the dome's colour at the horizon.
 */
export function createOcean(options: OceanOptions): Ocean {
  const time = uniform(0);
  const { sky } = options;
  const swellCount = options.swells ?? SWELL_COUNT;
  if (!Number.isInteger(swellCount) || swellCount < 0 || swellCount > SWELL_COUNT) {
    throw new RangeError(`Ocean swells must be an integer 0..${SWELL_COUNT}, got ${swellCount}`);
  }
  const glintColor = linear(options.glintColor);

  const eye = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz;
  const p = positionLocal.xz;
  const toEye = eye.sub(positionLocal);
  const distance = length(toEye);

  let slopeX: Node<'float'> = float(0);
  let slopeZ: Node<'float'> = float(0);
  for (const swell of SWELLS.slice(0, swellCount)) {
    const heading = (swell.heading * Math.PI) / 180;
    const direction = new Vector2(Math.sin(heading), Math.cos(heading));
    const k = (Math.PI * 2) / swell.wavelength;
    const omega = Math.sqrt(GRAVITY * k);
    const amplitude = swell.steepness / k;
    const fade = float(1).sub(smoothstep(swell.wavelength * 14, swell.wavelength * 45, distance));
    const phase = dot(p, vec2(direction.x, direction.y))
      .mul(k)
      .sub(time.mul(omega))
      .add(swell.phase);
    const slope = cos(phase)
      .mul(amplitude * k)
      .mul(fade);
    slopeX = slopeX.add(slope.mul(direction.x));
    slopeZ = slopeZ.add(slope.mul(direction.y));
  }
  if (options.ripples ?? true) {
    const rippleFade = float(1).sub(smoothstep(4, 14, distance));
    const ripple = mx_noise_vec3(vec3(p.x.mul(2.2), p.y.mul(2.2), time.mul(0.45))).mul(
      rippleFade.mul(0.05),
    );
    slopeX = slopeX.sub(ripple.x);
    slopeZ = slopeZ.sub(ripple.z);
  }
  const normal = normalize(vec3(slopeX.negate(), 1, slopeZ.negate()));

  const view = normalize(toEye);
  const facing = saturate(dot(normal, view));
  const fresnel = float(0.02).add(pow(float(1).sub(facing), 5).mul(0.98));
  const mirrored = reflect(view.negate(), normal);
  const reflected = vec3(mirrored.x, max(mirrored.y, 0.002), mirrored.z);
  const reflection = sky.radiance(reflected).mul(0.5);
  const sunDirection = uniform(sky.sunDirection);
  const sunAlignment = saturate(dot(mirrored, sunDirection));
  const glint = pow(sunAlignment, 380).mul(9).add(pow(sunAlignment, 50).mul(0.35));

  const crest = saturate(dot(normal.xz, sunDirection.xz.normalize()).mul(4)).mul(
    float(1).sub(smoothstep(10, 60, distance)),
  );
  const body = mix(linear(options.deepColor), linear(options.shallowColor), crest.mul(0.35));
  const surface = mix(body, reflection, fresnel).add(glintColor.mul(glint.mul(fresnel)));
  const haze = sky.horizonRadiance(view.negate());
  const colour = mix(surface, haze, pow(smoothstep(30, 89, distance), 2));

  const material = new MeshBasicNodeMaterial({ fog: false });
  material.colorNode = colour;

  const geometry = new CircleGeometry(options.radius ?? 89, 96);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, options.level, 0);
  const mesh = new Mesh(geometry, material);
  mesh.name = 'ocean';
  mesh.frustumCulled = false;

  return {
    mesh,
    time,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
