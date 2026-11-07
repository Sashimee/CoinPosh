import type { WebGPURenderer } from 'three/webgpu';
import type { ParticleSpawn } from './layout.ts';
import type { ParticleNodes } from './material.ts';
import type { ParticleEnvironment } from './physics.ts';

/** Where particles live and integrate: TSL compute on WebGPU, typed arrays on WebGL2. */
export interface ParticleSimulation {
  readonly mode: 'gpu' | 'cpu';
  readonly capacity: number;
  /** Vertex inputs for the particle material, one vec4 per layout row. */
  readonly nodes: ParticleNodes;
  /** Instances the mesh must draw this frame (0 when nothing is alive). */
  readonly drawCount: number;
  /** Particles alive after the last step; the GPU path reports an upper bound. */
  readonly liveEstimate: number;
  /** Queues one particle; false when this frame's spawn budget is spent. */
  emit(spawn: ParticleSpawn): boolean;
  step(dt: number, env: ParticleEnvironment, renderer: WebGPURenderer): void;
  dispose(): void;
}
