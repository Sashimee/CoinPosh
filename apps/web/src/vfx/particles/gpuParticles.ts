import {
  clamp,
  cos,
  dot,
  exp,
  float,
  floor,
  Fn,
  If,
  instanceIndex,
  int,
  select,
  sin,
  sqrt,
  storage,
  uniform,
  uniformArray,
  vec3,
  vec4,
} from 'three/tsl';
import {
  StorageBufferAttribute,
  StorageInstancedBufferAttribute,
  Vector4,
  type ComputeNode,
  type StorageBufferNode,
  type WebGPURenderer,
} from 'three/webgpu';
import {
  ATTRACTOR_SLOTS,
  createParticleBuffers,
  isValidSpawn,
  ParticleKind,
  writeParticle,
  type ParticleBuffers,
  type ParticleSpawn,
} from './layout.ts';
import type { ParticleNodes } from './material.ts';
import { PARTICLE_PHYSICS, type ParticleEnvironment } from './physics.ts';
import type { ParticleSimulation } from './simulation.ts';

/** Spawns uploaded per frame; emitters are budgeted well below it. */
export const GPU_SPAWN_BATCH = 2048;

const ROWS = ['posAge', 'velLife', 'color', 'params'] as const;
type Row = (typeof ROWS)[number];

/**
 * WebGPU path: particle state lives in storage buffers and two TSL compute kernels run
 * each frame, one copying this frame's spawns into the ring, one integrating every slot
 * (a port of `stepParticles`). The render pass reads the same buffers as instanced vertex
 * attributes, so nothing comes back to the CPU.
 */
export class GpuParticles implements ParticleSimulation {
  readonly mode = 'gpu';
  readonly nodes: ParticleNodes;
  /**
   * Spawns accepted per frame. Never above the capacity: two spawns of one batch would
   * otherwise wrap onto the same slot and race in the spawn kernel.
   */
  readonly spawnBatch: number;
  /** This frame's spawns, in the CPU layout; the staging storage buffers wrap these arrays. */
  readonly staged: ParticleBuffers;
  private readonly staging: Record<Row, StorageBufferAttribute>;
  private readonly spawnCount = uniform(0, 'uint');
  private readonly spawnBase = uniform(0, 'uint');
  private readonly dt = uniform(0);
  private readonly floorRect = uniform(new Vector4());
  private readonly floorY = uniform(0);
  private readonly attractorValues = Array.from({ length: ATTRACTOR_SLOTS }, () => new Vector4());
  readonly spawnKernel: ComputeNode;
  readonly updateKernel: ComputeNode;
  /** Frees every slot; queued by `clear()` and run ahead of the next spawns. */
  readonly clearKernel: ComputeNode;
  private clearQueued = false;
  private pending = 0;
  private head = 0;
  /** Seconds until every particle spawned so far has certainly expired. */
  private quietIn = 0;
  private live = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`GpuParticles capacity must be a positive integer, got ${capacity}`);
    }
    const batch = Math.min(GPU_SPAWN_BATCH, capacity);
    this.spawnBatch = batch;
    this.staged = createParticleBuffers(batch);
    const state = {} as Record<Row, StorageBufferNode<'vec4'>>;
    const staged = {} as Record<Row, StorageBufferNode<'vec4'>>;
    const staging = {} as Record<Row, StorageBufferAttribute>;
    for (const row of ROWS) {
      state[row] = storage(
        new StorageInstancedBufferAttribute(new Float32Array(capacity * 4), 4),
        'vec4',
        capacity,
      );
      staging[row] = new StorageBufferAttribute(this.staged[row], 4);
      staged[row] = storage(staging[row], 'vec4', batch).toReadOnly();
    }
    this.staging = staging;
    this.nodes = {
      posAge: state.posAge.toAttribute(),
      velLife: state.velLife.toAttribute(),
      color: state.color.toAttribute(),
      params: state.params.toAttribute(),
    };

    const { spawnCount, spawnBase } = this;
    this.spawnKernel = Fn(() => {
      If(instanceIndex.lessThan(spawnCount), () => {
        const slot = spawnBase.add(instanceIndex).mod(capacity);
        for (const row of ROWS) state[row].element(slot).assign(staged[row].element(instanceIndex));
      });
    })().compute(batch);

    this.clearKernel = Fn(() => {
      state.velLife.element(instanceIndex).w.assign(0);
    })().compute(capacity);

    const attractors = uniformArray<'vec4'>(this.attractorValues, 'vec4');
    const { dt, floorRect, floorY } = this;
    const physics = PARTICLE_PHYSICS;
    const homingDamping = 2 * Math.sqrt(physics.homingStiffness);
    this.updateKernel = Fn(() => {
      const posAge = state.posAge.element(instanceIndex);
      const velLife = state.velLife.element(instanceIndex);
      const params = state.params.element(instanceIndex);
      If(velLife.w.greaterThan(0), () => {
        const age = posAge.w.add(dt).toVar();
        If(age.greaterThanEqual(velLife.w), () => {
          velLife.w.assign(0);
        }).Else(() => {
          const p = posAge.xyz.toVar();
          const v = velLife.xyz.toVar();
          const drag = params.x;
          const kind = params.z;
          const seed = params.w;
          If(kind.equal(ParticleKind.Homing), () => {
            const slot = clamp(floor(params.y.add(0.5)), 0, ATTRACTOR_SLOTS - 1);
            const toTarget = attractors.element(int(slot)).xyz.sub(p);
            If(sqrt(dot(toTarget, toTarget)).lessThan(physics.homingArrival), () => {
              velLife.w.assign(0);
            }).Else(() => {
              v.addAssign(
                toTarget
                  .mul(physics.homingStiffness)
                  .sub(v.mul(float(homingDamping).add(drag)))
                  .mul(dt),
              );
              p.addAssign(v.mul(dt));
              posAge.assign(vec4(p, age));
              velLife.xyz.assign(v);
            });
          }).Else(() => {
            v.y.addAssign(params.y.mul(physics.gravity).mul(dt));
            If(kind.equal(ParticleKind.Confetti), () => {
              const f = physics.flutter;
              v.x.addAssign(
                sin(age.mul(f.rateX).add(seed.mul(40)))
                  .mul(f.amplitude)
                  .mul(dt),
              );
              v.z.addAssign(
                cos(age.mul(f.rateZ).add(seed.mul(23)))
                  .mul(f.amplitude)
                  .mul(dt),
              );
            });
            v.mulAssign(exp(drag.negate().mul(dt)));
            const previousY = p.y.toVar();
            p.addAssign(v.mul(dt));
            const overTable = p.x
              .greaterThanEqual(floorRect.x)
              .and(p.x.lessThanEqual(floorRect.y))
              .and(p.z.greaterThanEqual(floorRect.z))
              .and(p.z.lessThanEqual(floorRect.w));
            If(
              overTable
                .and(p.y.lessThan(floorY))
                .and(previousY.greaterThanEqual(floorY))
                .and(v.y.lessThan(0)),
              () => {
                const restitution = select(
                  kind.equal(ParticleKind.Spark),
                  physics.restitution[ParticleKind.Spark],
                  select(
                    kind.equal(ParticleKind.Glint),
                    physics.restitution[ParticleKind.Glint],
                    0,
                  ),
                );
                const friction = select(
                  kind.equal(ParticleKind.Spark),
                  physics.friction[ParticleKind.Spark],
                  select(
                    kind.equal(ParticleKind.Glint),
                    physics.friction[ParticleKind.Glint],
                    select(
                      kind.equal(ParticleKind.Mote),
                      physics.friction[ParticleKind.Mote],
                      physics.friction[ParticleKind.Confetti],
                    ),
                  ),
                );
                p.y.assign(floorY);
                v.assign(vec3(v.x.mul(friction), v.y.negate().mul(restitution), v.z.mul(friction)));
              },
            );
            If(p.y.lessThan(physics.killY), () => {
              velLife.w.assign(0);
            }).Else(() => {
              posAge.assign(vec4(p, age));
              velLife.xyz.assign(v);
            });
          });
        });
      });
    })().compute(capacity);
  }

  get drawCount(): number {
    return this.quietIn > 0 || this.pending > 0 ? this.capacity : 0;
  }

  get liveEstimate(): number {
    return this.quietIn > 0 ? this.live : 0;
  }

  emit(spawn: ParticleSpawn): boolean {
    if (this.pending >= this.spawnBatch || !isValidSpawn(spawn)) return false;
    writeParticle(this.staged, this.pending, spawn);
    this.pending++;
    this.quietIn = Math.max(this.quietIn, spawn.life);
    return true;
  }

  step(dt: number, env: ParticleEnvironment, renderer: WebGPURenderer): void {
    if (this.pending === 0 && this.quietIn <= 0) return;
    if (!renderer.initialized) {
      throw new Error(
        'GPU particles stepped before the renderer finished init(); await renderer.init() first',
      );
    }
    const kernels: ComputeNode[] = [];
    if (this.clearQueued) {
      kernels.push(this.clearKernel);
      this.clearQueued = false;
    }
    if (this.pending > 0) {
      for (const row of ROWS) {
        const attribute = this.staging[row];
        attribute.clearUpdateRanges();
        attribute.addUpdateRange(0, this.pending * 4);
        attribute.needsUpdate = true;
      }
      this.spawnCount.value = this.pending;
      this.spawnBase.value = this.head;
      this.head = (this.head + this.pending) % this.capacity;
      this.live = Math.min(this.capacity, this.live + this.pending);
      this.pending = 0;
      kernels.push(this.spawnKernel);
    }
    const { floor, attractors } = env;
    this.floorRect.value.set(floor.minX, floor.maxX, floor.minZ, floor.maxZ);
    this.floorY.value = floor.y;
    for (let i = 0; i < ATTRACTOR_SLOTS; i++) {
      this.attractorValues[i]?.fromArray(attractors, i * 4);
    }
    this.dt.value = dt;
    kernels.push(this.updateKernel);
    void renderer.compute(kernels);
    this.quietIn -= dt;
    if (this.quietIn <= 0) this.live = 0;
  }

  /**
   * Drops every particle without rebuilding buffers or kernels. Nothing is drawn until
   * the next spawn, and the clear kernel runs just ahead of that spawn's upload.
   */
  clear(): void {
    this.pending = 0;
    this.head = 0;
    this.quietIn = 0;
    this.live = 0;
    this.clearQueued = true;
  }

  dispose(): void {
    this.spawnKernel.dispose();
    this.updateKernel.dispose();
    this.clearKernel.dispose();
  }
}
