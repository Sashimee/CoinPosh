import {
  COIN_TIERS,
  COLLECTIBLE_COIN_VARIANTS,
  type CoinTier,
  type CollectibleCoinVariant,
} from '@coinposh/shared';
import { float, pow, smoothstep, uniform, uv, vec3 } from 'three/tsl';
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
  type Object3D,
  type PerspectiveCamera,
  type Texture,
} from 'three/webgpu';
import { createCoinGeometry, FAR_COIN_GEOMETRY, NEAR_COIN_GEOMETRY } from '../geometry.ts';
import {
  CoinLod,
  DEFAULT_LOD_SETTINGS,
  partitionByLod,
  pixelsPerUnit,
  type LodOutput,
  type LodSettings,
  type LodView,
} from '../lod.ts';
import { COIN_LOOKS } from '../tiers.ts';
import { createBadgeLayer, linearRgb, type BadgeLayer } from './badges.ts';
import { VARIANT_GLYPH_INDEX, VARIANT_LOOKS } from './looks.ts';
import { createVariantCoinMaterial, type VariantCoinMaterial } from './material.ts';

export interface VariantCoinFieldOptions {
  /** Most coins of one tier and variant on the table at once. */
  readonly capacity: number;
  readonly radius?: number;
  readonly lod?: LodSettings;
  /**
   * The tier's baked face, looked up every update: pass `CoinField.faceTexture`, which returns
   * a new texture after each rebake. Without it the coins draw with a flat face.
   */
  readonly faces?: (tier: CoinTier) => Texture | null;
  readonly castShadow?: boolean;
  readonly receiveShadow?: boolean;
}

export interface VariantCoinFieldStats {
  readonly coins: number;
  readonly badges: number;
  readonly drawCalls: number;
}

/** Out-of-sight meshes that draw with every program the field can use; see `warmParts`. */
export interface VariantWarmBatch {
  readonly parts: readonly Object3D[];
  release(): void;
}

/** Seconds a mint glint takes to sweep the face, and the reduced-motion flash in its place. */
export const GLINT_SECONDS = 0.9;
export const REDUCED_GLINT_SECONDS = 1.1;
/** Smallest on-screen badge diameter in CSS pixels; a closer coin gets a bigger badge. */
export const BADGE_MIN_PX = 17;
/** Badge radius over the coin's, on screen, once the coin is big enough to outgrow the floor. */
const BADGE_COIN_SHARE = 0.42;
/** Largest badge radius over the coin's, so a far coin's badge never buries it. */
const BADGE_MAX_SHARE = 0.62;

const CONTACT_REACH = 1.55;
const CONTACT_OPACITY = 0.62;
const CONTACT_LIFT = 0.02;
const SEED_RANGE = 1 << 20;
const SEED_STRIDE = 7919;
const GLINT_PARKED = -2;

interface Batch {
  readonly tier: CoinTier;
  readonly variant: CollectibleCoinVariant;
  readonly positions: Float32Array;
  readonly quaternions: Float32Array;
  readonly ids: Float64Array;
  readonly lodState: Uint8Array;
  readonly lists: LodOutput;
  readonly near: InstancedMesh;
  readonly far: InstancedMesh;
  readonly material: VariantCoinMaterial;
  readonly glints: Map<number, number>;
  emboss: Texture | null;
  count: number;
}

const projection = new Matrix4();
const worldToLocal = new Matrix4();
const cameraLocal = new Vector3();
const right = new Vector3();
const up = new Vector3();
const toward = new Vector3();
const scratch = new Vector3();

function key(tier: CoinTier, variant: CollectibleCoinVariant): string {
  return `${tier}:${variant}`;
}

function instancedGeometry(base: BufferGeometry, capacity: number): BufferGeometry {
  const geometry = new BufferGeometry();
  for (const [name, value] of Object.entries(base.attributes)) geometry.setAttribute(name, value);
  geometry.setIndex(base.getIndex());
  geometry.boundingSphere = base.boundingSphere;
  geometry.boundingBox = base.boundingBox;
  geometry.setAttribute('coinSeed', new InstancedBufferAttribute(new Float32Array(capacity), 1));
  geometry.setAttribute(
    'variantGlint',
    new InstancedBufferAttribute(new Float32Array(capacity * 2).fill(GLINT_PARKED), 2),
  );
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
  target[o + 12] = positions[index * 3] ?? 0;
  target[o + 13] = positions[index * 3 + 1] ?? 0;
  target[o + 14] = positions[index * 3 + 2] ?? 0;
  target[o + 15] = 1;
}

function createContact(capacity: number): InstancedMesh {
  const geometry = new CircleGeometry(CONTACT_REACH, 28);
  geometry.rotateX(-Math.PI / 2);
  const material = new MeshBasicNodeMaterial({
    name: 'coin-variant-contact',
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: 0,
    polygonOffsetUnits: -2,
  });
  const r = uv()
    .sub(0.5)
    .length()
    .mul(2 * CONTACT_REACH);
  material.colorNode = vec3(0, 0, 0);
  material.opacityNode = pow(float(1).sub(smoothstep(0.92, CONTACT_REACH, r)), 1.6).mul(
    CONTACT_OPACITY,
  );
  const mesh = new InstancedMesh(geometry, material, Math.max(capacity, 1));
  mesh.name = 'coin-variant-contact';
  mesh.count = 0;
  mesh.visible = false;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = 1;
  return mesh;
}

/**
 * Glint progress for a coin `age` seconds into its glint: x sweeps -1..1 across the face in
 * full motion, y flashes the coin in place under reduced motion. Null once it has played.
 */
export function glintAt(age: number, reduced: boolean): readonly [number, number] | null {
  if (!(age >= 0)) return null;
  if (reduced) {
    if (age >= REDUCED_GLINT_SECONDS) return null;
    const t = age / REDUCED_GLINT_SECONDS;
    return [GLINT_PARKED, Math.sin(Math.PI * t) ** 2 * 0.7];
  }
  if (age >= GLINT_SECONDS) return null;
  const t = age / GLINT_SECONDS;
  const eased = 1 - (1 - t) ** 3;
  return [eased * 2 - 1, Math.max(0, 1 - t * 3) * 0.35];
}

/**
 * The coins the server minted as a variant (foil, proof, first strike, misprint), drawn apart
 * from the plain `CoinField`: the caller hands each variant coin's transform here instead of
 * there. Two instanced meshes per tier and variant (near and far LOD), where all six tiers of a
 * variant share one shader program, plus one draw call for the contact discs and one for the
 * colourblind badges, whichever variants are on the table.
 */
export class VariantCoinField {
  readonly object = new Group();
  readonly radius: number;
  readonly capacity: number;
  private readonly batches = new Map<string, Batch>();
  private readonly lod: LodSettings;
  private readonly faces: ((tier: CoinTier) => Texture | null) | undefined;
  private readonly motion = uniform(1);
  private readonly frustum = new Frustum();
  private readonly contact: InstancedMesh;
  private readonly badges: BadgeLayer;
  private readonly nearBase: BufferGeometry;
  private readonly farBase: BufferGeometry;
  private readonly view: { -readonly [K in keyof LodView]: LodView[K] } = {
    cameraX: 0,
    cameraY: 0,
    cameraZ: 0,
    pixelsPerUnitAtUnitDistance: 0,
    frustum: null,
  };
  private readonly incoming = new Set<number>();
  private readonly carried = new Map<number, number>();
  private reduced = false;
  private badgesShown = true;
  private clock = 0;
  private lastStats: VariantCoinFieldStats = { coins: 0, badges: 0, drawCalls: 0 };

  constructor(options: VariantCoinFieldOptions) {
    this.radius = options.radius ?? 1;
    if (!(this.radius > 0)) {
      throw new Error(`VariantCoinField radius must be positive, got ${this.radius}`);
    }
    if (!Number.isInteger(options.capacity) || options.capacity < 1) {
      throw new Error(
        `VariantCoinField capacity must be a positive integer, got ${options.capacity}`,
      );
    }
    this.capacity = options.capacity;
    this.lod = options.lod ?? DEFAULT_LOD_SETTINGS;
    this.faces = options.faces;
    this.object.name = 'coin-variants';
    this.nearBase = createCoinGeometry(NEAR_COIN_GEOMETRY);
    this.farBase = createCoinGeometry(FAR_COIN_GEOMETRY);
    const slots = this.capacity;
    for (const variant of COLLECTIBLE_COIN_VARIANTS) {
      for (const tier of COIN_TIERS) {
        const material = createVariantCoinMaterial(variant, this.motion);
        material.setLook(COIN_LOOKS[tier]);
        const near = new InstancedMesh(
          instancedGeometry(this.nearBase, slots),
          material.material,
          slots,
        );
        const far = new InstancedMesh(
          instancedGeometry(this.farBase, slots),
          material.material,
          slots,
        );
        for (const [mesh, level] of [
          [near, 'near'],
          [far, 'far'],
        ] as const) {
          mesh.name = `coin-variant-${tier}-${variant}-${level}`;
          mesh.count = 0;
          mesh.visible = false;
          mesh.frustumCulled = false;
          mesh.castShadow = options.castShadow ?? true;
          mesh.receiveShadow = options.receiveShadow ?? true;
          this.object.add(mesh);
        }
        this.batches.set(key(tier, variant), {
          tier,
          variant,
          positions: new Float32Array(slots * 3),
          quaternions: new Float32Array(slots * 4).map((_, i) => (i % 4 === 3 ? 1 : 0)),
          ids: new Float64Array(slots),
          lodState: new Uint8Array(slots).fill(CoinLod.unset),
          lists: {
            near: new Uint32Array(slots),
            far: new Uint32Array(slots),
            nearCount: 0,
            farCount: 0,
          },
          near,
          far,
          material,
          glints: new Map(),
          emboss: null,
          count: 0,
        });
      }
    }
    const total = slots * this.batches.size;
    this.contact = createContact(total);
    this.badges = createBadgeLayer(total);
    this.object.add(this.contact, this.badges.mesh);
  }

  /**
   * Replaces the coins of one tier and variant: xyz positions, xyzw quaternions and one integer
   * id per coin (the sim's coin id), unique within the set. A coin keeps its LOD level and any
   * glint in flight for as long as its id stays. Throws without changing anything on bad input.
   */
  setTransforms(
    tier: CoinTier,
    variant: CollectibleCoinVariant,
    positions: ArrayLike<number>,
    quaternions: ArrayLike<number>,
    count: number,
    ids: ArrayLike<number>,
  ): void {
    const batch = this.batch(tier, variant);
    const where = `VariantCoinField.setTransforms(${tier}, ${variant})`;
    if (!Number.isInteger(count) || count < 0 || count > this.capacity) {
      throw new Error(`${where}: count ${count} is outside capacity 0..${this.capacity}`);
    }
    if (positions.length < count * 3 || quaternions.length < count * 4 || ids.length < count) {
      throw new Error(
        `${where}: ${count} coins need ${count * 3} position, ${count * 4} quaternion and ${count} id values`,
      );
    }
    const incoming = this.incoming;
    incoming.clear();
    for (let i = 0; i < count; i += 1) {
      const id = ids[i];
      if (id === undefined || !Number.isSafeInteger(id)) {
        throw new Error(`${where}: id at ${i} is ${id}, expected a safe integer coin id`);
      }
      if (incoming.has(id)) throw new Error(`${where}: coin id ${id} appears twice`);
      incoming.add(id);
    }
    const carried = this.carried;
    carried.clear();
    for (let i = 0; i < batch.count; i += 1) {
      carried.set(batch.ids[i] ?? 0, batch.lodState[i] ?? CoinLod.unset);
    }
    for (let i = 0; i < count; i += 1) {
      const id = ids[i] ?? 0;
      batch.ids[i] = id;
      batch.lodState[i] = carried.get(id) ?? CoinLod.unset;
    }
    for (const id of batch.glints.keys()) if (!incoming.has(id)) batch.glints.delete(id);
    for (let i = 0; i < count * 3; i += 1) batch.positions[i] = positions[i] ?? 0;
    for (let i = 0; i < count * 4; i += 1) batch.quaternions[i] = quaternions[i] ?? 0;
    batch.count = count;
    carried.clear();
    incoming.clear();
  }

  count(tier: CoinTier, variant: CollectibleCoinVariant): number {
    return this.batch(tier, variant).count;
  }

  /**
   * Sweeps the mint glint across one coin, from the next `update`: call it when the coin is
   * minted. A coin id not in the set yet glints as soon as it arrives.
   */
  glint(tier: CoinTier, variant: CollectibleCoinVariant, id: number): void {
    if (!Number.isSafeInteger(id)) {
      throw new Error(`VariantCoinField.glint: id ${id} is not a safe integer coin id`);
    }
    this.batch(tier, variant).glints.set(id, this.clock);
  }

  /** Shows or hides the colourblind badges (a setting; on by default). */
  setBadges(shown: boolean): void {
    this.badgesShown = shown;
  }

  setReducedMotion(reduced: boolean): void {
    this.reduced = reduced;
    this.motion.value = reduced ? 0 : 1;
  }

  /**
   * Culls, picks a LOD, advances glints by `deltaSeconds` and uploads. `viewportHeightCssPx`
   * is the canvas height in CSS pixels, which sizes the badges.
   */
  update(
    camera: PerspectiveCamera,
    viewportHeightCssPx: number,
    deltaSeconds = 0,
  ): VariantCoinFieldStats {
    if (Number.isFinite(deltaSeconds) && deltaSeconds > 0) this.clock += deltaSeconds;
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
    const ppu = pixelsPerUnit(camera.fov / camera.zoom, Math.max(viewportHeightCssPx, 1));
    view.pixelsPerUnitAtUnitDistance = ppu;
    view.frustum = this.frustum;

    right.setFromMatrixColumn(camera.matrixWorld, 0).transformDirection(worldToLocal);
    up.setFromMatrixColumn(camera.matrixWorld, 1).transformDirection(worldToLocal);

    let coins = 0;
    let drawCalls = 0;
    let contacts = 0;
    let badges = 0;
    const contactMatrices = this.contact.instanceMatrix.array as Float32Array;
    for (const batch of this.batches.values()) {
      this.syncEmboss(batch);
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
      drawCalls += (batch.lists.nearCount > 0 ? 1 : 0) + (batch.lists.farCount > 0 ? 1 : 0);
      for (const [slots, n] of [
        [batch.lists.near, batch.lists.nearCount],
        [batch.lists.far, batch.lists.farCount],
      ] as const) {
        for (let k = 0; k < n; k += 1) {
          const index = slots[k] ?? 0;
          coins += 1;
          this.writeContact(contactMatrices, contacts, batch, index);
          contacts += 1;
          if (this.badgesShown) {
            this.writeBadge(badges, batch, index, ppu);
            badges += 1;
          }
        }
      }
      for (const [id, start] of batch.glints) {
        if (this.clock - start >= Math.max(GLINT_SECONDS, REDUCED_GLINT_SECONDS) + 1) {
          batch.glints.delete(id);
        }
      }
    }
    this.finish(this.contact, contacts);
    const badgeMesh = this.badges.mesh;
    badgeMesh.count = badges;
    badgeMesh.visible = badges > 0;
    if (badges > 0) {
      for (const attr of [
        this.badges.centres,
        this.badges.sizes,
        this.badges.glyphs,
        this.badges.accents,
      ]) {
        attr.clearUpdateRanges();
        attr.addUpdateRange(0, badges * attr.itemSize);
        attr.needsUpdate = true;
      }
    }
    drawCalls += (contacts > 0 ? 1 : 0) + (badges > 0 ? 1 : 0);
    this.lastStats = { coins, badges, drawCalls };
    return this.lastStats;
  }

  get stats(): VariantCoinFieldStats {
    return this.lastStats;
  }

  mesh(tier: CoinTier, variant: CollectibleCoinVariant, level: 'near' | 'far'): InstancedMesh {
    return this.batch(tier, variant)[level];
  }

  get badgeMesh(): InstancedMesh {
    return this.badges.mesh;
  }

  get contactMesh(): InstancedMesh {
    return this.contact;
  }

  /**
   * One mesh per shader program the field can draw (one coin per variant, its badge and its
   * contact disc), each a single instance at the origin, for a warm-up to draw out of sight
   * after the table turns playable. A variant can first appear on any mint, so linking its
   * program then would stall that mint's frame. `release` frees what the parts hold; the
   * shared materials stay with the field.
   */
  warmParts(): VariantWarmBatch {
    const parts: InstancedMesh[] = [];
    const owned: BufferGeometry[] = [];
    for (const variant of COLLECTIBLE_COIN_VARIANTS) {
      const batch = this.batch('gold', variant);
      this.syncEmboss(batch);
      for (const [base, level] of [
        [this.nearBase, 'near'],
        [this.farBase, 'far'],
      ] as const) {
        const geometry = instancedGeometry(base, 1);
        owned.push(geometry);
        const part = new InstancedMesh(geometry, batch.material.material, 1);
        part.name = `coin-variant-warm-${variant}-${level}`;
        part.castShadow = batch.near.castShadow;
        part.receiveShadow = batch.near.receiveShadow;
        part.setMatrixAt(0, new Matrix4().makeScale(this.radius, this.radius, this.radius));
        parts.push(part);
      }
    }
    const badges = new InstancedMesh(this.badges.mesh.geometry, this.badges.mesh.material, 1);
    badges.name = 'coin-variant-warm-badges';
    badges.renderOrder = this.badges.mesh.renderOrder;
    const contact = new InstancedMesh(this.contact.geometry, this.contact.material, 1);
    contact.name = 'coin-variant-warm-contact';
    parts.push(badges, contact);
    return {
      parts,
      release() {
        for (const part of parts) {
          part.removeFromParent();
          part.dispose();
        }
        for (const geometry of owned) geometry.dispose();
      },
    };
  }

  dispose(): void {
    for (const batch of this.batches.values()) {
      batch.material.material.dispose();
      batch.near.geometry.dispose();
      batch.far.geometry.dispose();
      batch.near.dispose();
      batch.far.dispose();
    }
    this.nearBase.dispose();
    this.farBase.dispose();
    this.contact.geometry.dispose();
    (this.contact.material as MeshBasicNodeMaterial).dispose();
    this.contact.dispose();
    this.badges.dispose();
    this.object.clear();
  }

  private syncEmboss(batch: Batch): void {
    const face = this.faces?.(batch.tier) ?? null;
    if (face && face !== batch.emboss) {
      batch.emboss = face;
      batch.material.setEmboss(face);
    }
  }

  private upload(mesh: InstancedMesh, batch: Batch, slots: Uint32Array, count: number): void {
    mesh.count = count;
    mesh.visible = count > 0;
    if (count === 0) return;
    const matrices = mesh.instanceMatrix.array as Float32Array;
    const seeds = mesh.geometry.getAttribute('coinSeed') as InstancedBufferAttribute;
    const glints = mesh.geometry.getAttribute('variantGlint') as InstancedBufferAttribute;
    const seedArray = seeds.array as Float32Array;
    const glintArray = glints.array as Float32Array;
    const seedOffset = COIN_TIERS.indexOf(batch.tier) * SEED_STRIDE;
    for (let k = 0; k < count; k += 1) {
      const index = slots[k] ?? 0;
      const id = batch.ids[index] ?? 0;
      writeInstance(matrices, k, batch.positions, batch.quaternions, index, this.radius);
      seedArray[k] = seedOffset + (((id % SEED_RANGE) + SEED_RANGE) % SEED_RANGE);
      const start = batch.glints.get(id);
      const glint = start === undefined ? null : glintAt(this.clock - start, this.reduced);
      glintArray[k * 2] = glint ? glint[0] : GLINT_PARKED;
      glintArray[k * 2 + 1] = glint ? glint[1] : 0;
    }
    for (const attr of [mesh.instanceMatrix, seeds, glints]) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, count * attr.itemSize);
      attr.needsUpdate = true;
    }
  }

  private writeContact(target: Float32Array, slot: number, batch: Batch, index: number): void {
    const x = batch.quaternions[index * 4] ?? 0;
    const z = batch.quaternions[index * 4 + 2] ?? 0;
    const upY = Math.abs(1 - 2 * (x * x + z * z));
    const scale = this.radius * upY * upY;
    const o = slot * 16;
    target.fill(0, o, o + 16);
    target[o] = scale;
    target[o + 5] = scale;
    target[o + 10] = scale;
    target[o + 12] = batch.positions[index * 3] ?? 0;
    target[o + 13] =
      (batch.positions[index * 3 + 1] ?? 0) -
      this.radius * (FAR_COIN_GEOMETRY.halfThickness * upY - CONTACT_LIFT);
    target[o + 14] = batch.positions[index * 3 + 2] ?? 0;
    target[o + 15] = 1;
  }

  // Pins the badge to the coin's upper-right rim as seen from the camera and pulls it most of a
  // coin radius towards the eye, so it never sinks into the coin it labels.
  private writeBadge(slot: number, batch: Batch, index: number, ppu: number): void {
    const px = batch.positions[index * 3] ?? 0;
    const py = batch.positions[index * 3 + 1] ?? 0;
    const pz = batch.positions[index * 3 + 2] ?? 0;
    toward.set(this.view.cameraX - px, this.view.cameraY - py, this.view.cameraZ - pz);
    const distance = Math.max(toward.length(), 1e-6);
    toward.divideScalar(distance);
    const r = this.radius;
    scratch
      .set(px, py, pz)
      .addScaledVector(right, r * 0.8)
      .addScaledVector(up, r * 0.55)
      .addScaledVector(toward, r * 0.9);
    const coinPx = (r * ppu) / distance;
    const radiusPx = Math.max(BADGE_MIN_PX / 2, coinPx * BADGE_COIN_SHARE);
    const size = Math.min((radiusPx * distance) / ppu, r * BADGE_MAX_SHARE);
    const centres = this.badges.centres.array as Float32Array;
    centres[slot * 3] = scratch.x;
    centres[slot * 3 + 1] = scratch.y;
    centres[slot * 3 + 2] = scratch.z;
    (this.badges.sizes.array as Float32Array)[slot] = size;
    (this.badges.glyphs.array as Float32Array)[slot] = VARIANT_GLYPH_INDEX[batch.variant];
    const accent = linearRgb(VARIANT_LOOKS[batch.variant].accent);
    const accents = this.badges.accents.array as Float32Array;
    accents[slot * 3] = accent[0];
    accents[slot * 3 + 1] = accent[1];
    accents[slot * 3 + 2] = accent[2];
  }

  private finish(mesh: InstancedMesh, count: number): void {
    mesh.count = count;
    mesh.visible = count > 0;
    if (count === 0) return;
    mesh.instanceMatrix.clearUpdateRanges();
    mesh.instanceMatrix.addUpdateRange(0, count * 16);
    mesh.instanceMatrix.needsUpdate = true;
  }

  private batch(tier: CoinTier, variant: CollectibleCoinVariant): Batch {
    const batch = this.batches.get(key(tier, variant));
    if (!batch) throw new Error(`VariantCoinField has no batch for ${tier} ${variant}`);
    return batch;
  }
}
