import type { Rarity } from '@coinposh/shared';
import { abs, float, uniform, uv, vec4 } from 'three/tsl';
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
const LID_HEIGHT = 0.011;
const BAND_INSET = 0.0015;
const DROP_HEIGHT = 0.12;
const RAY_LENGTH = 0.32;
const RAY_WIDTH = 0.016;
const PEDESTAL_RADIUS = 0.016;
const PEDESTAL_HEIGHT = 0.03;
const ITEM_SIZE = 0.016;
const LIGHT_RANGE = 0.6;
const LIGHT_PEAK = 2.4;
const LIGHT_LIFT = CRATE_SIZE * 1.4;

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
  readonly light: PointLight;
  private readonly heroes = new Map<UnboxHero, BufferGeometry>();
  private readonly rays = new Map<Object3D, RaySlot>();
  private disposed = false;

  constructor(parent: Object3D) {
    const bodyHeight = CRATE_SIZE - LID_HEIGHT;
    this.body = new BoxGeometry(CRATE_SIZE, bodyHeight, CRATE_SIZE);
    this.band = new BoxGeometry(
      CRATE_SIZE + BAND_INSET,
      bodyHeight * 0.18,
      CRATE_SIZE + BAND_INSET,
    );
    this.seam = new BoxGeometry(CRATE_SIZE * 1.01, 0.0018, CRATE_SIZE * 1.01);
    this.lid = new BoxGeometry(CRATE_SIZE * 1.04, LID_HEIGHT, CRATE_SIZE * 1.04);
    this.clasp = new BoxGeometry(CRATE_SIZE * 0.3, LID_HEIGHT * 0.5, 0.002);
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

    this.light = new PointLight(0xffffff, 0, LIGHT_RANGE, 2);
    this.light.name = 'unbox-light';
    parent.add(this.light);
  }

  hero(hero: UnboxHero): BufferGeometry {
    const geometry = this.heroes.get(hero);
    if (!geometry) throw new Error(`Unbox assets have no geometry for the ${hero} hero`);
    return geometry;
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
    ];
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

  private rayOf(object: Object3D | null): RaySlot {
    const slot = object === null ? undefined : this.rays.get(object);
    if (!slot)
      throw new Error('Unbox god-ray material drawn on a mesh that is not one of its rays');
    return slot;
  }
}

/**
 * The 3D props of one unbox: a navy-lacquer crate with gold bands, a seam that glows in the
 * rarity colour, a fan of additive god-rays, a velvet pedestal and the item. `apply` poses all
 * of it from an `UnboxPose`; nothing here keeps time of its own. Geometry, materials and the
 * light are borrowed from `UnboxAssets`, which one stage at a time may use.
 */
export class UnboxStage {
  readonly root = new Group();
  readonly rarity: Rarity;
  readonly style: RayStyle;
  private readonly assets: UnboxAssets;
  private readonly crate = new Group();
  private readonly lid = new Group();
  private readonly seam: Mesh;
  private readonly fan = new Group();
  private readonly rays: RaySlot[] = [];
  private readonly pedestal = new Group();
  private readonly item: Mesh;
  private swirl = 0;
  private disposed = false;

  constructor(rarity: Rarity, hero: UnboxHero, assets: UnboxAssets) {
    this.rarity = rarity;
    this.style = rayStyle(rarity);
    this.assets = assets;
    this.root.name = 'unbox';
    const accent = new Color(rarity === 'heirloom' ? HEIRLOOM_PRISM[0] : RARITY_COLORS[rarity]);
    const { lacquer, gold, velvet } = assets;
    assets.seamMaterial.color.copy(accent);

    const bodyHeight = CRATE_SIZE - LID_HEIGHT;
    const body = new Mesh(assets.body, lacquer);
    body.position.y = bodyHeight / 2;
    const band = new Mesh(assets.band, gold);
    band.position.y = bodyHeight * 0.5;
    this.seam = new Mesh(assets.seam, assets.seamMaterial);
    this.seam.position.y = bodyHeight;
    const lidMesh = new Mesh(assets.lid, lacquer);
    lidMesh.position.y = LID_HEIGHT / 2;
    const clasp = new Mesh(assets.clasp, gold);
    clasp.position.set(0, 0, CRATE_SIZE * 0.52);
    this.lid.add(lidMesh, clasp);
    this.lid.position.y = bodyHeight;
    this.crate.add(body, band, this.seam, this.lid);

    const column = new Mesh(assets.column, velvet);
    column.position.y = PEDESTAL_HEIGHT / 2;
    const cap = new Mesh(assets.cap, gold);
    cap.position.y = PEDESTAL_HEIGHT;
    this.item = new Mesh(
      assets.hero(hero),
      hero === 'coins' || hero === 'keys' ? gold : this.tintHero(hero, accent),
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

    assets.light.color.copy(accent);
    assets.light.intensity = 0;
    this.root.add(this.crate, this.pedestal, this.fan);
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

  get crateScaleY(): number {
    return this.crate.scale.y;
  }

  get pedestalScale(): number {
    return this.pedestal.scale.y;
  }

  /** Poses every prop; `dt` only advances the heirloom prism's swirl. */
  apply(pose: UnboxPose, dt = 0): void {
    if (this.disposed) return;
    const bodyHeight = CRATE_SIZE - LID_HEIGHT;
    this.crate.position.y = (1 - pose.drop) * DROP_HEIGHT;
    this.crate.scale.set(1 + (1 - pose.squash) * 0.6, pose.squash, 1 + (1 - pose.squash) * 0.6);
    this.crate.visible = pose.fly < 1;

    this.lid.position.y = bodyHeight + pose.lidLift + pose.lidOpen * CRATE_SIZE * 1.6;
    this.lid.position.z = -pose.lidOpen * CRATE_SIZE * 0.9;
    this.lid.rotation.z = pose.lidShake;
    this.lid.rotation.x = -pose.lidOpen * 1.9;
    this.lid.visible = pose.lidOpen < 1;

    const seamGlow = Math.max(pose.rumble * 0.6, pose.rays) * (1 - pose.lidOpen);
    this.assets.seamMaterial.opacity = Math.min(1, seamGlow);
    this.seam.visible = seamGlow > 0.001;

    this.swirl += Math.max(0, dt) * this.style.swirl;
    this.fan.position.y = this.crate.position.y + bodyHeight * pose.squash;
    this.fan.rotation.y = this.swirl;
    const reach = Math.max(0.05, pose.rayReach);
    for (const ray of this.rays) {
      ray.strength = pose.rays * this.style.intensity;
      ray.mesh.visible = ray.strength > 0.001;
      ray.mesh.rotation.set(0, 0, ray.angle);
      ray.mesh.scale.set(1 + pose.burst * 0.8, reach, 1);
    }

    const rise = Math.max(0, pose.pedestal);
    this.pedestal.visible = rise > 0.001 && pose.fly < 1;
    this.pedestal.scale.setScalar(Math.max(0.001, rise));
    this.pedestal.position.y = this.crate.position.y + bodyHeight * (1 - Math.min(1, rise)) * 0.5;
    this.item.rotation.y = pose.itemSpin;
    this.item.scale.setScalar(1 - pose.fly);

    const light = this.assets.light;
    light.position.copy(this.root.position);
    light.position.y += LIGHT_LIFT;
    light.intensity = LIGHT_PEAK * Math.max(pose.burst * 1.6, pose.rays * 0.7, pose.rumble * 0.4);
  }

  /** Takes the props off the table and darkens the light; the borrowed assets stay alive. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.removeFromParent();
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
