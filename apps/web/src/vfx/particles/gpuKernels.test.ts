import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { WGSLNodeBuilder, WebGPURenderer, type ComputeNode, type Object3D } from 'three/webgpu';
import { GPU_SPAWN_BATCH, GpuParticles } from './gpuParticles.ts';
import {
  ATTRACTOR_SLOTS,
  createParticleBuffers,
  ParticleKind,
  writeParticle,
  type ParticleSpawn,
} from './layout.ts';
import { PARTICLE_PHYSICS } from './physics.ts';

/**
 * Compiles the TSL kernels to WGSL the way `renderer.compute` would on first use, without
 * a device: the builder only needs the renderer for its node library and feature queries.
 * TSL type errors, unknown nodes and bad swizzles surface here instead of on a player's GPU.
 */
interface ComputeShaderBuilder {
  compute: ComputeNode;
  build(): void;
  readonly computeShader: string;
}

function compile(kernel: ComputeNode): string {
  const renderer = new WebGPURenderer({ canvas: { style: {} } as unknown as HTMLCanvasElement });
  renderer.hasFeature = () => false;
  // three's own Nodes.getForCompute builds a compute shader with a null object and the node
  // on `compute`; @types/three 0.187 types the object as Object3D and omits both members.
  const builder = new WGSLNodeBuilder(
    null as unknown as Object3D,
    renderer,
  ) as unknown as ComputeShaderBuilder;
  builder.compute = kernel;
  builder.build();
  return builder.computeShader;
}

function kernels(capacity: number): { spawn: string; update: string; clear: string } {
  const gpu = new GpuParticles(capacity);
  try {
    return {
      spawn: compile(gpu.spawnKernel),
      update: compile(gpu.updateKernel),
      clear: compile(gpu.clearKernel),
    };
  } finally {
    gpu.dispose();
  }
}

function wgslFloat(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

describe('GPU particle kernels', () => {
  let errors: MockInstance;
  let warnings: MockInstance;

  beforeEach(() => {
    errors = vi.spyOn(console, 'error');
    warnings = vi.spyOn(console, 'warn');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('compile to WGSL without a device and without three logging a node error', () => {
    const { spawn, update, clear } = kernels(256);
    for (const shader of [spawn, update, clear]) {
      expect(shader).toMatch(/@compute @workgroup_size\( 64, 1, 1 \)\s*fn main\(/);
    }
    expect(errors).not.toHaveBeenCalled();
    expect(warnings).not.toHaveBeenCalled();
  });

  it('copy staged spawns into the ring, wrapping at capacity', () => {
    const { spawn } = kernels(300);
    expect(spawn).toMatch(/if \( \( instanceIndex < object\.nodeUniform\d+ \) \)/);
    expect(spawn).toMatch(/% 300u/);
    expect(spawn.match(/var<storage, read_write>/g)).toHaveLength(4);
    expect(spawn.match(/var<storage, read>/g)).toHaveLength(4);
  });

  it('carry the CPU integrator constants into the update kernel', () => {
    const { update } = kernels(256);
    const { gravity, homingStiffness, homingArrival, killY, restitution, friction, flutter } =
      PARTICLE_PHYSICS;
    const constants = [
      gravity,
      homingStiffness,
      homingArrival,
      killY,
      flutter.amplitude,
      flutter.rateX,
      flutter.rateZ,
      2 * Math.sqrt(homingStiffness),
      ...restitution.filter((r) => r > 0),
      ...friction.filter((f) => f > 0),
    ];
    for (const value of constants) expect(update).toContain(wgslFloat(value));
    expect(update).toContain(`array< vec4<f32>, ${ATTRACTOR_SLOTS} >`);
    expect(update).toContain(`0.0, ${wgslFloat(ATTRACTOR_SLOTS - 1)} )`);
  });
});

function spawn(i: number): ParticleSpawn {
  return {
    x: i,
    y: 0.1 + i,
    z: -i,
    vx: 0.5,
    vy: 1,
    vz: -0.5,
    life: 1 + i / 1000,
    r: 2,
    g: 1.5,
    b: 1,
    size: 0.01,
    drag: 3,
    gravity: 1,
    kind: ParticleKind.Spark,
    seed: 0.25,
  };
}

describe('GPU particle staging', () => {
  const fill = (gpu: GpuParticles, count: number): number => {
    let accepted = 0;
    for (let i = 0; i < count; i++) if (gpu.emit(spawn(i))) accepted++;
    return accepted;
  };

  it('accepts no more spawns per frame than the ring has slots, so none share a slot', () => {
    const gpu = new GpuParticles(1024);
    expect(gpu.spawnBatch).toBe(1024);
    expect(fill(gpu, 1800)).toBe(1024);
    gpu.dispose();
  });

  it('caps a large ring at the upload batch', () => {
    const gpu = new GpuParticles(GPU_SPAWN_BATCH * 2);
    expect(gpu.spawnBatch).toBe(GPU_SPAWN_BATCH);
    expect(fill(gpu, GPU_SPAWN_BATCH + 1)).toBe(GPU_SPAWN_BATCH);
    gpu.dispose();
  });

  it('dispatches the spawn kernel over the batch it can stage', () => {
    const small = new GpuParticles(300);
    const large = new GpuParticles(GPU_SPAWN_BATCH * 2);
    expect(small.spawnKernel.count).toBe(300);
    expect(large.spawnKernel.count).toBe(GPU_SPAWN_BATCH);
    expect(large.clearKernel.count).toBe(GPU_SPAWN_BATCH * 2);
    small.dispose();
    large.dispose();
  });

  it('stages each spawn in the shared particle layout', () => {
    const gpu = new GpuParticles(8);
    const expected = createParticleBuffers(8);
    for (let i = 0; i < 3; i++) {
      gpu.emit(spawn(i));
      writeParticle(expected, i, spawn(i));
    }
    expect(gpu.staged).toEqual(expected);
    gpu.dispose();
  });

  it('clear() stops drawing and frees the staging budget without new kernels', () => {
    const gpu = new GpuParticles(16);
    const { spawnKernel, updateKernel } = gpu;
    fill(gpu, 16);
    expect(gpu.drawCount).toBe(16);
    gpu.clear();
    expect(gpu.drawCount).toBe(0);
    expect(gpu.liveEstimate).toBe(0);
    expect(fill(gpu, 16)).toBe(16);
    expect(gpu.spawnKernel).toBe(spawnKernel);
    expect(gpu.updateKernel).toBe(updateKernel);
    gpu.dispose();
  });
});
