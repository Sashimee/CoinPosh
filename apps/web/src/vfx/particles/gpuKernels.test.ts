import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { WGSLNodeBuilder, WebGPURenderer, type ComputeNode, type Object3D } from 'three/webgpu';
import { GpuParticles } from './gpuParticles.ts';
import { ATTRACTOR_SLOTS } from './layout.ts';
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

function kernels(capacity: number): { spawn: string; update: string } {
  const gpu = new GpuParticles(capacity);
  try {
    return { spawn: compile(gpu.spawnKernel), update: compile(gpu.updateKernel) };
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
    const { spawn, update } = kernels(256);
    for (const shader of [spawn, update]) {
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
