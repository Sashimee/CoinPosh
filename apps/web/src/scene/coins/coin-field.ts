import { attribute, float, pow, smoothstep, uniform, uv, vec3 } from 'three/tsl';
import {
  BufferGeometry,
  CircleGeometry,
  Frustum,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicNodeMaterial,
  Vector3,
  type LightShadow,
  type PerspectiveCamera,
  type WebGPURenderer,
} from 'three/webgpu';
import { bakeCoinEmboss, DEFAULT_EMBOSS_RESOLUTION, type CoinEmbossBake } from './emboss.ts';
import { createCoinGeometry, FAR_COIN_GEOMETRY, NEAR_COIN_GEOMETRY } from './geometry.ts';
import {
  CoinLod,
  DEFAULT_LOD_SETTINGS,
  partitionByLod,
  pixelsPerUnit,
  type LodOutput,
  type LodSettings,
  type LodView,
} from './lod.ts';
import { createCoinMaterial, type CoinMaterial } from './materials.ts';
import { COIN_LOOKS, COIN_TIER_IDS, type CoinTierId } from './tiers.ts';

export interface CoinFieldOptions {
  readonly capacity: number | Readonly<Record<CoinTierId, number>>;
  readonly radius?: number;
  readonly lod?: LodSettings;
  /** Adds the far-LOD shadow caster; it only shows up once a light opts in via `castShadowsFrom`. */
  readonly castShadow?: boolean;
  readonly receiveShadow?: boolean;
}

/**
 * The layer the coin shadow caster lives on. The main camera never enables it, so the caster
 * costs nothing in the colour pass; a light's shadow camera enables it through
 * `CoinField.castShadowsFrom`.
 */
export const COIN_SHADOW_LAYER = 30;

/** Reach of a coin's contact occlusion, in coin radii, and its darkest opacity at the rim. */
const CONTACT_REACH = 1.55;
const CONTACT_OPACITY = 0.62;
/** Lifts the contact disc off whatever the coin rests on, metres per unit radius. */
const CONTACT_LIFT = 0.02;
/**
 * Vertical travel between two transform updates, in coin radii, over which a coin goes from
 * resting to airborne. Settled coins jitter far below the floor; a coin a few frames into a
 * fall already moves several times the ceiling.
 */
const AIRBORNE_FLOOR = 0.04;
const AIRBORNE_CEILING = 0.15;
/** How much airborne-ness survives each update, so a landed coin's disc eases back in. */
const AIRBORNE_DECAY = 0.82;
const AIRBORNE_SNAP = 0.01;
const CONTACT_HIDDEN = 0.99;

/**
 * A soft dark ring under every coin, one draw call for the whole field: it grounds coins on
 * the felt and darkens the seam between stacked coins, which the shadow map is too coarse to
 * resolve (and which the low tier draws without coin shadows at all).
 */
function createContactOcclusion(capacity: number): InstancedMesh {
  const slots = Math.max(capacity, 1);
  const geometry = new CircleGeometry(CONTACT_REACH, 28);
  geometry.rotateX(-Math.PI / 2);
  geometry.setAttribute(
    'contactStrength',
    new InstancedBufferAttribute(new Float32Array(slots), 1),
  );
  const material = new MeshBasicNodeMaterial({
    name: 'coins/contact-occlusion',
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const r = uv()
    .sub(0.5)
    .length()
    .mul(2 * CONTACT_REACH);
  material.colorNode = vec3(0, 0, 0);
  material.opacityNode = pow(float(1).sub(smoothstep(0.92, CONTACT_REACH, r)), 1.6)
    .mul(CONTACT_OPACITY)
    .mul(attribute('contactStrength', 'float'));
  const mesh = new InstancedMesh(geometry, material, slots);
  mesh.name = 'coins-contact-occlusion';
  mesh.count = 0;
  mesh.visible = false;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = 1;
  return mesh;
}

/**
 * Lays a coin's contact disc flat under its lower face. The disc shrinks with the coin's tilt
 * so a coin standing on its rim leaves no dark pancake hanging beside it, and shrinks further
 * while the coin is airborne (`air` 0..1), as its opacity fades with it.
 */
function writeContact(
  target: Float32Array,
  slot: number,
  positions: Float32Array,
  quaternions: Float32Array,
  index: number,
  radius: number,
  halfThickness: number,
  air: number,
): void {
  const x = quaternions[index * 4] ?? 0;
  const z = quaternions[index * 4 + 2] ?? 0;
  const upY = Math.abs(1 - 2 * (x * x + z * z));
  const scale = radius * upY * upY * (1 - 0.5 * air);
  const o = slot * 16;
  target.fill(0, o, o + 16);
  target[o] = scale;
  target[o + 5] = scale;
  target[o + 10] = scale;
  target[o + 12] = positions[index * 3] ?? 0;
  target[o + 13] = (positions[index * 3 + 1] ?? 0) - radius * (halfThickness * upY - CONTACT_LIFT);
  target[o + 14] = positions[index * 3 + 2] ?? 0;
  target[o + 15] = 1;
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
  readonly ids: Float64Array;
  readonly lodState: Uint8Array;
  readonly air: Float32Array;
  readonly seeds: Float32Array;
  readonly lists: LodOutput;
  readonly near: InstancedMesh;
  readonly far: InstancedMesh;
  readonly material: CoinMaterial;
  count: number;
  bake: CoinEmbossBake | null;
}

const SEED_STRIDE = 7919;
// Keeps seeds exact in the float32 instance attribute however large the caller's ids get.
const SEED_RANGE = 1 << 20;
const MIN_EMBOSS_RESOLUTION = 64;
const MAX_EMBOSS_RESOLUTION = 4096;
const projection = new Matrix4();
const worldToLocal = new Matrix4();
const cameraLocal = new Vector3();

function airborneFromTravel(travel: number, radius: number): number {
  const t = (travel / radius - AIRBORNE_FLOOR) / (AIRBORNE_CEILING - AIRBORNE_FLOOR);
  const c = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

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

type MutableLodView = { -readonly [K in keyof LodView]: LodView[K] };
type MutableStats = { -readonly [K in keyof CoinFieldStats]: CoinFieldStats[K] };

/**
 * Every coin on the table, drawn as two instanced meshes per tier (near and far LOD), so the
 * colour pass costs at most two draw calls per tier rather than the single call per tier in
 * 01-ARCHITECTURE; the second call is what the LOD buys. Shadows come from one far-LOD caster
 * holding every coin of every tier, so the shadow pass is a single draw call that is
 * independent of main-camera culling.
 * Transforms arrive per tier as flat arrays plus one coin id per slot, so the sim worker can
 * hand over its typed arrays directly in whatever order it keeps them. Everything that must
 * stick to a coin (its tint seed and its LOD level) follows the id, never the slot, so
 * compacting or reusing slots changes nothing on screen. `update` then culls, picks a LOD per
 * coin and uploads.
 */
export class CoinField {
  readonly object = new Group();
  readonly radius: number;
  private readonly batches: ReadonlyMap<CoinTierId, TierBatch>;
  private readonly lod: LodSettings;
  private readonly motion = uniform(1);
  private readonly frustum = new Frustum();
  private readonly shadowCaster: InstancedMesh | null;
  private readonly contact: InstancedMesh;
  private shadowsEnabled = false;
  private contactDirty = true;
  private populated = false;
  private readonly lastContactView = new Matrix4();
  private readonly carriedLod = new Map<number, number>();
  private readonly carriedY = new Map<number, number>();
  private readonly carriedAir = new Map<number, number>();
  private readonly incomingIds = new Set<number>();
  private readonly view: MutableLodView = {
    cameraX: 0,
    cameraY: 0,
    cameraZ: 0,
    pixelsPerUnitAtUnitDistance: 0,
    frustum: null,
  };
  private readonly lastStats: MutableStats = { near: 0, far: 0, culled: 0, drawCalls: 0 };

  constructor(options: CoinFieldOptions) {
    this.radius = options.radius ?? 1;
    if (!(this.radius > 0))
      throw new Error(`CoinField radius must be positive, got ${this.radius}`);
    this.lod = options.lod ?? DEFAULT_LOD_SETTINGS;
    this.object.name = 'coins';

    const nearBase = createCoinGeometry(NEAR_COIN_GEOMETRY);
    const farBase = createCoinGeometry(FAR_COIN_GEOMETRY);
    const batches = new Map<CoinTierId, TierBatch>();
    let totalSlots = 0;

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
        mesh.castShadow = false;
        mesh.receiveShadow = options.receiveShadow ?? true;
        this.object.add(mesh);
      }
      batches.set(tier, {
        tier,
        capacity,
        positions: new Float32Array(slots * 3),
        quaternions: new Float32Array(slots * 4).map((_, i) => (i % 4 === 3 ? 1 : 0)),
        ids: new Float64Array(slots),
        lodState: new Uint8Array(slots).fill(CoinLod.unset),
        air: new Float32Array(slots),
        seeds: new Float32Array(slots).map((_, i) => i),
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
      totalSlots += slots;
    }

    this.contact = createContactOcclusion(totalSlots);
    this.object.add(this.contact);

    this.shadowCaster = null;
    if (options.castShadow ?? true) {
      const caster = new InstancedMesh(farBase.clone(), new MeshBasicNodeMaterial(), totalSlots);
      caster.name = 'coins-shadow-caster';
      caster.layers.set(COIN_SHADOW_LAYER);
      caster.count = 0;
      caster.visible = false;
      caster.frustumCulled = false;
      caster.castShadow = true;
      caster.receiveShadow = false;
      this.object.add(caster);
      this.shadowCaster = caster;
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

  /**
   * Replaces the tier's coins with `count` coins: xyz positions, xyzw quaternions and one
   * integer id per coin, unique within the tier (the sim's coin id). A coin keeps its tint
   * and its LOD level for as long as its id stays in the set, whatever slot it arrives in.
   * Throws without changing anything if the input is short, over capacity or has bad ids.
   */
  setTransforms(
    tier: CoinTierId,
    positions: ArrayLike<number>,
    quaternions: ArrayLike<number>,
    count: number,
    ids: ArrayLike<number>,
  ): void {
    const batch = this.batch(tier);
    const where = `CoinField.setTransforms(${tier})`;
    if (!Number.isInteger(count) || count < 0 || count > batch.capacity) {
      throw new Error(`${where}: count ${count} is outside capacity 0..${batch.capacity}`);
    }
    if (positions.length < count * 3 || quaternions.length < count * 4 || ids.length < count) {
      throw new Error(
        `${where}: ${count} coins need ${count * 3} position, ${count * 4} quaternion and ${count} id values`,
      );
    }
    const incoming = this.incomingIds;
    incoming.clear();
    for (let i = 0; i < count; i += 1) {
      const id = ids[i];
      if (id === undefined || !Number.isSafeInteger(id)) {
        throw new Error(`${where}: id at ${i} is ${id}, expected a safe integer coin id`);
      }
      if (incoming.has(id)) {
        throw new Error(`${where}: coin id ${id} appears twice; ids must be unique per tier`);
      }
      incoming.add(id);
    }
    incoming.clear();

    const carried = this.carriedLod;
    const carriedY = this.carriedY;
    const carriedAir = this.carriedAir;
    for (let i = 0; i < batch.count; i += 1) {
      const id = batch.ids[i] ?? 0;
      carried.set(id, batch.lodState[i] ?? CoinLod.unset);
      carriedY.set(id, batch.positions[i * 3 + 1] ?? 0);
      carriedAir.set(id, batch.air[i] ?? 0);
    }
    let changed = count !== batch.count;
    for (let i = 0; i < count; i += 1) {
      const id = ids[i] ?? 0;
      if (batch.ids[i] !== id) changed = true;
      batch.ids[i] = id;
      batch.lodState[i] = carried.get(id) ?? CoinLod.unset;
      batch.seeds[i] = ((id % SEED_RANGE) + SEED_RANGE) % SEED_RANGE;
      const lastY = carriedY.get(id);
      const lastAir = carriedAir.get(id);
      // A coin that shows up after the first drawn frame was dropped in, so it starts airborne.
      let air = this.populated ? 1 : 0;
      if (lastY !== undefined && lastAir !== undefined) {
        const travel = Math.abs((positions[i * 3 + 1] ?? 0) - lastY);
        air = Math.max(airborneFromTravel(travel, this.radius), lastAir * AIRBORNE_DECAY);
        if (air < AIRBORNE_SNAP) air = 0;
      }
      if (air > 0 || (lastAir ?? 0) > 0) changed = true;
      batch.air[i] = air;
    }
    carried.clear();
    carriedY.clear();
    carriedAir.clear();
    for (let i = 0; i < count * 3; i += 1) {
      const value = positions[i] ?? 0;
      if (batch.positions[i] !== value) changed = true;
      batch.positions[i] = value;
    }
    for (let i = 0; i < count * 4; i += 1) {
      const value = quaternions[i] ?? 0;
      if (batch.quaternions[i] !== value) changed = true;
      batch.quaternions[i] = value;
    }
    batch.count = count;
    if (changed) this.contactDirty = true;
  }

  /** The id of the coin in `slot` from the last `setTransforms`, or undefined past the count. */
  idAt(tier: CoinTierId, slot: number): number | undefined {
    const batch = this.batch(tier);
    return Number.isInteger(slot) && slot >= 0 && slot < batch.count ? batch.ids[slot] : undefined;
  }

  /**
   * Lets `light` cast coin shadows by enabling COIN_SHADOW_LAYER on its shadow camera. The
   * shadow camera then keeps its own layer mask instead of copying the main camera's, so any
   * other layers that should cast must be enabled on it too.
   */
  castShadowsFrom(light: { readonly shadow: LightShadow }): void {
    if (!this.shadowCaster) {
      throw new Error('CoinField.castShadowsFrom: this field was built with castShadow: false');
    }
    light.shadow.camera.layers.enable(COIN_SHADOW_LAYER);
    this.setCastShadows(true);
  }

  /**
   * Turns coin shadow casting on or off at runtime, for quality tiers. While off, the caster
   * is hidden and skips its per-frame upload.
   */
  setCastShadows(enabled: boolean): void {
    if (!this.shadowCaster) {
      if (enabled) {
        throw new Error('CoinField.setCastShadows: this field was built with castShadow: false');
      }
      return;
    }
    this.shadowsEnabled = enabled;
    if (!enabled) {
      this.shadowCaster.count = 0;
      this.shadowCaster.visible = false;
    }
  }

  /**
   * Bakes every tier's embossed face at `resolution` (a power of two, 512 or 1024 in practice).
   * Call once after `renderer.init()`; calling again rebakes, for a quality tier change.
   */
  bake(renderer: WebGPURenderer, resolution = DEFAULT_EMBOSS_RESOLUTION): void {
    if (
      !Number.isInteger(resolution) ||
      resolution < MIN_EMBOSS_RESOLUTION ||
      resolution > MAX_EMBOSS_RESOLUTION ||
      (resolution & (resolution - 1)) !== 0
    ) {
      throw new Error(
        `CoinField.bake: resolution ${resolution} must be a power of two in ${MIN_EMBOSS_RESOLUTION}..${MAX_EMBOSS_RESOLUTION}`,
      );
    }
    for (const batch of this.batches.values()) {
      batch.bake?.dispose();
      batch.bake = bakeCoinEmboss(renderer, COIN_LOOKS[batch.tier].face, resolution);
      batch.material.setEmboss(batch.bake.texture);
    }
  }

  setReducedMotion(reduced: boolean): void {
    this.motion.value = reduced ? 0 : 1;
  }

  /** `viewportHeightCssPx` is the canvas height in CSS pixels, not device pixels. */
  update(camera: PerspectiveCamera, viewportHeightCssPx: number): CoinFieldStats {
    this.object.updateWorldMatrix(true, false);
    camera.updateMatrixWorld();
    projection
      .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      .multiply(this.object.matrixWorld);
    this.frustum.setFromProjectionMatrix(projection, camera.coordinateSystem);
    worldToLocal.copy(this.object.matrixWorld).invert();
    cameraLocal.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(worldToLocal);

    const view = this.view;
    view.cameraX = cameraLocal.x;
    view.cameraY = cameraLocal.y;
    view.cameraZ = cameraLocal.z;
    view.pixelsPerUnitAtUnitDistance = pixelsPerUnit(camera.fov / camera.zoom, viewportHeightCssPx);
    view.frustum = this.frustum;

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
    if (this.shadowCaster && this.shadowsEnabled) this.uploadShadowCaster(this.shadowCaster);
    if (!this.lastContactView.equals(projection)) {
      this.lastContactView.copy(projection);
      this.contactDirty = true;
    }
    if (this.contactDirty) this.uploadContact();
    if (this.contact.count > 0) drawCalls += 1;
    if (total > 0) this.populated = true;
    const stats = this.lastStats;
    stats.near = near;
    stats.far = far;
    stats.culled = total - near - far;
    stats.drawCalls = drawCalls;
    return stats;
  }

  get stats(): CoinFieldStats {
    return this.lastStats;
  }

  mesh(tier: CoinTierId, level: 'near' | 'far'): InstancedMesh {
    return this.batch(tier)[level];
  }

  get shadowCasterMesh(): InstancedMesh | null {
    return this.shadowCaster;
  }

  get contactMesh(): InstancedMesh {
    return this.contact;
  }

  dispose(): void {
    this.contact.geometry.dispose();
    (this.contact.material as MeshBasicNodeMaterial).dispose();
    this.contact.dispose();
    if (this.shadowCaster) {
      this.shadowCaster.geometry.dispose();
      (this.shadowCaster.material as MeshBasicNodeMaterial).dispose();
      this.shadowCaster.dispose();
    }
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
      seedArray[k] = seedOffset + (batch.seeds[index] ?? index);
    }
    mesh.instanceMatrix.clearUpdateRanges();
    mesh.instanceMatrix.addUpdateRange(0, count * 16);
    mesh.instanceMatrix.needsUpdate = true;
    seeds.clearUpdateRanges();
    seeds.addUpdateRange(0, count);
    seeds.needsUpdate = true;
  }

  private uploadShadowCaster(caster: InstancedMesh): void {
    const matrices = caster.instanceMatrix.array as Float32Array;
    let written = 0;
    for (const batch of this.batches.values()) {
      for (let i = 0; i < batch.count; i += 1) {
        writeInstance(matrices, written, batch.positions, batch.quaternions, i, this.radius);
        written += 1;
      }
    }
    caster.count = written;
    caster.visible = written > 0;
    if (written === 0) return;
    caster.instanceMatrix.clearUpdateRanges();
    caster.instanceMatrix.addUpdateRange(0, written * 16);
    caster.instanceMatrix.needsUpdate = true;
  }

  /** Writes a disc for every coin the camera can see that is not mid-air. */
  private uploadContact(): void {
    this.contactDirty = false;
    const contact = this.contact;
    const matrices = contact.instanceMatrix.array as Float32Array;
    const strength = contact.geometry.getAttribute('contactStrength') as InstancedBufferAttribute;
    const strengths = strength.array as Float32Array;
    const halfThickness = FAR_COIN_GEOMETRY.halfThickness;
    let written = 0;
    for (const batch of this.batches.values()) {
      const { lists } = batch;
      for (const [slots, count] of [
        [lists.near, lists.nearCount],
        [lists.far, lists.farCount],
      ] as const) {
        for (let k = 0; k < count; k += 1) {
          const index = slots[k] ?? 0;
          const air = batch.air[index] ?? 0;
          if (air >= CONTACT_HIDDEN) continue;
          writeContact(
            matrices,
            written,
            batch.positions,
            batch.quaternions,
            index,
            this.radius,
            halfThickness,
            air,
          );
          strengths[written] = 1 - air;
          written += 1;
        }
      }
    }
    contact.count = written;
    contact.visible = written > 0;
    if (written === 0) return;
    contact.instanceMatrix.clearUpdateRanges();
    contact.instanceMatrix.addUpdateRange(0, written * 16);
    contact.instanceMatrix.needsUpdate = true;
    strength.clearUpdateRanges();
    strength.addUpdateRange(0, written);
    strength.needsUpdate = true;
  }

  private batch(tier: CoinTierId): TierBatch {
    const batch = this.batches.get(tier);
    if (!batch) throw new Error(`CoinField has no tier "${tier}"`);
    return batch;
  }
}
