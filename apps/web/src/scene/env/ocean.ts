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
}

export interface Ocean {
  readonly mesh: Mesh;
  /** Seconds of wave animation; the venue advances it (slower under reduced motion). */
  readonly time: { value: number };
  dispose(): void;
}

interface Swell {
  readonly direction: Vector2;
  readonly wavelength: number;
  readonly steepness: number;
}

const GRAVITY = 9.81;

const SWELLS: readonly Swell[] = [
  { direction: new Vector2(0.2, 1).normalize(), wavelength: 11, steepness: 0.018 },
  { direction: new Vector2(-0.45, 1).normalize(), wavelength: 6.3, steepness: 0.024 },
  { direction: new Vector2(0.8, 0.6).normalize(), wavelength: 3.7, steepness: 0.032 },
  { direction: new Vector2(-0.9, 0.35).normalize(), wavelength: 2.1, steepness: 0.045 },
  { direction: new Vector2(0.35, -0.9).normalize(), wavelength: 1.25, steepness: 0.05 },
  { direction: new Vector2(-0.15, 0.95).normalize(), wavelength: 0.7, steepness: 0.05 },
  { direction: new Vector2(0.6, 0.8).normalize(), wavelength: 0.43, steepness: 0.045 },
  { direction: new Vector2(-0.7, 0.7).normalize(), wavelength: 0.27, steepness: 0.04 },
];

function linear(hex: string): Node<'vec3'> {
  const c = new Color(hex);
  return vec3(c.r, c.g, c.b);
}

/**
 * Backdrop sea: a flat disc shaded per pixel. Slopes come from analytic sums of deep-water
 * swells (dispersion ω = √(g·k)), each faded out once it falls below a pixel to avoid shimmer,
 * plus fine noise ripples near the hull. Reflections sample the same sky function as the dome,
 * so the sun glitter path and the far haze match the sky exactly and the horizon has no seam.
 */
export function createOcean(options: OceanOptions): Ocean {
  const time = uniform(0);
  const { sky } = options;
  const glintColor = linear(options.glintColor);

  const eye = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz;
  const p = positionLocal.xz;
  const toEye = eye.sub(positionLocal);
  const distance = length(toEye);

  let slopeX: Node<'float'> = float(0);
  let slopeZ: Node<'float'> = float(0);
  for (const swell of SWELLS) {
    const k = (Math.PI * 2) / swell.wavelength;
    const omega = Math.sqrt(GRAVITY * k);
    const amplitude = swell.steepness / k;
    const fade = float(1).sub(smoothstep(swell.wavelength * 14, swell.wavelength * 45, distance));
    const phase = dot(p, vec2(swell.direction.x, swell.direction.y)).mul(k).sub(time.mul(omega));
    const slope = cos(phase)
      .mul(amplitude * k)
      .mul(fade);
    slopeX = slopeX.add(slope.mul(swell.direction.x));
    slopeZ = slopeZ.add(slope.mul(swell.direction.y));
  }
  const rippleFade = float(1).sub(smoothstep(4, 14, distance));
  const ripple = mx_noise_vec3(vec3(p.x.mul(2.2), p.y.mul(2.2), time.mul(0.45))).mul(
    rippleFade.mul(0.05),
  );
  const normal = normalize(vec3(slopeX.negate().add(ripple.x), 1, slopeZ.negate().add(ripple.z)));

  const view = normalize(toEye);
  const facing = saturate(dot(normal, view));
  const fresnel = float(0.02).add(pow(float(1).sub(facing), 5).mul(0.98));
  const mirrored = reflect(view.negate(), normal);
  const reflected = vec3(mirrored.x, max(mirrored.y, 0.002), mirrored.z);
  const reflection = sky.radiance(reflected).mul(0.5);
  const sunDirection = uniform(sky.sunDirection);
  const glint = pow(saturate(dot(mirrored, sunDirection)), 900)
    .mul(40)
    .add(pow(saturate(dot(mirrored, sunDirection)), 60).mul(0.6));

  const crest = saturate(dot(normal.xz, sunDirection.xz.normalize()).mul(4)).mul(
    float(1).sub(smoothstep(10, 60, distance)),
  );
  const body = mix(linear(options.deepColor), linear(options.shallowColor), crest.mul(0.35));
  const surface = mix(body, reflection, fresnel).add(glintColor.mul(glint.mul(fresnel)));
  const haze = sky.radiance(view.negate());
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
