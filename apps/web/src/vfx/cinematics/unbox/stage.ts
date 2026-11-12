import type { Rarity } from '@coinposh/shared';
import { abs, dot, exp, float, uniform, uv, vec4 } from 'three/tsl';
import {
  AdditiveBlending,
  BoxGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  MeshPhysicalNodeMaterial,
  PlaneGeometry,
  PointLight,
  Quaternion,
  Sprite,
  SpriteNodeMaterial,
  Vector3,
  WebGPURenderer,
  type BufferGeometry,
  type Camera,
  type Material,
  type Object3D,
} from 'three/webgpu';
import { bakeCoinEmboss, type CoinEmbossBake } from '../../../scene/coins/emboss.ts';
import { flatEmbossTexture } from '../../../scene/coins/materials.ts';
import { COIN_LOOKS, type CoinTierId } from '../../../scene/coins/tiers.ts';
import { rivieraTokens } from '../../../scene/venues/riviera/palette.ts';
import { HEIRLOOM_PRISM, RARITY_COLORS } from '../../palette.ts';
import {
  createHeroMaterial,
  HERO_FACE_RESOLUTION,
  HERO_FACE_TIERS,
  heroGeometry,
  heroYaw,
  ITEM_SIZE,
  UNBOX_HEROES,
  type HeroMaterial,
  type UnboxHero,
} from './hero.ts';
import { rayStyle, type RayStyle, type UnboxPose } from './plan.ts';
import { warmUnboxShots } from './shot.ts';

export type { UnboxHero } from './hero.ts';

/** Crate edge in metres: a chunky lacquer box a little wider than two coins. */
export const CRATE_SIZE = 0.042;
/** The lid is this much wider than the body, so its rim reads as a lip. */
export const LID_OVERHANG = 1.04;
const LID_HEIGHT = 0.011;
/**
 * How far the lid blows up, back and down in size as it clears: kept inside the shot's headroom
 * so the burst reads even on a short landscape screen.
 */
const LID_RISE = CRATE_SIZE * 0.5;
const LID_BACK = CRATE_SIZE * 1.3;
const LID_SHRINK = 0.45;
const BAND_INSET = 0.0015;
/** The hop the crate drops in from; small, so the whole crate stays in frame. */
const DROP_HEIGHT = CRATE_SIZE * 0.45;
/**
 * God-rays a few crates long: staged close to the camera, longer ones would sweep the whole
 * frame and the bloom would turn them into haze.
 */
const RAY_LENGTH = CRATE_SIZE * 2.6;
const RAY_WIDTH = CRATE_SIZE * 0.3;
const PEDESTAL_RADIUS = 0.016;
const PEDESTAL_HEIGHT = 0.03;
/** Light levels as irradiance on the crate faces; the venue key alone gives about 3. */
const LIGHT = { rest: 2.2, rumble: 3, rays: 7, burst: 16 } as const;
const LIGHT_RANGE = CRATE_SIZE * 12;
/** The key sits in front of and above the crate, so its faces read rather than its silhouette. */
const LIGHT_OFFSET = CRATE_SIZE * 1.6;
const LIGHT_LIFT = CRATE_SIZE * 1.1;
/** A round bloom-hot flare over the lid at the burst, a crate and a half across at its peak. */
const FLARE_SIZE = CRATE_SIZE * 1.6;
const FLARE_PEAK = 2.6;
/**
 * How far the god-rays slide back from the camera as the pedestal rises, so the hero stands in
 * front of the shaft instead of inside its haze.
 */
const RAY_PARTING = ITEM_SIZE * 1.6;
/**
 * Share of the camera's elevation the hero tips back by, so a coin face or a ticket meets the
 * eye instead of showing its top edge to a camera looking down on the stage.
 */
const HERO_TILT = 0.7;
/** Where the crate shrinks to as it sinks back into the tray after Collect. */
const FLY_SCALE = 0.55;
/**
 * The primer draws each unbox material this far below the table, where every triangle is
 * clipped: the GPU builds the pipelines while nothing can be seen.
 */
const PRIMER_DEPTH = 1_000;

interface RaySlot {
  readonly mesh: Mesh;
  readonly tint: Color;
  strength: number;
  readonly angle: number;
}

/**
 * Everything an unbox draws with, built once per table and borrowed by each `UnboxStage`, so no
 * unbox builds a node graph or uploads a buffer mid-cinematic. The point light sits in `parent`
 * from mount on at intensity 0: in three/webgpu the scene's light set is part of every lit
 * material's pipeline key, so adding and removing a light per unbox would recompile the table.
 */
export class UnboxAssets {
  readonly body: BoxGeometry;
  readonly band: BoxGeometry;
  readonly seam: BoxGeometry;
  readonly lid: BoxGeometry;
  readonly clasp: BoxGeometry;
  readonly column: CylinderGeometry;
  readonly cap: CylinderGeometry;
  readonly ray: PlaneGeometry;
  readonly lacquer: MeshPhysicalNodeMaterial;
  readonly gold: MeshPhysicalNodeMaterial;
  readonly velvet: MeshPhysicalNodeMaterial;
  readonly seamMaterial: MeshBasicNodeMaterial;
  readonly heroMaterial: MeshPhysicalNodeMaterial;
  readonly rayMaterial: MeshBasicNodeMaterial;
  readonly flareMaterial: SpriteNodeMaterial;
  /** One flare, lent to whichever stage is playing. */
  readonly flare: Sprite;
  readonly light: PointLight;
  private readonly heroLook: HeroMaterial;
  private readonly flareTint = uniform(new Color());
  private readonly flareStrength = uniform(0);
  private readonly heroes = new Map<UnboxHero, BufferGeometry>();
  private readonly faces = new Map<CoinTierId, CoinEmbossBake>();
  private faceTier: CoinTierId = HERO_FACE_TIERS.common;
  private facesQueued = false;
  private readonly rays = new Map<Object3D, RaySlot>();
  private readonly primer = new Group();
  private primerSlot: RaySlot | null = null;
  private disposed = false;

  constructor(parent: Object3D) {
    const parts = crateGeometry();
    this.body = parts.body;
    this.band = parts.band;
    this.seam = parts.seam;
    this.lid = parts.lid;
    this.clasp = parts.clasp;
    this.column = new CylinderGeometry(PEDESTAL_RADIUS * 0.8, PEDESTAL_RADIUS, PEDESTAL_HEIGHT, 28);
    this.cap = new CylinderGeometry(PEDESTAL_RADIUS * 1.15, PEDESTAL_RADIUS * 1.15, 0.003, 28);
    this.ray = new PlaneGeometry(RAY_WIDTH, RAY_LENGTH);
    this.ray.translate(0, RAY_LENGTH / 2, 0);
    for (const hero of UNBOX_HEROES) this.heroes.set(hero, heroGeometry(hero));

    this.lacquer = new MeshPhysicalNodeMaterial({
      color: rivieraTokens['navy-lacquer'],
      roughness: 0.28,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
    });
    this.gold = new MeshPhysicalNodeMaterial({
      color: rivieraTokens['gold-brushed'],
      metalness: 1,
      roughness: 0.3,
    });
    this.velvet = new MeshPhysicalNodeMaterial({
      color: rivieraTokens['coral-sunset'],
      roughness: 0.9,
      sheen: 1,
      sheenRoughness: 0.4,
      sheenColor: new Color(rivieraTokens.champagne),
    });
    this.seamMaterial = new MeshBasicNodeMaterial({
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    this.heroLook = createHeroMaterial();
    this.heroMaterial = this.heroLook.material;
    this.rayMaterial = this.createRayMaterial();
    this.flareMaterial = this.createFlareMaterial();
    this.flare = new Sprite(this.flareMaterial);
    this.flare.name = 'unbox-flare';
    this.flare.renderOrder = 42;
    this.flare.frustumCulled = false;

    this.light = new PointLight(0xffffff, 0, LIGHT_RANGE, 2);
    this.light.name = 'unbox-light';
    parent.add(this.light);
    this.mountPrimer();
    scheduleIdle(warmUnboxShots);
  }

  /** True while the primer still waits for its first draw of every unbox material. */
  get priming(): boolean {
    return this.primer.parent !== null;
  }

  /**
   * Compiles every unbox pipeline ahead of the first crate, against `scene`'s lights, for hosts
   * that can await it. Without it the primer still compiles them on the table's next frame.
   */
  async warm(
    renderer: {
      compileAsync(object: Object3D, camera: Camera, targetScene?: Object3D | null): Promise<void>;
    },
    camera: Camera,
    scene: Object3D,
  ): Promise<void> {
    if (this.disposed || !this.priming) return;
    await renderer.compileAsync(this.primer, camera, scene);
  }

  hero(hero: UnboxHero): BufferGeometry {
    const geometry = this.heroes.get(hero);
    if (!geometry) throw new Error(`Unbox assets have no geometry for the ${hero} hero`);
    return geometry;
  }

  /**
   * Tints every hero prop's enamel, gem and rim in `accent`, the rolled rarity's colour, and
   * strikes its coins with that rarity's face once the primer has baked it.
   */
  tintHero(accent: Color, rarity: Rarity): void {
    this.heroLook.tint(accent);
    this.faceTier = HERO_FACE_TIERS[rarity];
    this.heroLook.setFace(this.faces.get(this.faceTier)?.texture ?? flatEmbossTexture());
  }

  /** The coin tier whose face the hero's coins wear now. */
  get heroFace(): CoinTierId {
    return this.faceTier;
  }

  /** The rarity colour the hero props are tinted in now. */
  get heroAccent(): Color {
    return this.heroLook.accent;
  }

  /** Tints and lights the burst flare; strength 0 draws nothing. */
  setFlare(color: Color, strength: number): void {
    this.flareTint.value.copy(color);
    this.flareStrength.value = strength;
  }

  /** Points the shared god-ray material at `slot` for its tint and strength. */
  bindRay(slot: RaySlot): void {
    this.rays.set(slot.mesh, slot);
  }

  unbindRay(mesh: Object3D): void {
    this.rays.delete(mesh);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.light.removeFromParent();
    this.light.dispose();
    this.unmountPrimer();
    const geometries = new Set<BufferGeometry>([
      this.body,
      this.band,
      this.seam,
      this.lid,
      this.clasp,
      this.column,
      this.cap,
      this.ray,
      ...this.heroes.values(),
    ]);
    for (const geometry of geometries) geometry.dispose();
    for (const face of this.faces.values()) face.dispose();
    this.faces.clear();
    const materials: Material[] = [
      this.lacquer,
      this.gold,
      this.velvet,
      this.seamMaterial,
      this.heroMaterial,
      this.rayMaterial,
      this.flareMaterial,
    ];
    this.flare.removeFromParent();
    for (const material of materials) material.dispose();
    this.rays.clear();
  }

  /**
   * A three/webgpu material compiles on its first draw, which stalled the first unbox frames
   * behind a blank screen. The primer draws every unbox material once from mount on, out of
   * sight, with the light set the stage will have, then leaves the scene. It hangs under the
   * light, the one object the assets keep in the scene, so mounting adds nothing else there.
   */
  private mountPrimer(): void {
    this.primer.name = 'unbox-primer';
    this.primer.position.y = -PRIMER_DEPTH;
    const ray = new Mesh(this.ray, this.rayMaterial);
    const slot: RaySlot = { mesh: ray, tint: new Color(), strength: 0, angle: 0 };
    this.primerSlot = slot;
    this.bindRay(slot);
    const hero = new Mesh(this.hero('card'), this.heroMaterial);
    hero.onBeforeRender = (renderer) => {
      if (!(renderer instanceof WebGPURenderer))
        throw new Error('The unbox primer was drawn by a renderer that cannot bake coin faces');
      this.queueFaceBakes(renderer);
    };
    const parts: Object3D[] = [
      new Mesh(this.body, this.lacquer),
      new Mesh(this.band, this.gold),
      new Mesh(this.column, this.velvet),
      new Mesh(this.seam, this.seamMaterial),
      hero,
      ray,
      new Sprite(this.flareMaterial),
    ];
    const waiting = new Set(parts);
    for (const part of parts) {
      part.frustumCulled = false;
      part.onAfterRender = () => {
        waiting.delete(part);
        // Leaves after the draw call returns, so the render list being walked stays intact.
        if (waiting.size === 0) {
          queueMicrotask(() => {
            this.unmountPrimer();
          });
        }
      };
    }
    this.primer.add(...parts);
    this.light.add(this.primer);
  }

  /**
   * Bakes each rarity's coin face once, the one tinted now first, one per idle slot after the
   * frame that drew the primer: the hero then reads its relief from a texture, as the table
   * coins do, instead of evaluating the face's SDF in every fragment of every prop.
   */
  private queueFaceBakes(renderer: WebGPURenderer): void {
    if (this.facesQueued) return;
    this.facesQueued = true;
    const tiers = new Set<CoinTierId>([this.faceTier, ...Object.values(HERO_FACE_TIERS)]);
    const pending = [...tiers];
    const next = (): void => {
      const tier = pending.shift();
      if (tier === undefined || this.disposed) return;
      const face = bakeCoinEmboss(renderer, COIN_LOOKS[tier].face, HERO_FACE_RESOLUTION);
      this.faces.set(tier, face);
      if (tier === this.faceTier) this.heroLook.setFace(face.texture);
      afterFrame(next);
    };
    afterFrame(next);
  }

  private unmountPrimer(): void {
    if (!this.priming) return;
    this.primer.removeFromParent();
    this.primer.clear();
    if (this.primerSlot) this.unbindRay(this.primerSlot.mesh);
    this.primerSlot = null;
  }

  private createRayMaterial(): MeshBasicNodeMaterial {
    const tint = uniform(new Color()).onObjectUpdate(({ object }) => this.rayOf(object).tint);
    const strength = uniform(0).onObjectUpdate(({ object }) => this.rayOf(object).strength);
    const along = float(1).sub(uv().y);
    const across = float(1).sub(abs(uv().x.mul(2).sub(1)));
    const mask = along.mul(along).mul(across);
    const material = new MeshBasicNodeMaterial();
    material.colorNode = vec4(tint.mul(strength), mask);
    material.transparent = true;
    material.depthWrite = false;
    material.blending = AdditiveBlending;
    material.side = DoubleSide;
    material.fog = false;
    return material;
  }

  /** Round falloff only: no anamorphic streak, so the burst stays a flare over the crate. */
  private createFlareMaterial(): SpriteNodeMaterial {
    const d = uv().mul(2).sub(1);
    const r2 = dot(d, d);
    const mask = exp(r2.mul(-7))
      .sub(exp(float(-7)))
      .max(0);
    const material = new SpriteNodeMaterial();
    material.colorNode = vec4(this.flareTint.mul(this.flareStrength), mask);
    material.transparent = true;
    material.depthWrite = false;
    material.depthTest = false;
    material.blending = AdditiveBlending;
    material.fog = false;
    return material;
  }

  private rayOf(object: Object3D | null): RaySlot {
    const slot = object === null ? undefined : this.rays.get(object);
    if (!slot)
      throw new Error('Unbox god-ray material drawn on a mesh that is not one of its rays');
    return slot;
  }
}

/**
 * The 3D props of one unbox: a navy-lacquer crate with gold bands, a seam that glows in the
 * rarity colour, a fan of additive god-rays, a round burst flare, a velvet pedestal and the
 * item. `apply` poses all of it from an `UnboxPose`; nothing here keeps time of its own.
 * Geometry, materials, the flare and the light are borrowed from `UnboxAssets`, which one stage
 * at a time may use. `face` turns the crate corner on to the camera and puts the key in front.
 */
export class UnboxStage {
  readonly root = new Group();
  readonly rarity: Rarity;
  readonly style: RayStyle;
  private readonly assets: UnboxAssets;
  private readonly rig: CrateRig;
  private readonly crate: Group;
  private readonly lid: Group;
  private readonly seam: Mesh;
  private readonly fan = new Group();
  private readonly rays: RaySlot[] = [];
  private readonly pedestal = new Group();
  private readonly item: Mesh;
  private readonly accent: Color;
  private readonly warm = new Color(rivieraTokens.champagne);
  private readonly toCamera = new Vector3(0, 0, 1);
  private restYaw = 0;
  private flareStrength = 0;
  private swirl = 0;
  private disposed = false;

  constructor(rarity: Rarity, hero: UnboxHero, assets: UnboxAssets) {
    this.rarity = rarity;
    this.style = rayStyle(rarity);
    this.assets = assets;
    this.root.name = 'unbox';
    this.accent = new Color(rarity === 'heirloom' ? HEIRLOOM_PRISM[0] : RARITY_COLORS[rarity]);
    const { lacquer, gold, velvet } = assets;
    assets.seamMaterial.color.copy(this.accent);

    const bodyHeight = CRATE_SIZE - LID_HEIGHT;
    const rig = buildCrate(assets, { lacquer, gold, seam: assets.seamMaterial });
    this.rig = rig;
    this.crate = rig.crate;
    this.lid = rig.lid;
    this.seam = rig.seam;

    const column = new Mesh(assets.column, velvet);
    column.position.y = PEDESTAL_HEIGHT / 2;
    const cap = new Mesh(assets.cap, gold);
    cap.position.y = PEDESTAL_HEIGHT;
    assets.tintHero(this.accent, rarity);
    this.item = new Mesh(assets.hero(hero), assets.heroMaterial);
    this.item.name = `unbox-hero-${hero}`;
    this.item.rotation.order = 'YXZ';
    this.item.position.y = PEDESTAL_HEIGHT + ITEM_SIZE;
    this.pedestal.add(column, cap, this.item);

    const { count, spread, colors } = this.style;
    for (let i = 0; i < count; i++) {
      const across = count === 1 ? 0 : i / (count - 1) - 0.5;
      const mesh = new Mesh(assets.ray, assets.rayMaterial);
      mesh.renderOrder = 41;
      mesh.frustumCulled = false;
      const slot: RaySlot = {
        mesh,
        tint: new Color(colors[i % colors.length] ?? RARITY_COLORS[rarity]),
        strength: 0,
        angle: across * spread * 2,
      };
      this.rays.push(slot);
      assets.bindRay(slot);
      this.fan.add(mesh);
    }
    this.fan.position.y = bodyHeight;

    assets.setFlare(this.accent, 0);
    assets.flare.scale.setScalar(FLARE_SIZE);
    assets.light.color.copy(this.warm);
    assets.light.intensity = 0;
    this.root.add(this.crate, this.pedestal, this.fan, assets.flare);
  }

  get rayCount(): number {
    return this.rays.length;
  }

  /** Total god-ray brightness on screen, for tests and the frame budget. */
  get rayStrength(): number {
    return this.rays.reduce((sum, ray) => sum + ray.strength, 0);
  }

  get lightIntensity(): number {
    return this.disposed ? 0 : this.assets.light.intensity;
  }

  get lidHeight(): number {
    return this.lid.position.y;
  }

  get lidVisible(): boolean {
    return this.lid.visible;
  }

  get crateScaleY(): number {
    return this.crate.scale.y;
  }

  get pedestalScale(): number {
    return this.pedestal.scale.y;
  }

  /** The crate body and its lid, for framing checks. */
  get crateObject(): Object3D {
    return this.crate;
  }

  /** The prop on the pedestal, for framing and luminance checks. */
  get heroObject(): Object3D {
    return this.item;
  }

  /** Scale over the flare's rest size times its strength: 0 while no burst is on screen. */
  get flareLevel(): number {
    return this.disposed ? 0 : this.flareStrength;
  }

  /** Rests the crate at `yaw` and keys it from `toCamera`, a direction in the parent's space. */
  face(yaw: number, toCamera: Vector3): void {
    this.restYaw = yaw;
    this.toCamera.copy(toCamera).normalize();
  }

  /** Poses every prop; `dt` only advances the god-rays' sway. */
  apply(pose: UnboxPose, dt = 0): void {
    if (this.disposed) return;
    const bodyHeight = CRATE_SIZE - LID_HEIGHT;
    this.root.rotation.y = this.restYaw + pose.spin;
    const shrink = 1 - (1 - FLY_SCALE) * pose.fly;
    this.root.scale.setScalar(shrink);
    const facing = Math.atan2(this.toCamera.x, this.toCamera.z);
    poseCrate(this.rig, pose, facing - this.root.rotation.y);

    const seamGlow = Math.max(0.22 * pose.drop, pose.rumble * 0.6, pose.rays) * (1 - pose.lidOpen);
    this.assets.seamMaterial.opacity = Math.min(1, seamGlow);
    this.seam.visible = seamGlow > 0.001;

    const top = this.crate.position.y + bodyHeight * pose.squash;
    this.swirl += Math.max(0, dt) * this.style.swirl;
    const view = facing - this.root.rotation.y;
    const parting = RAY_PARTING * Math.min(1, Math.max(0, pose.pedestal));
    this.fan.position.set(-Math.sin(view) * parting, top, -Math.cos(view) * parting);
    this.fan.rotation.set(0, facing - this.root.rotation.y, Math.sin(this.swirl * 2.4) * 0.18);
    const reach = Math.max(0.05, pose.rayReach);
    for (const ray of this.rays) {
      ray.strength = pose.rays * this.style.intensity;
      ray.mesh.visible = ray.strength > 0.001;
      ray.mesh.rotation.set(0, 0, ray.angle);
      ray.mesh.scale.set(1 + pose.burst * 0.8, reach, 1);
    }

    const flare = this.assets.flare;
    flare.position.set(0, top + LID_HEIGHT, 0);
    flare.scale.setScalar(FLARE_SIZE * Math.max(0.001, pose.flareScale));
    this.flareStrength = FLARE_PEAK * pose.burst;
    this.assets.setFlare(this.accent, this.flareStrength);

    const rise = Math.max(0, pose.pedestal);
    this.pedestal.visible = rise > 0.001 && pose.fly < 1;
    this.pedestal.scale.setScalar(Math.max(0.001, rise));
    this.pedestal.position.y = this.crate.position.y + bodyHeight * (1 - Math.min(1, rise)) * 0.5;
    this.item.rotation.set(
      -HERO_TILT * Math.asin(Math.max(-1, Math.min(1, this.toCamera.y))),
      view + heroYaw(pose.itemSpin),
      0,
    );
    this.item.scale.setScalar(1 - pose.fly);

    const glow = Math.max(pose.burst, pose.rays, pose.rumble * 0.5);
    const irradiance =
      Math.max(
        LIGHT.rest,
        LIGHT.rumble * pose.rumble,
        LIGHT.rays * pose.rays,
        LIGHT.burst * pose.burst,
      ) *
      (1 - pose.fly);
    const light = this.assets.light;
    light.position.copy(this.root.position);
    light.position.addScaledVector(this.toCamera, LIGHT_OFFSET);
    light.position.y += LIGHT_LIFT;
    light.color.copy(this.warm).lerp(this.accent, Math.min(1, glow));
    light.intensity = irradiance * LIGHT_OFFSET * LIGHT_OFFSET;
  }

  /** Takes the props off the table and darkens the light; the borrowed assets stay alive. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.removeFromParent();
    this.assets.flare.removeFromParent();
    this.assets.setFlare(this.accent, 0);
    for (const ray of this.rays) this.assets.unbindRay(ray.mesh);
    this.assets.light.intensity = 0;
  }
}

/** One crate's body, band, seam and lid; the lid group sits in the crate group. */
export interface CrateRig {
  readonly crate: Group;
  readonly lid: Group;
  readonly seam: Mesh;
}

export interface CrateGeometry {
  readonly body: BoxGeometry;
  readonly band: BoxGeometry;
  readonly seam: BoxGeometry;
  readonly lid: BoxGeometry;
  readonly clasp: BoxGeometry;
}

export function crateGeometry(): CrateGeometry {
  const bodyHeight = CRATE_SIZE - LID_HEIGHT;
  return {
    body: new BoxGeometry(CRATE_SIZE, bodyHeight, CRATE_SIZE),
    band: new BoxGeometry(CRATE_SIZE + BAND_INSET, bodyHeight * 0.18, CRATE_SIZE + BAND_INSET),
    seam: new BoxGeometry(CRATE_SIZE * 1.01, 0.0018, CRATE_SIZE * 1.01),
    lid: new BoxGeometry(CRATE_SIZE * LID_OVERHANG, LID_HEIGHT, CRATE_SIZE * LID_OVERHANG),
    clasp: new BoxGeometry(CRATE_SIZE * 0.3, LID_HEIGHT * 0.5, 0.002),
  };
}

/** Assembles the crate from `parts`; the shot's fit builds an undrawn one to measure the stage. */
export function buildCrate(
  parts: CrateGeometry,
  materials: { readonly lacquer: Material; readonly gold: Material; readonly seam: Material },
): CrateRig {
  const bodyHeight = CRATE_SIZE - LID_HEIGHT;
  const crate = new Group();
  const lid = new Group();
  const body = new Mesh(parts.body, materials.lacquer);
  body.name = 'unbox-body';
  body.position.y = bodyHeight / 2;
  const band = new Mesh(parts.band, materials.gold);
  band.position.y = bodyHeight * 0.5;
  const seam = new Mesh(parts.seam, materials.seam);
  seam.position.y = bodyHeight;
  const lidMesh = new Mesh(parts.lid, materials.lacquer);
  lidMesh.position.y = LID_HEIGHT / 2;
  const clasp = new Mesh(parts.clasp, materials.gold);
  clasp.position.set(0, 0, CRATE_SIZE * 0.52);
  lid.add(lidMesh, clasp);
  lid.position.y = bodyHeight;
  crate.add(body, band, seam, lid);
  return { crate, lid, seam };
}

/**
 * Hops, squashes and opens the crate for `pose`. `view` is the camera's bearing in the crate's
 * parent space, less the parent's yaw. The seam's visibility follows its glow in `UnboxStage`.
 */
export function poseCrate(rig: CrateRig, pose: UnboxPose, view: number): void {
  const { crate, lid } = rig;
  const bodyHeight = CRATE_SIZE - LID_HEIGHT;
  crate.position.y = (1 - pose.drop) * DROP_HEIGHT;
  const widen = 1 + (1 - pose.squash) * 0.6;
  crate.scale.set(widen, pose.squash, widen);
  crate.visible = pose.fly < 1;
  awayFromCamera.set(-Math.sin(view), 0, -Math.cos(view));
  lid.position.set(0, bodyHeight + pose.lidLift + pose.lidOpen * LID_RISE, 0);
  lid.position.addScaledVector(awayFromCamera, pose.lidOpen * LID_BACK);
  lid.scale.setScalar(1 - LID_SHRINK * pose.lidOpen);
  hinge.set(-awayFromCamera.z, 0, awayFromCamera.x);
  lid.quaternion
    .setFromAxisAngle(hinge, -pose.lidOpen * 1.9)
    .multiply(shake.setFromAxisAngle(forwardAxis, pose.lidShake));
  lid.visible = pose.lidOpen < 1;
}

/** The lid flips off away from the camera, whatever the crate's spin, so it never leaves frame. */
const awayFromCamera = new Vector3();
const hinge = new Vector3();
const forwardAxis = new Vector3(0, 0, 1);
const shake = new Quaternion();

/**
 * Runs `task` once the frame being drawn has finished, when the main thread is idle where the
 * host can say so: never inside a render, where a bake would swap the render target.
 */
function afterFrame(task: () => void): void {
  if (typeof globalThis.requestIdleCallback === 'function') globalThis.requestIdleCallback(task);
  else setTimeout(task, 0);
}

/** Runs `task` when the main thread is idle where the host can say so, otherwise now. */
function scheduleIdle(task: () => void): void {
  if (typeof globalThis.requestIdleCallback === 'function') globalThis.requestIdleCallback(task);
  else task();
}
