import {
  PRIZE_FAMILIES,
  PRIZE_RARITIES,
  type PrizeFamily,
  type PrizeRarity,
} from '@coinposh/shared';
import { float, smoothstep, uv } from 'three/tsl';
import {
  Box3,
  type BufferGeometry,
  Group,
  type Material,
  Mesh,
  MeshBasicNodeMaterial,
  type Object3D,
  PlaneGeometry,
  Vector3,
} from 'three/webgpu';
import type { QualityTier } from '../quality/tiers.ts';
import { PRIZE_DIMENSIONS, PRIZE_LOOKS, isPrizeFamily, isPrizeRarity } from './looks.ts';
import {
  GLINT_PARKED,
  type PrizeMaterials,
  type PrizeUniforms,
  createPrizeMaterials,
  createPrizeUniforms,
  disposePrizeMaterials,
} from './materials.ts';
import {
  MODEL_DETAIL,
  type PrizeGeometry,
  buildPrizeGeometry,
  disposePrizeGeometry,
} from './models.ts';

export { PRIZE_DIMENSIONS, PRIZE_LOOKS, isPrizeFamily, isPrizeRarity };
export type { PrizeLook } from './looks.ts';
export { GLINT_PARKED, createPrizeMaterials, createPrizeUniforms } from './materials.ts';
export type { PrizeMaterials, PrizeUniforms } from './materials.ts';
export { MODEL_DETAIL, buildPrizeGeometry } from './models.ts';
export type { PrizeGeometry } from './models.ts';

/** Seconds the reveal highlight takes to sweep a prize, and the reduced-motion flash instead. */
export const PRIZE_GLINT_SECONDS = 1.1;
export const PRIZE_REDUCED_GLINT_SECONDS = 1.2;
const GLINT_FROM = -1.7;
const GLINT_TO = 1.7;
/** The seconds hand starts half a minute in, so a still frame shows the classic 10:10:30. */
const SECONDS_START = 30;
const CONTACT_REACH = 1.3;
const CONTACT_OPACITY = 0.55;

export interface PrizeKitOptions {
  readonly quality: QualityTier;
  readonly castShadow?: boolean;
  readonly receiveShadow?: boolean;
}

export interface PrizeViewOptions {
  readonly rarity: PrizeRarity;
  readonly reducedMotion?: boolean;
}

/**
 * One prize on the table. `object3d` is centred on the prize's bounding box, so a physics body
 * of `halfExtents` placed at the same transform fits it.
 */
export interface PrizeView {
  readonly family: PrizeFamily;
  readonly rarity: PrizeRarity;
  readonly object3d: Group;
  readonly halfExtents: Vector3;
  readonly drawCalls: number;
  /** The view's own GPU knobs; `update` drives them, tests and tools may read them. */
  readonly uniforms: PrizeUniforms;
  /** Advances the seconds hand and any running glint. Allocation-free. */
  update(deltaSeconds: number): void;
  /** Sweeps the reveal highlight across the prize (a soft accent flash under reduced motion). */
  glint(): void;
  setReducedMotion(reduced: boolean): void;
  dispose(): void;
}

/** Out-of-sight meshes drawing every program the kit can use; see `PrizeKit.warmParts`. */
export interface PrizeWarmBatch {
  readonly parts: readonly Object3D[];
  release(): void;
}

export interface PrizeKit {
  readonly quality: QualityTier;
  create(family: PrizeFamily, options: PrizeViewOptions): PrizeView;
  /**
   * One mesh per shader program a prize can draw with, for a warm-up to draw out of sight
   * before the first prize drops: linking them on the drop frame would stall it.
   */
  warmParts(): PrizeWarmBatch;
  dispose(): void;
}

/** Remaining time over total for a glint `age` seconds old, or null once it is over. */
export function prizeGlintAt(age: number, reduced: boolean): number | null {
  const total = reduced ? PRIZE_REDUCED_GLINT_SECONDS : PRIZE_GLINT_SECONDS;
  if (age < 0 || age >= total) return null;
  return age / total;
}

function createContactMaterial(): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial({
    name: 'prize/contact',
    color: 0x000000,
    transparent: true,
    depthWrite: false,
  });
  const d = uv().sub(0.5).length().mul(2);
  material.opacityNode = float(1)
    .sub(smoothstep(0.1, 1, d))
    .pow(1.6)
    .mul(CONTACT_OPACITY);
  return material;
}

interface Cached {
  readonly geometry: PrizeGeometry;
  readonly bounds: Box3;
}

class Kit implements PrizeKit {
  readonly quality: QualityTier;
  private readonly cache = new Map<string, Cached>();
  private readonly contactGeometry = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  private readonly contactMaterial = createContactMaterial();
  private readonly castShadow: boolean;
  private readonly receiveShadow: boolean;
  private disposed = false;

  constructor(options: PrizeKitOptions) {
    this.quality = options.quality;
    this.castShadow = options.castShadow ?? true;
    this.receiveShadow = options.receiveShadow ?? true;
  }

  private geometry(family: PrizeFamily, rarity: PrizeRarity): Cached {
    const key = `${family}:${rarity}`;
    let cached = this.cache.get(key);
    if (!cached) {
      const geometry = buildPrizeGeometry(family, PRIZE_LOOKS[rarity], MODEL_DETAIL[this.quality]);
      const bounds = new Box3();
      for (const part of [geometry.metal, geometry.glass, geometry.scent, geometry.leather]) {
        if (!part) continue;
        part.computeBoundingBox();
        if (part.boundingBox) bounds.union(part.boundingBox);
      }
      cached = { geometry, bounds };
      this.cache.set(key, cached);
    }
    return cached;
  }

  create(family: PrizeFamily, options: PrizeViewOptions): PrizeView {
    if (this.disposed) throw new Error('Prize kit was disposed: create a new kit to draw prizes');
    if (!isPrizeFamily(family)) {
      throw new Error(
        `Unknown prize family "${String(family)}": use one of ${PRIZE_FAMILIES.join(', ')}`,
      );
    }
    if (!isPrizeRarity(options.rarity)) {
      throw new Error(
        `Unknown prize rarity "${String(options.rarity)}": use one of ${PRIZE_RARITIES.join(', ')}`,
      );
    }
    const { geometry, bounds } = this.geometry(family, options.rarity);
    const centre = bounds.getCenter(new Vector3());
    const halfExtents = bounds.getSize(new Vector3()).multiplyScalar(0.5);
    const uniforms = createPrizeUniforms(
      PRIZE_LOOKS[options.rarity].accent,
      Math.max(halfExtents.x, halfExtents.y, halfExtents.z),
    );
    const materials = createPrizeMaterials(this.quality, uniforms);
    return new View(family, options.rarity, geometry, centre, halfExtents, uniforms, materials, {
      contactGeometry: this.contactGeometry,
      contactMaterial: this.contactMaterial,
      castShadow: this.castShadow,
      receiveShadow: this.receiveShadow,
      reduced: options.reducedMotion ?? false,
    });
  }

  warmParts(): PrizeWarmBatch {
    const { geometry } = this.geometry('watch', 'common');
    const perfume = this.geometry('perfume', 'common').geometry;
    const uniforms = createPrizeUniforms(PRIZE_LOOKS.common.accent, 0.05);
    const materials = createPrizeMaterials(this.quality, uniforms);
    const parts: Mesh[] = [
      new Mesh(geometry.metal, materials.metal),
      new Mesh(geometry.glass ?? geometry.metal, materials.glass),
      new Mesh(perfume.scent ?? geometry.metal, materials.scent),
      new Mesh(geometry.leather ?? geometry.metal, materials.leather),
      new Mesh(this.contactGeometry, this.contactMaterial),
    ];
    for (const [i, part] of parts.entries()) {
      part.name = `prize-warm-${i}`;
      part.castShadow = i < 4 && this.castShadow;
      part.receiveShadow = i < 4 && this.receiveShadow;
    }
    return {
      parts,
      release() {
        for (const part of parts) part.removeFromParent();
        disposePrizeMaterials(materials);
      },
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const { geometry } of this.cache.values()) disposePrizeGeometry(geometry);
    this.cache.clear();
    this.contactGeometry.dispose();
    this.contactMaterial.dispose();
  }
}

interface ViewShared {
  readonly contactGeometry: PlaneGeometry;
  readonly contactMaterial: Material;
  readonly castShadow: boolean;
  readonly receiveShadow: boolean;
  readonly reduced: boolean;
}

class View implements PrizeView {
  readonly object3d = new Group();
  readonly drawCalls: number;
  private readonly hand: Mesh | null = null;
  private reduced: boolean;
  private clock = SECONDS_START;
  private glintAge = -1;

  constructor(
    readonly family: PrizeFamily,
    readonly rarity: PrizeRarity,
    geometry: PrizeGeometry,
    centre: Vector3,
    readonly halfExtents: Vector3,
    readonly uniforms: PrizeUniforms,
    private readonly materials: PrizeMaterials,
    shared: ViewShared,
  ) {
    this.reduced = shared.reduced;
    this.object3d.name = `prize-${family}-${rarity}`;
    const body = new Group();
    body.position.copy(centre).negate();
    const parts: [BufferGeometry | null, Material, string][] = [
      [geometry.leather, materials.leather, 'leather'],
      [geometry.metal, materials.metal, 'metal'],
      [geometry.scent, materials.scent, 'scent'],
      [geometry.glass, materials.glass, 'glass'],
    ];
    let calls = 0;
    for (const [part, material, name] of parts) {
      if (!part) continue;
      const mesh = new Mesh(part, material);
      mesh.name = `prize-${family}-${name}`;
      mesh.castShadow = shared.castShadow && name !== 'glass';
      mesh.receiveShadow = shared.receiveShadow;
      body.add(mesh);
      calls += 1;
    }
    if (geometry.hand) {
      const hand = new Mesh(geometry.hand, materials.metal);
      hand.name = `prize-${family}-hand`;
      hand.position.set(...geometry.handPivot);
      body.add(hand);
      this.hand = hand;
      calls += 1;
    }
    const contact = new Mesh(shared.contactGeometry, shared.contactMaterial);
    contact.name = `prize-${family}-contact`;
    contact.scale.set(halfExtents.x * 2 * CONTACT_REACH, 1, halfExtents.z * 2 * CONTACT_REACH);
    contact.position.set(0, -halfExtents.y + 0.0003, 0);
    contact.renderOrder = -1;
    this.object3d.add(body, contact);
    this.drawCalls = calls + 1;
    this.poseHand();
  }

  private poseHand(): void {
    if (!this.hand) return;
    const seconds = this.reduced ? SECONDS_START : Math.floor(this.clock);
    this.hand.rotation.y = -(seconds / 60) * Math.PI * 2;
  }

  update(deltaSeconds: number): void {
    this.clock += deltaSeconds;
    this.poseHand();
    if (this.glintAge < 0) return;
    this.glintAge += deltaSeconds;
    const progress = prizeGlintAt(this.glintAge, this.reduced);
    if (progress === null) {
      this.glintAge = -1;
      this.uniforms.glint.value = GLINT_PARKED;
      this.uniforms.flash.value = 0;
      return;
    }
    if (this.reduced) {
      this.uniforms.flash.value = Math.sin(progress * Math.PI);
    } else {
      this.uniforms.glint.value = GLINT_FROM + (GLINT_TO - GLINT_FROM) * progress;
      this.uniforms.flash.value = 0.35 * Math.max(0, 1 - progress * 3);
    }
  }

  glint(): void {
    this.glintAge = 0;
    this.update(0);
  }

  setReducedMotion(reduced: boolean): void {
    this.reduced = reduced;
    this.poseHand();
  }

  dispose(): void {
    this.object3d.removeFromParent();
    disposePrizeMaterials(this.materials);
  }
}

export function createPrizeKit(options: PrizeKitOptions): PrizeKit {
  return new Kit(options);
}
