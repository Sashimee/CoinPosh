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
  OctahedronGeometry,
  PlaneGeometry,
  PointLight,
  Quaternion,
  Sprite,
  SpriteNodeMaterial,
  Vector3,
  type BufferGeometry,
  type Material,
  type Object3D,
} from 'three/webgpu';
import { rivieraTokens } from '../../../scene/venues/riviera/palette.ts';
import { HEIRLOOM_PRISM, RARITY_COLORS } from '../../palette.ts';
import { rayStyle, type RayStyle, type UnboxPose } from './plan.ts';

/** What sits on the pedestal: the headline reward of the roll. */
export type UnboxHero = 'coins' | 'pearls' | 'keys' | 'tickets' | 'charm' | 'safe' | 'card';

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
const ITEM_SIZE = 0.016;
/** Light levels as irradiance on the crate faces; the venue key alone gives about 3. */
const LIGHT = { rest: 2.2, rumble: 3, rays: 7, burst: 16 } as const;
const LIGHT_RANGE = CRATE_SIZE * 12;
/** The key sits in front of and above the crate, so its faces read rather than its silhouette. */
const LIGHT_OFFSET = CRATE_SIZE * 1.6;
const LIGHT_LIFT = CRATE_SIZE * 1.1;
/** A round bloom-hot flare over the lid at the burst, a crate and a half across at its peak. */
const FLARE_SIZE = CRATE_SIZE * 1.6;
const FLARE_PEAK = 2.6;
/** Where the crate shrinks to as it sinks back into the tray after Collect. */
const FLY_SCALE = 0.55;

interface RaySlot {
  readonly mesh: Mesh;
  readonly tint: Color;
  strength: number;
  readonly angle: number;
}

const HEROES: readonly UnboxHero[] = [
  'coins',
  'pearls',
  'keys',
  'tickets',
  'charm',
  'safe',
  'card',
];

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
  private readonly flareTint = uniform(new Color());
  private readonly flareStrength = uniform(0);
  private readonly heroes = new Map<UnboxHero, BufferGeometry>();
  private readonly rays = new Map<Object3D, RaySlot>();
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
    for (const hero of HEROES) {
      this.heroes.set(hero, this.heroes.get(twinOf(hero)) ?? heroGeometry(hero));
    }

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
    this.heroMaterial = new MeshPhysicalNodeMaterial({ emissiveIntensity: 0.35, clearcoat: 1 });
    this.rayMaterial = this.createRayMaterial();
    this.flareMaterial = this.createFlareMaterial();
    this.flare = new Sprite(this.flareMaterial);
    this.flare.name = 'unbox-flare';
    this.flare.renderOrder = 42;
    this.flare.frustumCulled = false;

    this.light = new PointLight(0xffffff, 0, LIGHT_RANGE, 2);
    this.light.name = 'unbox-light';
    parent.add(this.light);
  }

  hero(hero: UnboxHero): BufferGeometry {
    const geometry = this.heroes.get(hero);
    if (!geometry) throw new Error(`Unbox assets have no geometry for the ${hero} hero`);
    return geometry;
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
    this.item = new Mesh(
      assets.hero(hero),
      hero === 'coins' || hero === 'keys' ? gold : this.tintHero(hero, this.accent),
    );
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
    this.fan.position.y = top;
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
    this.item.rotation.y = pose.itemSpin;
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

  private tintHero(hero: UnboxHero, accent: Color): Material {
    const material = this.assets.heroMaterial;
    const color = hero === 'pearls' ? new Color(rivieraTokens.ivory) : accent;
    material.color.copy(color);
    material.emissive.copy(color);
    material.roughness = hero === 'pearls' ? 0.15 : 0.25;
    return material;
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

/** Heroes drawn with the same shape share one geometry. */
function twinOf(hero: UnboxHero): UnboxHero {
  if (hero === 'tickets') return 'coins';
  if (hero === 'safe') return 'keys';
  return hero;
}

function heroGeometry(hero: UnboxHero): BufferGeometry {
  switch (hero) {
    case 'coins':
    case 'tickets':
      return new CylinderGeometry(ITEM_SIZE, ITEM_SIZE, ITEM_SIZE * 0.2, 32).rotateX(Math.PI / 2);
    case 'pearls':
      return new OctahedronGeometry(ITEM_SIZE * 0.8, 3);
    case 'keys':
    case 'safe':
      return new BoxGeometry(ITEM_SIZE * 1.4, ITEM_SIZE * 1.4, ITEM_SIZE * 1.4);
    case 'card':
      return new BoxGeometry(ITEM_SIZE * 1.3, ITEM_SIZE * 1.8, ITEM_SIZE * 0.08);
    case 'charm':
      return new OctahedronGeometry(ITEM_SIZE, 0);
  }
}
