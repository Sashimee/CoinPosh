import { instancedDynamicBufferAttribute } from 'three/tsl';
import { DynamicDrawUsage, InstancedBufferAttribute, type Node } from 'three/webgpu';
import {
  createParticleBuffers,
  isValidSpawn,
  writeParticle,
  type ParticleBuffers,
  type ParticleSpawn,
} from './layout.ts';
import type { ParticleNodes } from './material.ts';
import { stepParticles, type ParticleEnvironment } from './physics.ts';
import type { ParticleSimulation } from './simulation.ts';

const ROWS = ['posAge', 'velLife', 'color', 'params'] as const;

/**
 * The WebGL2 fallback: integrates in JS, then packs the live particles to the front of the
 * instanced attributes and uploads only that range, so an idle system costs nothing and a
 * burst uploads a few kilobytes.
 */
export class CpuParticles implements ParticleSimulation {
  readonly mode = 'cpu';
  readonly nodes: ParticleNodes;
  private readonly state: ParticleBuffers;
  private readonly render: ParticleBuffers;
  private readonly attributes: Record<(typeof ROWS)[number], InstancedBufferAttribute>;
  private head = 0;
  private live = 0;
  private uploaded = 0;
  private dirty = false;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`CpuParticles capacity must be a positive integer, got ${capacity}`);
    }
    this.state = createParticleBuffers(capacity);
    this.render = createParticleBuffers(capacity);
    const make = (array: Float32Array): InstancedBufferAttribute => {
      const attribute = new InstancedBufferAttribute(array, 4);
      attribute.setUsage(DynamicDrawUsage);
      return attribute;
    };
    this.attributes = {
      posAge: make(this.render.posAge),
      velLife: make(this.render.velLife),
      color: make(this.render.color),
      params: make(this.render.params),
    };
    const node = (row: (typeof ROWS)[number]): Node<'vec4'> =>
      instancedDynamicBufferAttribute(this.attributes[row], 'vec4');
    this.nodes = {
      posAge: node('posAge'),
      velLife: node('velLife'),
      color: node('color'),
      params: node('params'),
    };
  }

  get drawCount(): number {
    return this.uploaded;
  }

  get liveEstimate(): number {
    return this.live;
  }

  emit(spawn: ParticleSpawn): boolean {
    if (!isValidSpawn(spawn)) return false;
    writeParticle(this.state, this.head, spawn);
    this.head = (this.head + 1) % this.capacity;
    this.live = Math.min(this.live + 1, this.capacity);
    this.dirty = true;
    return true;
  }

  step(dt: number, env: ParticleEnvironment): void {
    if (this.live === 0 && !this.dirty && this.uploaded === 0) return;
    this.live = stepParticles(this.state, this.capacity, dt, env);
    this.dirty = false;
    const packed = this.pack();
    this.uploaded = packed;
    for (const row of ROWS) {
      const attribute = this.attributes[row];
      attribute.clearUpdateRanges();
      if (packed > 0) attribute.addUpdateRange(0, packed * 4);
      attribute.needsUpdate = packed > 0;
    }
  }

  clear(): void {
    for (const row of ROWS) this.state[row].fill(0);
    this.head = 0;
    this.live = 0;
    this.uploaded = 0;
    this.dirty = false;
  }

  dispose(): void {
    this.live = 0;
    this.uploaded = 0;
  }

  private pack(): number {
    const { state, render, capacity } = this;
    let n = 0;
    for (let i = 0; i < capacity; i++) {
      const o = i * 4;
      if ((state.velLife[o + 3] ?? 0) <= 0) continue;
      const d = n * 4;
      for (const row of ROWS) {
        const from = state[row];
        const to = render[row];
        to[d] = from[o] ?? 0;
        to[d + 1] = from[o + 1] ?? 0;
        to[d + 2] = from[o + 2] ?? 0;
        to[d + 3] = from[o + 3] ?? 0;
      }
      n++;
    }
    return n;
  }
}
