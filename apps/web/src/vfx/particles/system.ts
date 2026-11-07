import {
  InstancedBufferGeometry,
  Mesh,
  PlaneGeometry,
  type MeshBasicNodeMaterial,
  type WebGPURenderer,
} from 'three/webgpu';
import type { RenderBackend } from '../../backend.ts';
import { CpuParticles } from './cpuParticles.ts';
import { GpuParticles } from './gpuParticles.ts';
import type { ParticleSpawn } from './layout.ts';
import { createParticleMaterial, type ParticleLayer } from './material.ts';
import type { ParticleEnvironment } from './physics.ts';
import type { ParticleSimulation } from './simulation.ts';

/** Drawn after the venue's transparent glass so sparks read in front of it. */
const RENDER_ORDER: Readonly<Record<ParticleLayer, number>> = { confetti: 20, glow: 30 };
/** A big hitch would launch sparks through the table; the step never exceeds this. */
export const MAX_PARTICLE_STEP = 1 / 20;

export interface ParticleSystemOptions {
  readonly capacity: number;
  readonly layer: ParticleLayer;
  readonly backend: RenderBackend;
}

/** One instanced draw call of particles, simulated on the GPU where the backend allows. */
export class ParticleSystem {
  readonly mesh: Mesh<InstancedBufferGeometry, MeshBasicNodeMaterial>;
  readonly simulation: ParticleSimulation;
  private emittedThisFrame = 0;
  private dropped = 0;

  constructor(options: ParticleSystemOptions) {
    this.simulation =
      options.backend === 'webgpu'
        ? new GpuParticles(options.capacity)
        : new CpuParticles(options.capacity);
    const quad = new PlaneGeometry(1, 1);
    const geometry = new InstancedBufferGeometry();
    geometry.index = quad.index;
    geometry.setAttribute('position', quad.getAttribute('position'));
    geometry.setAttribute('uv', quad.getAttribute('uv'));
    geometry.instanceCount = 0;
    const material = createParticleMaterial(this.simulation.nodes, options.layer);
    this.mesh = new Mesh(geometry, material);
    this.mesh.name = `vfx-particles-${options.layer}`;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = RENDER_ORDER[options.layer];
    this.mesh.matrixAutoUpdate = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
  }

  get mode(): 'gpu' | 'cpu' {
    return this.simulation.mode;
  }

  /** Particles emitted since the last `update`, and spawns refused because the frame was full. */
  get stats(): { readonly emitted: number; readonly dropped: number; readonly live: number } {
    return {
      emitted: this.emittedThisFrame,
      dropped: this.dropped,
      live: this.simulation.liveEstimate,
    };
  }

  emit(spawn: ParticleSpawn): void {
    if (this.simulation.emit(spawn)) this.emittedThisFrame++;
    else this.dropped++;
  }

  update(dt: number, env: ParticleEnvironment, renderer: WebGPURenderer): void {
    const step = Math.min(Math.max(dt, 0), MAX_PARTICLE_STEP);
    this.simulation.step(step, env, renderer);
    this.mesh.geometry.instanceCount = this.simulation.drawCount;
    this.mesh.visible = this.simulation.drawCount > 0;
    this.emittedThisFrame = 0;
  }

  clear(): void {
    this.simulation.clear();
    this.mesh.geometry.instanceCount = 0;
    this.mesh.visible = false;
    this.emittedThisFrame = 0;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.simulation.dispose();
  }
}
