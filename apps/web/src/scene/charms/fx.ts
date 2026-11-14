import {
  abs,
  attribute,
  cameraProjectionMatrix,
  clamp,
  cos,
  dot,
  exp,
  float,
  Fn,
  length,
  max,
  mix,
  modelViewMatrix,
  positionGeometry,
  pow,
  sin,
  smoothstep,
  step,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Mesh,
  MeshBasicNodeMaterial,
  PlaneGeometry,
  type Node,
  type UniformNode,
} from 'three/webgpu';
import { easeOutExpo, pulse } from '../../vfx/easing.ts';
import type { CharmQuality, CharmUniforms } from './materials.ts';

type F = Node<'float'>;

export interface Particle {
  /** Birth position in the charm's frame, metres. */
  readonly start: readonly [number, number, number];
  /** Launch velocity, metres per second; drag bleeds it off. */
  readonly velocity: readonly [number, number, number];
  readonly delay: number;
  readonly life: number;
  /** Half-size of the sprite, metres. */
  readonly size: number;
  /** 0 keeps the burst's own colour, 1 takes the synergy accent. */
  readonly accent: number;
}

export interface BurstProfile {
  /** Particle count on the high tier; the low tier keeps every other one. */
  readonly count: number;
  readonly color: string;
  /** `glint` is a four-ray star for sparks; `mist` a soft round puff for scent and dust. */
  readonly shape: 'glint' | 'mist';
  /** Downward pull in m/s² (negative floats upward). */
  readonly gravity: number;
  /** Exponential velocity decay per second. */
  readonly drag: number;
  /** `random()` is a seeded [0, 1) stream, so a charm bursts the same way every time. */
  readonly emit: (index: number, random: () => number) => Particle;
  /** A flat shockwave across the table, or null for none. */
  readonly ring: { readonly radius: number; readonly duration: number } | null;
}

function seeded(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
}

/** Lifts the ring off the felt so it never z-fights the table it lies on. */
const RING_LIFT = 0.0012;
/** Reduced motion: the ring blooms in place at this share of its radius instead of travelling. */
const REDUCED_RING_SCALE = 0.6;

/**
 * The activation burst of one charm: up to a few dozen sprites in a single draw call whose
 * motion is solved in the vertex shader from one `age` uniform, plus an optional shockwave
 * ring. Both meshes are hidden at rest, so an idle charm costs no extra draw calls.
 *
 * Reduced motion: no sprites fly; the ring blooms in place and fades.
 */
export class CharmBurst {
  readonly particles: Mesh<BufferGeometry, MeshBasicNodeMaterial>;
  readonly ring: Mesh<PlaneGeometry, MeshBasicNodeMaterial> | null;
  /** Seconds the whole burst lasts, ring included. */
  readonly duration: number;
  private readonly age: UniformNode<'float'>;
  private readonly front: UniformNode<'float'>;
  private readonly width: UniformNode<'float'>;
  private readonly strength: UniformNode<'float'>;
  private readonly ringRadius: number;
  private readonly ringDuration: number;

  constructor(profile: BurstProfile, uniforms: CharmUniforms, quality: CharmQuality, seed: number) {
    this.age = uniform(0);
    this.front = uniform(0);
    this.width = uniform(0.08);
    this.strength = uniform(0);
    const count = quality === 'high' ? profile.count : Math.ceil(profile.count / 2);
    const random = seeded(seed);
    const all = Array.from({ length: profile.count }, (_, i) => profile.emit(i, random));
    const kept = quality === 'high' ? all : all.filter((_, i) => i % 2 === 0).slice(0, count);
    this.particles = new Mesh(
      burstGeometry(kept),
      burstMaterial(profile, uniforms, this.age, kept),
    );
    this.particles.name = 'charm-burst';
    this.particles.frustumCulled = false;
    this.particles.visible = false;
    this.particles.renderOrder = 3;

    this.ringRadius = profile.ring?.radius ?? 0;
    this.ringDuration = profile.ring?.duration ?? 0;
    if (profile.ring) {
      const geometry = new PlaneGeometry(2, 2);
      geometry.rotateX(-Math.PI / 2);
      this.ring = new Mesh(geometry, ringMaterial(uniforms, this.front, this.width, this.strength));
      this.ring.name = 'charm-ring';
      this.ring.position.y = RING_LIFT;
      this.ring.scale.setScalar(this.ringRadius);
      this.ring.visible = false;
      this.ring.renderOrder = 2;
    } else {
      this.ring = null;
    }
    const particleEnd = kept.reduce((end, p) => Math.max(end, p.delay + p.life), 0);
    this.duration = Math.max(particleEnd, this.ringDuration);
  }

  /** Poses the burst `elapsed` seconds after activation; negative or past the end hides it. */
  update(elapsed: number, reducedMotion: boolean): void {
    const active = elapsed >= 0 && elapsed < this.duration;
    this.particles.visible = active && !reducedMotion;
    this.age.value = active ? elapsed : 0;
    const ring = this.ring;
    if (!ring) return;
    const t = this.ringDuration > 0 ? elapsed / this.ringDuration : 1;
    ring.visible = active && t < 1;
    if (!ring.visible) return;
    if (reducedMotion) {
      ring.scale.setScalar(this.ringRadius * REDUCED_RING_SCALE);
      this.front.value = 0.72;
      this.width.value = 0.35;
      this.strength.value = pulse(t, 0.3) * 0.6;
    } else {
      ring.scale.setScalar(this.ringRadius);
      this.front.value = easeOutExpo(t) * 0.94;
      this.width.value = 0.05 + 0.18 * t;
      this.strength.value = (1 - t) * (1 - t) * 1.1;
    }
  }

  dispose(): void {
    this.particles.geometry.dispose();
    this.particles.material.dispose();
    if (this.ring) {
      this.ring.geometry.dispose();
      this.ring.material.dispose();
    }
  }
}

const CORNERS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
] as const;

function burstGeometry(particles: readonly Particle[]): BufferGeometry {
  const n = particles.length;
  const position = new Float32Array(n * 4 * 3);
  const uvs = new Float32Array(n * 4 * 2);
  const start = new Float32Array(n * 4 * 4);
  const velocity = new Float32Array(n * 4 * 4);
  const look = new Float32Array(n * 4 * 4);
  const index = new Uint16Array(n * 6);
  particles.forEach((p, i) => {
    const seed = (((i * 0.61803398875) % 1) + 1) % 1;
    CORNERS.forEach(([x, y], c) => {
      const v = i * 4 + c;
      position.set([x, y, 0], v * 3);
      uvs.set([(x + 1) / 2, (y + 1) / 2], v * 2);
      start.set([p.start[0], p.start[1], p.start[2], p.delay], v * 4);
      velocity.set([p.velocity[0], p.velocity[1], p.velocity[2], p.life], v * 4);
      look.set([p.size, seed, p.accent, 0], v * 4);
    });
    index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
  });
  const geometry = new BufferGeometry();
  geometry.name = 'charm-burst';
  geometry.setAttribute('position', new BufferAttribute(position, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setAttribute('burstStart', new BufferAttribute(start, 4));
  geometry.setAttribute('burstVelocity', new BufferAttribute(velocity, 4));
  geometry.setAttribute('burstLook', new BufferAttribute(look, 4));
  geometry.setIndex(new BufferAttribute(index, 1));
  return geometry;
}

function burstMaterial(
  profile: BurstProfile,
  u: CharmUniforms,
  age: UniformNode<'float'>,
  particles: readonly Particle[],
): MeshBasicNodeMaterial {
  if (particles.length === 0) throw new Error('A charm burst needs at least one particle');
  const start = attribute<'vec4'>('burstStart', 'vec4');
  const velocity = attribute<'vec4'>('burstVelocity', 'vec4');
  const look = attribute<'vec4'>('burstLook', 'vec4');
  const t = max(age.sub(start.w), 0);
  const life = velocity.w;
  const l = clamp(t.div(life), 0, 1);
  const alive = step(start.w, age).mul(step(t, life));
  const drag = profile.drag;
  const travel: F =
    drag > 0
      ? float(1)
          .sub(exp(t.mul(-drag)))
          .div(drag)
      : t;
  const mist = profile.shape === 'mist';
  const grow: F = mist ? mix(float(0.45), float(1.6), pow(l, 0.6)) : float(1).sub(l.mul(0.6));
  const size = look.x.mul(grow).mul(alive);

  const material = new MeshBasicNodeMaterial({ name: `charm/burst-${profile.shape}` });
  material.vertexNode = Fn(() => {
    const pos = start.xyz
      .add(velocity.xyz.mul(travel))
      .sub(vec3(0, t.mul(t).mul(profile.gravity * 0.5), 0));
    const view = modelViewMatrix.mul(vec4(pos, 1)).xyz;
    const angle = look.y.mul(Math.PI * 2).add(t.mul(mist ? 0.8 : 2.5));
    const c = cos(angle);
    const s = sin(angle);
    const corner = positionGeometry.xy;
    const rotated = vec2(
      corner.x.mul(c).sub(corner.y.mul(s)),
      corner.x.mul(s).add(corner.y.mul(c)),
    );
    return cameraProjectionMatrix.mul(vec4(view.add(vec3(rotated.mul(size), 0)), 1));
  })();

  const d = uv().mul(2).sub(1);
  const r2 = dot(d, d);
  let mask: F;
  let fade: F;
  if (mist) {
    mask = pow(clamp(float(1).sub(length(d)), 0, 1), 2).mul(0.55);
    fade = smoothstep(0, 0.12, l).mul(pow(float(1).sub(l), 1.3));
  } else {
    const rays = exp(abs(d.x).mul(-18))
      .mul(clamp(float(1).sub(abs(d.y)), 0, 1))
      .add(exp(abs(d.y).mul(-18)).mul(clamp(float(1).sub(abs(d.x)), 0, 1)));
    mask = exp(r2.mul(-12))
      .add(rays.mul(0.9))
      .mul(clamp(float(1).sub(r2), 0, 1));
    const twinkle = sin(t.mul(38).add(look.y.mul(20)))
      .mul(0.25)
      .add(0.75);
    fade = smoothstep(0, 0.04, l)
      .mul(pow(float(1).sub(l), 1.2))
      .mul(twinkle);
  }
  const base = new Color(profile.color);
  const tint = mix(vec3(base.r, base.g, base.b), u.accent, look.z);
  const hot = mix(vec3(1, 0.97, 0.9), tint, smoothstep(0, 0.35, l));
  const intensity = mist ? 1.2 : 3.2;
  material.colorNode = vec4(hot.mul(intensity), clamp(mask.mul(fade), 0, 1));
  material.transparent = true;
  material.depthWrite = false;
  material.blending = AdditiveBlending;
  material.side = DoubleSide;
  material.fog = false;
  return material;
}

function ringMaterial(
  u: CharmUniforms,
  front: UniformNode<'float'>,
  width: UniformNode<'float'>,
  strength: UniformNode<'float'>,
): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial({ name: 'charm/ring' });
  const r = length(uv().mul(2).sub(1));
  const edge = r.sub(front).div(width);
  const crest = exp(edge.mul(edge).negate());
  const wake = smoothstep(front, float(0), r).mul(0.18).mul(step(r, front));
  const outside = float(1).sub(smoothstep(0.92, 1, r));
  const alpha = clamp(crest.add(wake).mul(strength).mul(outside), 0, 1);
  material.colorNode = vec4(mix(u.accent, vec3(1, 0.95, 0.85), crest.mul(0.4)).mul(2.2), alpha);
  material.transparent = true;
  material.depthWrite = false;
  material.blending = AdditiveBlending;
  material.fog = false;
  return material;
}
