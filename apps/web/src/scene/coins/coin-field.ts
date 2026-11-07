import { uniform } from 'three/tsl';
import {
  BufferGeometry,
  Frustum,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Vector3,
  type PerspectiveCamera,
  type WebGPURenderer,
} from 'three/webgpu';
import { bakeCoinEmboss, DEFAULT_EMBOSS_RESOLUTION, type CoinEmbossBake } from './emboss.ts';
import { createCoinGeometry, FAR_COIN_GEOMETRY, NEAR_COIN_GEOMETRY } from './geometry.ts';
import {
  DEFAULT_LOD_SETTINGS,
  partitionByLod,
  pixelsPerUnit,
  type LodOutput,
  type LodSettings,
} from './lod.ts';
import { createCoinMaterial, type CoinMaterial } from './materials.ts';
import { COIN_LOOKS, COIN_TIER_IDS, type CoinTierId } from './tiers.ts';

export interface CoinFieldOptions {
  readonly capacity: number | Readonly<Record<CoinTierId, number>>;
  readonly radius?: number;
  readonly lod?: LodSettings;
  readonly castShadow?: boolean;
  readonly receiveShadow?: boolean;
}

export interface CoinFieldStats {
  readonly near: number;
  readonly far: number;
  readonly culled: number;
  readonly drawCalls: number;
}

interface TierBatch {
  readonly tier: CoinTierId;
  readonly capacity: number;
  readonly positions: Float32Array;
  readonly quaternions: Float32Array;
  readonly lodState: Uint8Array;
  readonly lists: LodOutput;
  readonly near: InstancedMesh;
  readonly far: InstancedMesh;
  readonly material: CoinMaterial;
  count: number;
  bake: CoinEmbossBake | null;
}

const SEED_STRIDE = 7919;
const projection = new Matrix4();
const worldToLocal = new Matrix4();
const cameraLocal = new Vector3();

function instancedGeometry(base: BufferGeometry, capacity: number): BufferGeometry {
  const geometry = new BufferGeometry();
  for (const [name, attribute] of Object.entries(base.attributes))
    geometry.setAttribute(name, attribute);
  geometry.setIndex(base.getIndex());
  geometry.boundingSphere = base.boundingSphere;
  geometry.boundingBox = base.boundingBox;
  geometry.setAttribute('coinSeed', new InstancedBufferAttribute(new Float32Array(capacity), 1));
  return geometry;
}

function writeInstance(
  target: Float32Array,
  slot: number,
  positions: Float32Array,
  quaternions: Float32Array,
  index: number,
  scale: number,
): void {
  const px = positions[index * 3] ?? 0;
  const py = positions[index * 3 + 1] ?? 0;
  const pz = positions[index * 3 + 2] ?? 0;
  const x = quaternions[index * 4] ?? 0;
  const y = quaternions[index * 4 + 1] ?? 0;
  const z = quaternions[index * 4 + 2] ?? 0;
  const w = quaternions[index * 4 + 3] ?? 1;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  const o = slot * 16;
  target[o] = (1 - (yy + zz)) * scale;
  target[o + 1] = (xy + wz) * scale;
  target[o + 2] = (xz - wy) * scale;
  target[o + 3] = 0;
  target[o + 4] = (xy - wz) * scale;
  target[o + 5] = (1 - (xx + zz)) * scale;
  target[o + 6] = (yz + wx) * scale;
  target[o + 7] = 0;
  target[o + 8] = (xz + wy) * scale;
  target[o + 9] = (yz - wx) * scale;
  target[o + 10] = (1 - (xx + yy)) * scale;
  target[o + 11] = 0;
  target[o + 12] = px;
  target[o + 13] = py;
  target[o + 14] = pz;
  target[o + 15] = 1;
}

/**
 * Every coin on the table, drawn as two instanced meshes per tier (near and far LOD).
 * Transforms arrive per tier as flat arrays indexed by a stable slot, so the sim worker can
 * hand over its typed arrays directly; `update` then culls, picks a LOD per coin and uploads.
 */
export class CoinField {
  readonly object = new Group();
  readonly radius: number;
  private readonly batches: ReadonlyMap<CoinTierId, TierBatch>;
  private readonly lod: LodSettings;
  private readonly motion = uniform(1);
  private readonly frustum = new Frustum();
  private lastStats: CoinFieldStats = { near: 0, far: 0, culled: 0, drawCalls: 0 };

  constructor(options: CoinFieldOptions) {
    this.radius = options.radius ?? 1;
    if (!(this.radius > 0))
      throw new Error(`CoinField radius must be positive, got ${this.radius}`);
    this.lod = options.lod ?? DEFAULT_LOD_SETTINGS;
    this.object.name = 'coins';

    const nearBase = createCoinGeometry(NEAR_COIN_GEOMETRY);
    const farBase = createCoinGeometry(FAR_COIN_GEOMETRY);
    const batches = new Map<CoinTierId, TierBatch>();

    for (const tier of COIN_TIER_IDS) {
      const capacity =
        typeof options.capacity === 'number' ? options.capacity : options.capacity[tier];
      if (!Number.isInteger(capacity) || capacity < 0) {
        throw new Error(
          `CoinField capacity for ${tier} must be a non-negative integer, got ${capacity}`,
        );
      }
      const material = createCoinMaterial(COIN_LOOKS[tier], this.motion);
      const slots = Math.max(capacity, 1);
      const near = new InstancedMesh(instancedGeometry(nearBase, slots), material.material, slots);
      const far = new InstancedMesh(instancedGeometry(farBase, slots), material.material, slots);
      for (const [mesh, level] of [
        [near, 'near'],
        [far, 'far'],
      ] as const) {
        mesh.name = `coins-${tier}-${level}`;
        mesh.count = 0;
        mesh.visible = false;
        mesh.frustumCulled = false;
        mesh.castShadow = options.castShadow ?? true;
        mesh.receiveShadow = options.receiveShadow ?? true;
        this.object.add(mesh);
      }
      batches.set(tier, {
        tier,
        capacity,
        positions: new Float32Array(slots * 3),
        quaternions: new Float32Array(slots * 4).map((_, i) => (i % 4 === 3 ? 1 : 0)),
        lodState: new Uint8Array(slots),
        lists: {
          near: new Uint32Array(slots),
          far: new Uint32Array(slots),
          nearCount: 0,
          farCount: 0,
        },
        near,
        far,
        material,
        count: 0,
        bake: null,
      });
    }
    nearBase.dispose();
    farBase.dispose();
    this.batches = batches;
  }

  capacity(tier: CoinTierId): number {
    return this.batch(tier).capacity;
  }

  count(tier: CoinTierId): number {
    return this.batch(tier).count;
  }

  setCount(tier: CoinTierId, count: number): void {
    const batch = this.batch(tier);
    if (!Number.isInteger(count) || count < 0 || count > batch.capacity) {
      throw new Error(
        `CoinField.setCount(${tier}, ${count}) is outside capacity 0..${batch.capacity}`,
      );
    }
    batch.count = count;
  }

  setTransform(
    tier: CoinTierId,
    index: number,
    x: number,
    y: number,
    z: number,
    qx: number,
    qy: number,
    qz: number,
    qw: number,
  ): void {
    const batch = this.batch(tier);
    if (!Number.isInteger(index) || index < 0 || index >= batch.capacity) {
      throw new Error(
        `CoinField.setTransform(${tier}, ${index}) is outside capacity 0..${batch.capacity - 1}`,
      );
    }
    batch.positions[index * 3] = x;
    batch.positions[index * 3 + 1] = y;
    batch.positions[index * 3 + 2] = z;
    batch.quaternions[index * 4] = qx;
    batch.quaternions[index * 4 + 1] = qy;
    batch.quaternions[index * 4 + 2] = qz;
    batch.quaternions[index * 4 + 3] = qw;
  }

  /** Copies `count` coins from xyz positions and xyzw quaternions, replacing the tier's set. */
  setTransforms(
    tier: CoinTierId,
    positions: ArrayLike<number>,
    quaternions: ArrayLike<number>,
    count: number,
  ): void {
    const batch = this.batch(tier);
    if (positions.length < count * 3 || quaternions.length < count * 4) {
      throw new Error(
        `CoinField.setTransforms(${tier}): ${count} coins need ${count * 3} position and ${count * 4} quaternion values`,
      );
    }
    this.setCount(tier, count);
    for (let i = 0; i < count * 3; i += 1) batch.positions[i] = positions[i] ?? 0;
    for (let i = 0; i < count * 4; i += 1) batch.quaternions[i] = quaternions[i] ?? 0;
  }

  /** Bakes every tier's embossed face. Call once after `renderer.init()`. */
  bake(renderer: WebGPURenderer, resolution = DEFAULT_EMBOSS_RESOLUTION): void {
    for (const batch of this.batches.values()) {
      batch.bake?.dispose();
      batch.bake = bakeCoinEmboss(renderer, COIN_LOOKS[batch.tier].face, resolution);
      batch.material.setEmboss(batch.bake.texture);
    }
  }

  setReducedMotion(reduced: boolean): void {
    this.motion.value = reduced ? 0 : 1;
  }

  update(camera: PerspectiveCamera, viewportHeightPx: number): CoinFieldStats {
    this.object.updateWorldMatrix(true, false);
    camera.updateMatrixWorld();
    projection
      .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      .multiply(this.object.matrixWorld);
    this.frustum.setFromProjectionMatrix(projection, camera.coordinateSystem);
    worldToLocal.copy(this.object.matrixWorld).invert();
    cameraLocal.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(worldToLocal);

    const view = {
      cameraX: cameraLocal.x,
      cameraY: cameraLocal.y,
      cameraZ: cameraLocal.z,
      pixelsPerUnitAtUnitDistance: pixelsPerUnit(camera.fov / camera.zoom, viewportHeightPx),
      frustum: this.frustum,
    };

    let near = 0;
    let far = 0;
    let total = 0;
    let drawCalls = 0;
    for (const batch of this.batches.values()) {
      total += batch.count;
      partitionByLod(
        {
          positions: batch.positions,
          count: batch.count,
          radius: this.radius * 1.01,
          state: batch.lodState,
        },
        view,
        this.lod,
        batch.lists,
      );
      this.upload(batch.near, batch, batch.lists.near, batch.lists.nearCount);
      this.upload(batch.far, batch, batch.lists.far, batch.lists.farCount);
      near += batch.lists.nearCount;
      far += batch.lists.farCount;
      drawCalls += (batch.lists.nearCount > 0 ? 1 : 0) + (batch.lists.farCount > 0 ? 1 : 0);
    }
    this.lastStats = { near, far, culled: total - near - far, drawCalls };
    return this.lastStats;
  }

  get stats(): CoinFieldStats {
    return this.lastStats;
  }

  mesh(tier: CoinTierId, level: 'near' | 'far'): InstancedMesh {
    return this.batch(tier)[level];
  }

  dispose(): void {
    for (const batch of this.batches.values()) {
      batch.bake?.dispose();
      batch.material.material.dispose();
      batch.near.geometry.dispose();
      batch.far.geometry.dispose();
      batch.near.dispose();
      batch.far.dispose();
    }
    this.object.clear();
  }

  private upload(mesh: InstancedMesh, batch: TierBatch, slots: Uint32Array, count: number): void {
    mesh.count = count;
    mesh.visible = count > 0;
    if (count === 0) return;
    const matrices = mesh.instanceMatrix.array as Float32Array;
    const seeds = mesh.geometry.getAttribute('coinSeed') as InstancedBufferAttribute;
    const seedArray = seeds.array as Float32Array;
    const seedOffset = COIN_TIER_IDS.indexOf(batch.tier) * SEED_STRIDE;
    for (let k = 0; k < count; k += 1) {
      const index = slots[k] ?? 0;
      writeInstance(matrices, k, batch.positions, batch.quaternions, index, this.radius);
      seedArray[k] = seedOffset + index;
    }
    mesh.instanceMatrix.clearUpdateRanges();
    mesh.instanceMatrix.addUpdateRange(0, count * 16);
    mesh.instanceMatrix.needsUpdate = true;
    seeds.clearUpdateRanges();
    seeds.addUpdateRange(0, count);
    seeds.needsUpdate = true;
  }

  private batch(tier: CoinTierId): TierBatch {
    const batch = this.batches.get(tier);
    if (!batch) throw new Error(`CoinField has no tier "${tier}"`);
    return batch;
  }
}
