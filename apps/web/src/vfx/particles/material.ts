import {
  abs,
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  clamp,
  cos,
  dot,
  exp,
  float,
  Fn,
  length,
  max,
  min,
  mix,
  normalize,
  positionGeometry,
  pow,
  select,
  sin,
  smoothstep,
  step,
  uv,
  vec2,
  vec3,
  vec4,
  vertexStage,
} from 'three/tsl';
import { AdditiveBlending, DoubleSide, MeshBasicNodeMaterial, type Node } from 'three/webgpu';
import { ParticleKind } from './layout.ts';

type F = Node<'float'>;
type V4 = Node<'vec4'>;

export interface ParticleNodes {
  readonly posAge: V4;
  readonly velLife: V4;
  readonly color: V4;
  readonly params: V4;
}

/** `glow` is additive light (sparks, glints, motes, implosion); `confetti` is opaque foil. */
export type ParticleLayer = 'glow' | 'confetti';

/** Seconds of virtual shutter: how long a spark's streak is relative to its speed. */
export const SHUTTER = 0.042;
/** A streak's half-length never exceeds this many of its own sizes: sparkle, not needles. */
export const STREAK_MAX_SIZES = 6;
/**
 * A whole streak never spans more than this fraction of the viewport height (about 38 css
 * px on a 390x844 phone), so fast sparks and homing motes read as glints, not scratches.
 */
export const STREAK_MAX_SCREEN = 38 / 844;

/**
 * The half-length of a streak quad along its motion axis, in view units. `depth` is the
 * view-space distance and `projY` the projection's vertical focal term (`P[1][1]`).
 */
export function streakHalfLength(
  size: number,
  speed: number,
  depth: number,
  projY: number,
): number {
  const stretch = Math.min(speed * SHUTTER, size * (STREAK_MAX_SIZES - 1));
  const screenCap = (STREAK_MAX_SCREEN * Math.max(depth, 0)) / Math.max(projY, 1e-5);
  return Math.min(size + stretch, Math.max(screenCap, size));
}
const TAU = Math.PI * 2;

function isKind(kind: F, id: number): F {
  return step(abs(kind.sub(id)), float(0.5));
}

function lifeTerms(nodes: ParticleNodes): { t: F; alive: F } {
  const age = nodes.posAge.w;
  const life = nodes.velLife.w;
  const t = clamp(age.div(max(life, 1e-4)), 0, 1);
  const alive = step(1e-6, life).mul(step(age, life));
  return { t, alive };
}

export function createParticleMaterial(
  nodes: ParticleNodes,
  layer: ParticleLayer,
): MeshBasicNodeMaterial {
  return layer === 'glow' ? glowMaterial(nodes) : confettiMaterial(nodes);
}

function glowMaterial(nodes: ParticleNodes): MeshBasicNodeMaterial {
  const { t, alive } = lifeTerms(nodes);
  const kind = nodes.params.z;
  const seed = nodes.params.w;
  const streak = isKind(kind, ParticleKind.Spark).add(isKind(kind, ParticleKind.Homing));
  const glint = isKind(kind, ParticleKind.Glint);
  const mote = isKind(kind, ParticleKind.Mote);

  const twinkle = pow(sin(t.mul(Math.PI)), 0.7);
  const sizeCurve = streak
    .mul(float(1).sub(t.mul(0.55)))
    .add(glint.mul(mix(float(0.35), float(1), twinkle)))
    .add(mote.mul(mix(float(0.7), float(1.15), t)));
  const size = nodes.color.w.mul(sizeCurve).mul(alive);

  const material = new MeshBasicNodeMaterial();
  material.vertexNode = Fn(() => {
    const corner = positionGeometry.xy;
    const view = cameraViewMatrix.mul(vec4(nodes.posAge.xyz, 1)).xyz;
    const viewVelocity = cameraViewMatrix.mul(vec4(nodes.velLife.xyz, 0)).xy;
    const speed = length(viewVelocity);
    const axis = select(speed.greaterThan(1e-5), viewVelocity.div(max(speed, 1e-5)), vec2(1, 0));
    const perp = vec2(axis.y.negate(), axis.x);
    const stretch = min(speed.mul(SHUTTER), size.mul(STREAK_MAX_SIZES - 1)).mul(alive);
    const projY = max(cameraProjectionMatrix.mul(vec4(0, 1, 0, 0)).y, 1e-5);
    const screenCap = max(view.z.negate(), 0).mul(STREAK_MAX_SCREEN).div(projY);
    const along = min(size.add(stretch), max(screenCap, size));
    const streakOffset = axis.mul(corner.x.mul(along).mul(2)).add(perp.mul(corner.y.mul(size)));
    const angle = seed.mul(TAU);
    const c = cos(angle);
    const s = sin(angle);
    const rotated = vec2(
      corner.x.mul(c).sub(corner.y.mul(s)),
      corner.x.mul(s).add(corner.y.mul(c)),
    );
    const roundOffset = rotated.mul(size.mul(2));
    const offset = mix(roundOffset, streakOffset, clamp(streak, 0, 1));
    return cameraProjectionMatrix.mul(vec4(view.add(vec3(offset, 0)), 1));
  })();

  const d = uv().mul(2).sub(1);
  const r2 = dot(d, d);
  const head = mix(float(0.3), float(1), pow(d.x.mul(0.5).add(0.5), 2));
  const sparkMask = exp(d.y.mul(d.y).mul(-5))
    .mul(clamp(float(1).sub(d.x.mul(d.x)), 0, 1))
    .mul(head);
  const rays = exp(abs(d.x).mul(-20))
    .mul(clamp(float(1).sub(abs(d.y)), 0, 1))
    .add(exp(abs(d.y).mul(-20)).mul(clamp(float(1).sub(abs(d.x)), 0, 1)));
  const glintMask = exp(r2.mul(-14))
    .add(rays.mul(0.85))
    .mul(clamp(float(1).sub(r2), 0, 1));
  const moteMask = pow(clamp(float(1).sub(length(d)), 0, 1), 1.6);
  const mask = clamp(streak, 0, 1).mul(sparkMask).add(glint.mul(glintMask)).add(mote.mul(moteMask));

  const fadeIn = smoothstep(0, 0.05, t);
  const fadeOut = pow(float(1).sub(t), 1.4);
  const fade = fadeIn.mul(mix(fadeOut, twinkle, glint));
  const cooled = mix(nodes.color.rgb, nodes.color.rgb.mul(vec3(1, 0.5, 0.3)), t.mul(streak));

  material.colorNode = vec4(cooled, clamp(mask.mul(fade), 0, 1));
  material.transparent = true;
  material.depthWrite = false;
  material.blending = AdditiveBlending;
  material.fog = false;
  return material;
}

function confettiMaterial(nodes: ParticleNodes): MeshBasicNodeMaterial {
  const { t, alive } = lifeTerms(nodes);
  const age = nodes.posAge.w;
  const seed = nodes.params.w;
  const shrink = float(1).sub(smoothstep(0.82, 1, t));
  const grow = smoothstep(0, 0.04, t);
  const size = nodes.color.w.mul(shrink).mul(grow).mul(alive);
  const spinA = age.mul(seed.mul(9).add(6)).add(seed.mul(31));
  const spinB = age.mul(seed.mul(5).add(3)).add(seed.mul(17));
  const c1 = cos(spinA);
  const s1 = sin(spinA);
  const c2 = cos(spinB);
  const s2 = sin(spinB);
  const normal = vec3(c1.mul(s2), s1.negate(), c1.mul(c2));
  const toCamera = normalize(cameraPosition.sub(nodes.posAge.xyz));
  const facing = vertexStage(abs(dot(normal, toCamera)));

  const material = new MeshBasicNodeMaterial();
  material.vertexNode = Fn(() => {
    const corner = positionGeometry.xy;
    const x = corner.x.mul(size);
    const y = corner.y.mul(size).mul(0.48);
    const yRot = y.mul(c1);
    const zRot = y.mul(s1);
    const local = vec3(x.mul(c2).add(zRot.mul(s2)), yRot, x.mul(s2).negate().add(zRot.mul(c2)));
    const world = nodes.posAge.xyz.add(local);
    return cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(world, 1)));
  })();

  const d = uv().mul(2).sub(1);
  const edge = float(1).sub(smoothstep(0.86, 1, max(abs(d.x), abs(d.y))));
  const sheen = pow(facing, 18).mul(1.8);
  const base = nodes.color.rgb.mul(facing.mul(0.75).add(0.25));
  material.colorNode = vec4(base.add(vec3(sheen)), 1);
  material.opacityNode = edge;
  material.alphaTest = 0.5;
  material.side = DoubleSide;
  material.fog = false;
  return material;
}
