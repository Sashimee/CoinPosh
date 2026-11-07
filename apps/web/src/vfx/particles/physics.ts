import { ATTRACTOR_SLOTS, ParticleKind, type ParticleBuffers } from './layout.ts';

/**
 * The particle integrator. `stepParticles` is the CPU fallback and the reference the TSL
 * compute kernel in `gpuParticles.ts` mirrors line for line; change both together.
 */
export const PARTICLE_PHYSICS = {
  gravity: -9.81,
  /** Spring stiffness (1/s²) pulling a `Homing` particle into its attractor. */
  homingStiffness: 260,
  /** A homing particle this close to its attractor has arrived and dies. */
  homingArrival: 0.004,
  /** Below this height a particle has fallen off the yacht and is retired. */
  killY: -1.2,
  /** Per-kind bounce on the table surface, indexed by `ParticleKind`. */
  restitution: [0.32, 0.1, 0, 0, 0] as const,
  /** Per-kind share of horizontal speed kept on each bounce. */
  friction: [0.55, 0.4, 0.3, 0, 0.12] as const,
  /** Confetti flutter: lateral acceleration (m/s²) and its two angular rates (rad/s). */
  flutter: { amplitude: 1.6, rateX: 7.3, rateZ: 5.1 },
} as const;

/** The table surface particles land on, as a rectangle in the XZ plane at height `y`. */
export interface ParticleFloor {
  readonly y: number;
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export interface ParticleEnvironment {
  readonly floor: ParticleFloor;
  /** `ATTRACTOR_SLOTS` × (x, y, z, unused). */
  readonly attractors: Float32Array;
}

export function createAttractors(): Float32Array {
  return new Float32Array(ATTRACTOR_SLOTS * 4);
}

/** Integrates every live slot by `dt` seconds; returns how many are still alive. */
export function stepParticles(
  buffers: ParticleBuffers,
  count: number,
  dt: number,
  env: ParticleEnvironment,
): number {
  const { posAge, velLife, params } = buffers;
  const { floor, attractors } = env;
  const { gravity, homingStiffness, homingArrival, killY, restitution, friction, flutter } =
    PARTICLE_PHYSICS;
  const homingDamping = 2 * Math.sqrt(homingStiffness);
  let alive = 0;
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    const life = velLife[o + 3] ?? 0;
    if (life <= 0) continue;
    const age = (posAge[o + 3] ?? 0) + dt;
    if (age >= life) {
      velLife[o + 3] = 0;
      continue;
    }
    let px = posAge[o] ?? 0;
    let py = posAge[o + 1] ?? 0;
    let pz = posAge[o + 2] ?? 0;
    let vx = velLife[o] ?? 0;
    let vy = velLife[o + 1] ?? 0;
    let vz = velLife[o + 2] ?? 0;
    const drag = params[o] ?? 0;
    const gravityScale = params[o + 1] ?? 0;
    const kind = params[o + 2] ?? 0;
    const seed = params[o + 3] ?? 0;

    if (kind === ParticleKind.Homing) {
      const a = Math.min(Math.max(Math.round(gravityScale), 0), ATTRACTOR_SLOTS - 1) * 4;
      const dx = (attractors[a] ?? 0) - px;
      const dy = (attractors[a + 1] ?? 0) - py;
      const dz = (attractors[a + 2] ?? 0) - pz;
      if (dx * dx + dy * dy + dz * dz < homingArrival * homingArrival) {
        velLife[o + 3] = 0;
        continue;
      }
      vx += (dx * homingStiffness - vx * (homingDamping + drag)) * dt;
      vy += (dy * homingStiffness - vy * (homingDamping + drag)) * dt;
      vz += (dz * homingStiffness - vz * (homingDamping + drag)) * dt;
      px += vx * dt;
      py += vy * dt;
      pz += vz * dt;
    } else {
      vy += gravity * gravityScale * dt;
      if (kind === ParticleKind.Confetti) {
        vx += Math.sin(age * flutter.rateX + seed * 40) * flutter.amplitude * dt;
        vz += Math.cos(age * flutter.rateZ + seed * 23) * flutter.amplitude * dt;
      }
      const damp = Math.exp(-drag * dt);
      vx *= damp;
      vy *= damp;
      vz *= damp;
      const previousY = py;
      px += vx * dt;
      py += vy * dt;
      pz += vz * dt;
      const overTable =
        px >= floor.minX && px <= floor.maxX && pz >= floor.minZ && pz <= floor.maxZ;
      if (overTable && py < floor.y && previousY >= floor.y && vy < 0) {
        const k = Math.min(Math.max(Math.round(kind), 0), 4);
        py = floor.y;
        vy = -vy * (restitution[k] ?? 0);
        vx *= friction[k] ?? 0;
        vz *= friction[k] ?? 0;
      }
      if (py < killY) {
        velLife[o + 3] = 0;
        continue;
      }
    }
    posAge[o] = px;
    posAge[o + 1] = py;
    posAge[o + 2] = pz;
    posAge[o + 3] = age;
    velLife[o] = vx;
    velLife[o + 1] = vy;
    velLife[o + 2] = vz;
    alive++;
  }
  return alive;
}
