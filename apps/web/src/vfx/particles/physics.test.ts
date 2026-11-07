import { describe, expect, it } from 'vitest';
import { CpuParticles } from './cpuParticles.ts';
import {
  createParticleBuffers,
  isValidSpawn,
  ParticleKind,
  writeParticle,
  type ParticleSpawn,
} from './layout.ts';
import {
  createAttractors,
  PARTICLE_PHYSICS,
  stepParticles,
  type ParticleEnvironment,
} from './physics.ts';

function env(): ParticleEnvironment {
  return {
    floor: { y: 0, minX: -0.3, maxX: 0.3, minZ: -0.5, maxZ: 0.4 },
    attractors: createAttractors(),
  };
}

function spawn(overrides: Partial<ParticleSpawn> = {}): ParticleSpawn {
  return {
    x: 0,
    y: 0.1,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    life: 2,
    r: 1,
    g: 1,
    b: 1,
    size: 0.01,
    drag: 0,
    gravity: 1,
    kind: ParticleKind.Spark,
    seed: 0.5,
    ...overrides,
  };
}

function single(s: ParticleSpawn) {
  const buffers = createParticleBuffers(1);
  writeParticle(buffers, 0, s);
  return buffers;
}

describe('stepParticles', () => {
  it('falls under gravity and bounces off the table with the kind restitution', () => {
    const b = single(spawn({ y: 0.002, vy: -1 }));
    stepParticles(b, 1, 1 / 60, env());
    expect(b.posAge[1]).toBe(0);
    const expected = (1 + 9.81 / 60) * PARTICLE_PHYSICS.restitution[ParticleKind.Spark];
    expect(b.velLife[1]).toBeCloseTo(expected, 5);
  });

  it('does not bounce outside the table rectangle and retires below killY', () => {
    const b = single(spawn({ x: 0.5, y: 0.002, vy: -1 }));
    stepParticles(b, 1, 1 / 60, env());
    expect(b.posAge[1]).toBeLessThan(0);
    for (let i = 0; i < 120; i++) stepParticles(b, 1, 1 / 60, env());
    expect(b.velLife[3]).toBe(0);
  });

  it('expires at the end of its life and frees the slot', () => {
    const b = single(spawn({ life: 0.05, gravity: 0 }));
    expect(stepParticles(b, 1, 0.03, env())).toBe(1);
    expect(stepParticles(b, 1, 0.03, env())).toBe(0);
    expect(b.velLife[3]).toBe(0);
  });

  it('pulls homing particles into their attractor slot and kills them on arrival', () => {
    const e = env();
    e.attractors.set([0.1, 0.05, -0.1, 0], 4);
    const b = single(
      spawn({ kind: ParticleKind.Homing, gravity: 1, x: -0.1, y: 0.01, z: 0.05, life: 3 }),
    );
    let steps = 0;
    while ((b.velLife[3] ?? 0) > 0 && steps < 600) {
      stepParticles(b, 1, 1 / 120, e);
      steps++;
    }
    expect(b.velLife[3]).toBe(0);
    expect(steps / 120).toBeLessThan(1);
  });

  it('damps velocity exponentially with drag', () => {
    const b = single(spawn({ vx: 1, drag: 4, gravity: 0 }));
    stepParticles(b, 1, 0.25, env());
    expect(b.velLife[0]).toBeCloseTo(Math.exp(-1), 5);
  });

  it('skips free slots and counts only live particles', () => {
    const b = createParticleBuffers(4);
    writeParticle(b, 1, spawn());
    writeParticle(b, 3, spawn());
    expect(stepParticles(b, 4, 1 / 60, env())).toBe(2);
  });
});

describe('isValidSpawn', () => {
  it('rejects non-finite positions, zero life and zero size', () => {
    expect(isValidSpawn(spawn())).toBe(true);
    expect(isValidSpawn(spawn({ x: Number.NaN }))).toBe(false);
    expect(isValidSpawn(spawn({ life: 0 }))).toBe(false);
    expect(isValidSpawn(spawn({ size: 0 }))).toBe(false);
    expect(isValidSpawn(spawn({ life: Number.POSITIVE_INFINITY }))).toBe(false);
  });
});

describe('CpuParticles', () => {
  it('packs live particles to the front and draws only those', () => {
    const sim = new CpuParticles(8);
    sim.emit(spawn({ life: 0.02 }));
    sim.emit(spawn({ life: 1 }));
    sim.emit(spawn({ life: 1 }));
    sim.step(1 / 60, env());
    expect(sim.drawCount).toBe(3);
    sim.step(1 / 60, env());
    expect(sim.drawCount).toBe(2);
    expect(sim.liveEstimate).toBe(2);
  });

  it('refuses invalid spawns and wraps around its ring when full', () => {
    const sim = new CpuParticles(2);
    expect(sim.emit(spawn({ size: Number.NaN }))).toBe(false);
    for (let i = 0; i < 5; i++) expect(sim.emit(spawn())).toBe(true);
    sim.step(1 / 60, env());
    expect(sim.drawCount).toBe(2);
  });

  it('stops drawing once everything has expired', () => {
    const sim = new CpuParticles(4);
    sim.emit(spawn({ life: 0.01 }));
    sim.step(0.02, env());
    expect(sim.drawCount).toBe(0);
    sim.step(0.02, env());
    expect(sim.drawCount).toBe(0);
  });

  it('rejects a non-positive capacity', () => {
    expect(() => new CpuParticles(0)).toThrow(/capacity/);
  });
});
