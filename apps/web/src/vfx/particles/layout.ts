/**
 * One particle is four vec4s, identical on the GPU (storage buffers) and the CPU fallback
 * (typed arrays), so emitters write a single format for both:
 *
 * - `posAge`   xyz position (m), w age (s)
 * - `velLife`  xyz velocity (m/s), w lifetime (s); a lifetime of 0 marks a free slot
 * - `color`    rgb linear HDR colour (values above 1 bloom), w size (m)
 * - `params`   x drag (1/s), y gravity scale (or the attractor slot for `Homing`), z kind, w seed in [0, 1)
 */
export const ParticleKind = {
  /** A hot streak stretched along its screen-space velocity: sparks and motion trails. */
  Spark: 0,
  /** A four-point star that twinkles once over its life. */
  Glint: 1,
  /** A soft round bokeh dot: dust, fizz, shimmer. */
  Mote: 2,
  /** A streak pulled into an attractor by a damped spring: the fusion implosion. */
  Homing: 3,
  /** A foil ribbon that tumbles in 3D and flashes when it faces the camera. */
  Confetti: 4,
} as const;

export type ParticleKindId = (typeof ParticleKind)[keyof typeof ParticleKind];

export const VEC4_PER_PARTICLE = 4;
export const FLOATS_PER_PARTICLE = VEC4_PER_PARTICLE * 4;

/** The attractor slots `Homing` particles can target; each fusion leases one. */
export const ATTRACTOR_SLOTS = 4;

export interface ParticleSpawn {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  r: number;
  g: number;
  b: number;
  size: number;
  drag: number;
  /** Gravity multiplier, or the attractor slot for a `Homing` particle. */
  gravity: number;
  kind: ParticleKindId;
  seed: number;
}

export interface ParticleBuffers {
  readonly posAge: Float32Array;
  readonly velLife: Float32Array;
  readonly color: Float32Array;
  readonly params: Float32Array;
}

export function createParticleBuffers(count: number): ParticleBuffers {
  return {
    posAge: new Float32Array(count * 4),
    velLife: new Float32Array(count * 4),
    color: new Float32Array(count * 4),
    params: new Float32Array(count * 4),
  };
}

export function writeParticle(target: ParticleBuffers, slot: number, spawn: ParticleSpawn): void {
  const o = slot * 4;
  target.posAge[o] = spawn.x;
  target.posAge[o + 1] = spawn.y;
  target.posAge[o + 2] = spawn.z;
  target.posAge[o + 3] = 0;
  target.velLife[o] = spawn.vx;
  target.velLife[o + 1] = spawn.vy;
  target.velLife[o + 2] = spawn.vz;
  target.velLife[o + 3] = spawn.life;
  target.color[o] = spawn.r;
  target.color[o + 1] = spawn.g;
  target.color[o + 2] = spawn.b;
  target.color[o + 3] = spawn.size;
  target.params[o] = spawn.drag;
  target.params[o + 1] = spawn.gravity;
  target.params[o + 2] = spawn.kind;
  target.params[o + 3] = spawn.seed;
}

export function isValidSpawn(spawn: ParticleSpawn): boolean {
  return (
    Number.isFinite(spawn.x) &&
    Number.isFinite(spawn.y) &&
    Number.isFinite(spawn.z) &&
    Number.isFinite(spawn.vx) &&
    Number.isFinite(spawn.vy) &&
    Number.isFinite(spawn.vz) &&
    spawn.life > 0 &&
    Number.isFinite(spawn.life) &&
    spawn.size > 0 &&
    Number.isFinite(spawn.size)
  );
}
