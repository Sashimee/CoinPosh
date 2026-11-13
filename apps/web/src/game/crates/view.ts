import type { CrateId, Rarity, Roll, Wallet } from '@coinposh/shared';
import { CRATE_RIDE } from '@coinposh/sim/snapshot';
import { abs, dot, exp, mix, normalLocal, positionLocal, uniform, vec3, vec4 } from 'three/tsl';
import {
  AdditiveBlending,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  MeshPhysicalNodeMaterial,
  Vector3,
  type BufferGeometry,
  type Object3D,
  type PerspectiveCamera,
} from 'three/webgpu';
import type { Bus } from '../../app/bus.ts';
import type { CameraPreset } from '../../scene/venues/riviera/layout.ts';
import { RIVIERA_TABLE } from '../../scene/venues/riviera/layout.ts';
import { mergeAll, roundedBox } from '../../scene/venues/riviera/geometry.ts';
import { rivieraTokens } from '../../scene/venues/riviera/palette.ts';
import { easeInOutCubic, easeInQuad, easeOutCubic, lerp } from '../../vfx/easing.ts';
import type { HapticPattern } from '../../vfx/haptics.ts';
import { HEIRLOOM_PRISM, RARITY_COLORS, VFX_COLORS } from '../../vfx/palette.ts';
import {
  UnboxAssets,
  UnboxCinematic,
  type UnboxAssetsOptions,
  type UnboxBeat,
  type UnboxVfx,
} from '../../vfx/cinematics/unbox/index.ts';
import type { TablePoint } from '../systems/events.ts';
import type { CrateEvents, CrateStingerCue } from './events.ts';
import { heroOf } from './loot.ts';
import type { CrateRide } from './ride.ts';

const ARRIVE_S = 0.36;
const ARRIVE_HEIGHT = 0.09;
const FALL_S = 0.42;
const TRAY_FLOOR_Y = -RIVIERA_TABLE.trayDepth;
const TRAY_Z = RIVIERA_TABLE.fieldFrontZ + 0.035;
const BURST_DUCK_S = 2.2;
/** The ride hands the crate over at about this pitch as it goes over the lip. */
const MAX_FALL_TILT = CRATE_RIDE.maxTilt;

const S = CRATE_RIDE.size;
/** The lid line, where the unbox later splits the crate: the seam glows along it. */
const SEAM_Y = S * 0.74;
const CAP = S * 0.22;
const CAP_PROUD = S * 0.022;
const EDGE = S * 0.055;
const BAND_HEIGHT = S * 0.22;
const BAND_Y = S * 0.4;
const LID_INSET = S * 0.2;
const LID_LINE = S * 0.05;
/** The gold boss in the middle of the lid, inside the glowing ring. */
const MEDALLION = S * 0.17;

/** Seam brightness: a slow breath while it rides, a quick hot pulse while it hangs at the lip. */
const BREATHE_S = 2.4;
const BREATHE_LOW = 0.78;
const TEETER_GLOW = 1.45;
const TEETER_PULSE_S = 0.42;
/** Reduced motion holds the seam lit at one level: no breath, no pulse, no sweep. */
export const STATIC_GLOW = 1;
/**
 * Peak of the seam line: just over the bloom threshold (0.92 to 0.95) even at the bottom of the
 * breath, so the sealed seam keeps a halo from across the table. The seam lines are thin so the
 * halo stays a line instead of washing the crate grey.
 */
const SEAM_PEAK = 1.35;
/**
 * Only the crate's left and right faces pick up a hint of the seam colour, mixed into the navy
 * lift: the face the player looks at stays navy lacquer, wherever the crate sits or tilts. The
 * teeter pulse stays in the seam, so the box does not flare brighter at the lip than on the shelf.
 */
const RIM_GLOW = 0.5;
const RIM_TINT = 0.3;
/** Brushed gold never drops below this self-light, so the trim reads even off the key light. */
const TRIM_FLOOR = 1;
/**
 * The lacquer is self-lit along its own normals rather than by the venue: its venue sheen caught
 * the warm rim light on the back shelf but not on the dim front floor, so the same crate read
 * lighter at the back than where the player pushes it over.
 */
const LACQUER_LIFT = '#1E3A6E';
const LIFT_FLOOR = 0.62;
const LIFT_KEY = 0.38;
const LACQUER_ALBEDO = 0.6;
/**
 * The clearcoat sheen, lit from a key fixed to the crate instead of the venue's lights: a hot
 * line along the lid's front edge and a soft reflected streak across the lid, the same on the
 * back shelf as at the lip, and the same lacquer read the unbox crate has.
 */
const SHEEN_KEY = new Vector3(-0.2, 1, 0.8).normalize();
const SHEEN_POWER = 28;
const SHEEN_PEAK = 0.7;
const STREAK_PEAK = 0.16;
const STREAK_AT = 0.12;
const STREAK_SHARPNESS = 30;
const GLINT_PEAK = 3.2;
/** A glint runs corner to corner right after the crate lands, then again every few seconds. */
const GLINT_DELAY_S = ARRIVE_S;
const GLINT_PERIOD_S = 3.4;
const GLINT_SWEEP_S = 0.7;
/** Sweep position along the crate's diagonal, in crate edges: it starts and ends off the trim. */
const GLINT_FROM = -0.75;
const GLINT_TO = 1.55;
/** Where a parked glint sits: far enough off the diagonal that the trim shows none of it. */
export const GLINT_OFF = 8;
/**
 * Reduced motion trades the sweep for a still highlight: the glint rests on the lid corner nearest
 * the player, at a fraction of its sweep strength so it reads as a sheen rather than a flash.
 */
export const GLINT_REST = 1.15;
export const GLINT_STILL = 0.3;
const GLINT_SHARPNESS = 110;
/** The standby crate is drawn this small, under the tray floor: there for the shader, not seen. */
const STANDBY_SCALE = 1e-3;

/** Where a crate that went over at `x` comes to rest in the catch tray. */
export function trayLanding(x: number): Vector3 {
  return new Vector3(x * 0.6, TRAY_FLOOR_Y, TRAY_Z);
}

/**
 * The seam colour of a crate. Before the server rolls it the crate is sealed and glows white
 * gold; once rolled it glows the colour its unbox accent and god-rays use.
 */
export function seamColor(rarity: Rarity | null): string {
  if (rarity === null) return VFX_COLORS.whiteGold;
  return rarity === 'heirloom' ? HEIRLOOM_PRISM[0] : RARITY_COLORS[rarity];
}

export interface CrateShine {
  /** Seam and rim brightness, 1 at rest. */
  readonly glow: number;
  /** Glint sweep position along the crate diagonal, in crate edges; `GLINT_OFF` when parked. */
  readonly sweep: number;
  /** Glint strength: 1 for the sweep, `GLINT_STILL` for the reduced-motion highlight. */
  readonly glint: number;
}

/** How a crate shines `age` seconds after it spawned. */
export function crateShine(age: number, teeter: boolean, reducedMotion: boolean): CrateShine {
  if (reducedMotion) return { glow: STATIC_GLOW, sweep: GLINT_REST, glint: GLINT_STILL };
  const t = Math.max(0, age);
  const glow = teeter
    ? TEETER_GLOW + 0.25 * Math.sin((t / TEETER_PULSE_S) * Math.PI * 2)
    : lerp(BREATHE_LOW, 1, 0.5 + 0.5 * Math.sin((t / BREATHE_S) * Math.PI * 2));
  const since = t - GLINT_DELAY_S;
  const cycle = since % GLINT_PERIOD_S;
  const sweep =
    since < 0 || cycle >= GLINT_SWEEP_S
      ? GLINT_OFF
      : lerp(GLINT_FROM, GLINT_TO, easeInOutCubic(cycle / GLINT_SWEEP_S));
  return { glow, sweep, glint: 1 };
}

interface CrateLook {
  readonly seam: Color;
  glow: number;
  sweep: number;
  glint: number;
}

interface TableCrate {
  readonly root: Group;
  readonly look: CrateLook;
  arrive: number;
  age: number;
  fall: { from: Vector3; to: Vector3; t: number; spin: number } | null;
}

/**
 * The gold frame: corner caps, edge rails, a wide band, a lock plate on the player's face and a
 * boss on the lid.
 */
function trimGeometry(): BufferGeometry {
  const pieces: BufferGeometry[] = [];
  const out = S / 2 - CAP / 2 + CAP_PROUD;
  const corners = [-1, 1] as const;
  for (const x of corners) {
    for (const z of corners) {
      for (const y of [CAP / 2, S - CAP / 2 + CAP_PROUD]) {
        pieces.push(
          roundedBox(new Vector3(CAP, CAP, CAP), new Vector3(x * out, y, z * out), CAP * 0.24, 2),
        );
      }
      const rail = S / 2 - EDGE / 2 + CAP_PROUD * 0.6;
      pieces.push(
        roundedBox(
          new Vector3(EDGE, S - CAP * 2, EDGE),
          new Vector3(x * rail, S / 2, z * rail),
          EDGE * 0.4,
          2,
        ),
      );
    }
  }
  const top = S - EDGE / 2 + CAP_PROUD * 0.4;
  const topEdge = S / 2 - EDGE / 2 + CAP_PROUD * 0.4;
  const span = S - CAP * 2;
  for (const side of corners) {
    pieces.push(
      roundedBox(new Vector3(span, EDGE, EDGE), new Vector3(0, top, side * topEdge), EDGE * 0.4, 2),
      roundedBox(new Vector3(EDGE, EDGE, span), new Vector3(side * topEdge, top, 0), EDGE * 0.4, 2),
    );
  }
  pieces.push(
    roundedBox(
      new Vector3(S * 1.03, BAND_HEIGHT, S * 1.03),
      new Vector3(0, BAND_Y, 0),
      S * 0.03,
      2,
    ),
    roundedBox(
      new Vector3(S * 0.26, S * 0.3, S * 0.05),
      new Vector3(0, BAND_Y + S * 0.04, S * 0.52),
      S * 0.04,
      2,
    ),
  );
  const medallion = new CylinderGeometry(MEDALLION, MEDALLION, S * 0.03, 24);
  medallion.translate(0, S + S * 0.005, 0);
  pieces.push(medallion);
  return mergeAll(pieces, 'crate-trim');
}

/**
 * The glowing lines: a ring round the lid line on the sides, and an inset ring on the lid that
 * the table camera, looking down on the crate, sees first.
 */
function seamGeometry(): BufferGeometry {
  const inset = S / 2 - LID_INSET;
  const long = S - LID_INSET * 2 + LID_LINE;
  const y = S + LID_LINE / 4;
  const pieces = [
    roundedBox(
      new Vector3(S * 1.016, S * 0.045, S * 1.016),
      new Vector3(0, SEAM_Y, 0),
      S * 0.02,
      1,
    ),
  ];
  for (const side of [-1, 1]) {
    pieces.push(
      roundedBox(
        new Vector3(long, LID_LINE / 2, LID_LINE),
        new Vector3(0, y, side * inset),
        LID_LINE * 0.2,
        1,
      ),
      roundedBox(
        new Vector3(LID_LINE, LID_LINE / 2, long),
        new Vector3(side * inset, y, 0),
        LID_LINE * 0.2,
        1,
      ),
    );
  }
  return mergeAll(pieces, 'crate-seam');
}

/**
 * The crates on the table: a bevelled lacquer vault per crate, framed in brushed gold, with a
 * seam that glows the crate's colour (sealed white gold until the server rolls it) and a glint
 * that sweeps the trim every few seconds. Each drops in from the chute with a squash, rides and
 * tips with its `CrateRide`, then tumbles into the catch tray and waits there for its unbox.
 *
 * Every crate shares one geometry and material set, and the per-crate colour and shine reach the
 * shaders as per-object uniforms, so no crate ever adds a program. A standby crate, drawn
 * sub-pixel under the tray floor from construction until the first real one spawns, has those
 * programs (and their shadow variants) linked in the boot frame instead of on the first drop.
 */
export class TableCrateView {
  private readonly parent: Object3D;
  private readonly crates = new Map<CrateId, TableCrate>();
  private readonly looks = new Map<Object3D, CrateLook>();
  private readonly body = roundedBox(new Vector3(S, S, S), new Vector3(0, S / 2, 0), S * 0.09, 3);
  private readonly trim = trimGeometry();
  private readonly seam = seamGeometry();
  private readonly lacquer: MeshPhysicalNodeMaterial;
  private readonly gold: MeshPhysicalNodeMaterial;
  private readonly glow: MeshBasicNodeMaterial;
  private standby: Group | null;

  constructor(parent: Object3D) {
    this.parent = parent;
    const tint = uniform(new Color()).onObjectUpdate(({ object }) => this.lookOf(object).seam);
    const glow = uniform(0).onObjectUpdate(({ object }) => this.lookOf(object).glow);
    const sweep = uniform(GLINT_OFF).onObjectUpdate(({ object }) => this.lookOf(object).sweep);
    const strength = uniform(1).onObjectUpdate(({ object }) => this.lookOf(object).glint);

    this.lacquer = new MeshPhysicalNodeMaterial({
      color: new Color(rivieraTokens['navy-lacquer']).multiplyScalar(LACQUER_ALBEDO),
      roughness: 1,
      specularIntensity: 0,
    });
    const navy = uniform(new Color(LACQUER_LIFT));
    const up = normalLocal.y;
    const lift = navy.mul(up.max(0).mul(LIFT_KEY).add(LIFT_FLOOR));
    const rim = mix(navy, tint, RIM_TINT).mul(
      abs(normalLocal.x).mul(glow.min(STATIC_GLOW)).mul(RIM_GLOW),
    );
    const edge = dot(normalLocal, vec3(SHEEN_KEY.x, SHEEN_KEY.y, SHEEN_KEY.z)).max(0);
    const diagonal = positionLocal.x.add(positionLocal.z).div(S).sub(STREAK_AT);
    const streak = exp(diagonal.pow2().mul(-STREAK_SHARPNESS)).mul(up.max(0).pow(8));
    const sheen = edge.pow(SHEEN_POWER).mul(SHEEN_PEAK).add(streak.mul(STREAK_PEAK));
    this.lacquer.emissiveNode = lift
      .add(rim)
      .add(uniform(new Color(rivieraTokens.champagne)).mul(sheen));

    const brushed = new Color(rivieraTokens['gold-brushed']);
    this.gold = new MeshPhysicalNodeMaterial({
      color: brushed,
      metalness: 1,
      roughness: 0.55,
    });
    const along = dot(positionLocal, vec3(1, 1, 1).normalize()).div(S);
    const glint = exp(along.sub(sweep).pow2().mul(-GLINT_SHARPNESS));
    this.gold.emissiveNode = uniform(brushed).mul(
      glint.mul(strength).mul(GLINT_PEAK).add(TRIM_FLOOR),
    );

    this.glow = new MeshBasicNodeMaterial({
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    this.glow.colorNode = vec4(tint.mul(glow).mul(SEAM_PEAK), 1);
    this.glow.fog = false;

    this.standby = this.build('crate:standby', {
      seam: new Color(),
      glow: 0,
      sweep: GLINT_OFF,
      glint: 0,
    });
    this.standby.position.set(0, TRAY_FLOOR_Y - S, TRAY_Z);
    this.standby.scale.setScalar(STANDBY_SCALE);
    for (const child of this.standby.children) child.frustumCulled = false;
    parent.add(this.standby);
  }

  get count(): number {
    return this.crates.size;
  }

  has(crateId: CrateId): boolean {
    return this.crates.has(crateId);
  }

  spawn(crateId: CrateId): void {
    if (this.crates.has(crateId)) return;
    this.retireStandby();
    const look: CrateLook = {
      seam: new Color(seamColor(null)),
      glow: 1,
      sweep: GLINT_OFF,
      glint: 1,
    };
    const root = this.build(`crate:${crateId}`, look);
    this.parent.add(root);
    this.crates.set(crateId, { root, look, arrive: 0, age: 0, fall: null });
  }

  /** The server rolled this crate: its seam takes the rarity colour its unbox will play in. */
  rolled(crateId: CrateId, rarity: Rarity): void {
    this.crates.get(crateId)?.look.seam.set(seamColor(rarity));
  }

  /** The seam colour a crate glows with now, as a hex string; `null` for an unknown crate. */
  seamOf(crateId: CrateId): string | null {
    const look = this.crates.get(crateId)?.look;
    return look ? `#${look.seam.getHexString().toUpperCase()}` : null;
  }

  /** A crate's current shine, for tests and the frame budget; `null` for an unknown crate. */
  shineOf(crateId: CrateId): CrateShine | null {
    const look = this.crates.get(crateId)?.look;
    return look ? { glow: look.glow, sweep: look.sweep, glint: look.glint } : null;
  }

  /** Sends a crate over the edge into the tray from where it was last drawn. */
  fall(crateId: CrateId, position: TablePoint): void {
    const crate = this.crates.get(crateId);
    if (!crate || crate.fall) return;
    const from = new Vector3(position.x, position.y, position.z);
    crate.fall = { from, to: trayLanding(position.x), t: 0, spin: position.x >= 0 ? 1 : -1 };
  }

  /** Where the crate rests in the tray (or will), for the cinematic to take over from. */
  landing(crateId: CrateId): Vector3 | null {
    const fall = this.crates.get(crateId)?.fall;
    return fall ? fall.to.clone() : null;
  }

  remove(crateId: CrateId): void {
    const crate = this.crates.get(crateId);
    if (!crate) return;
    this.discard(crate.root);
    this.crates.delete(crateId);
  }

  /** Poses every crate: riding ones from their ride, falling ones along their tumble. */
  update(dt: number, rides: readonly CrateRide[], reducedMotion: boolean): void {
    const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    const teetering = new Set<CrateId>();
    for (const ride of rides) {
      const crate = this.crates.get(ride.crate.id);
      if (!crate || crate.fall) continue;
      if (ride.phase === 'teeter') teetering.add(ride.crate.id);
      crate.arrive = reducedMotion ? 1 : Math.min(1, crate.arrive + step / ARRIVE_S);
      const { x, y, z } = ride.position;
      const drop = 1 - easeOutCubic(crate.arrive);
      const squash = reducedMotion ? 1 : 1 - Math.sin(crate.arrive * Math.PI) * 0.18;
      crate.root.position.set(x, y + drop * ARRIVE_HEIGHT, z);
      crate.root.scale.set(2 - squash, squash, 2 - squash);
      crate.root.rotation.set(ride.tilt, 0, 0);
    }
    for (const [crateId, crate] of this.crates) {
      crate.age += step;
      const shine = crateShine(crate.age, teetering.has(crateId), reducedMotion);
      crate.look.glow = shine.glow;
      crate.look.sweep = shine.sweep;
      crate.look.glint = shine.glint;
      const fall = crate.fall;
      if (!fall) continue;
      fall.t = reducedMotion ? 1 : Math.min(1, fall.t + step / FALL_S);
      const k = fall.t;
      const hop = Math.sin(k * Math.PI) * 0.02;
      crate.root.position.set(
        lerp(fall.from.x, fall.to.x, k),
        lerp(fall.from.y, fall.to.y, easeInQuad(k)) + hop,
        lerp(fall.from.z, fall.to.z, easeOutCubic(k)),
      );
      crate.root.rotation.set(
        lerp(MAX_FALL_TILT, Math.PI * 2, easeOutCubic(k)),
        fall.spin * 0.4 * k,
        fall.spin * Math.sin(k * Math.PI) * 0.3,
      );
      const squash = k >= 1 ? 1 : 1 - Math.max(0, (k - 0.85) / 0.15) * 0.12;
      crate.root.scale.set(2 - squash, squash, 2 - squash);
    }
  }

  dispose(): void {
    this.retireStandby();
    for (const crate of this.crates.values()) this.discard(crate.root);
    this.crates.clear();
    this.body.dispose();
    this.trim.dispose();
    this.seam.dispose();
    this.lacquer.dispose();
    this.gold.dispose();
    this.glow.dispose();
  }

  private build(name: string, look: CrateLook): Group {
    const root = new Group();
    root.name = name;
    const body = new Mesh(this.body, this.lacquer);
    body.castShadow = true;
    const trim = new Mesh(this.trim, this.gold);
    trim.castShadow = true;
    const seam = new Mesh(this.seam, this.glow);
    seam.renderOrder = 1;
    root.add(body, trim, seam);
    for (const mesh of root.children) this.looks.set(mesh, look);
    return root;
  }

  private discard(root: Group): void {
    root.removeFromParent();
    for (const mesh of root.children) this.looks.delete(mesh);
  }

  private retireStandby(): void {
    if (!this.standby) return;
    this.discard(this.standby);
    this.standby = null;
  }

  private lookOf(object: Object3D | null): CrateLook {
    const look = object === null ? undefined : this.looks.get(object);
    if (!look)
      throw new Error('Table crate material drawn on a mesh that is not one of its crates');
    return look;
  }
}

export interface OpenedCrate {
  readonly crateId: CrateId;
  readonly roll: Roll;
  readonly wallet: Wallet;
  readonly at: Vector3;
}

/** The DOM card the director drives; `mountCrateReveal` is the real one. */
export interface UnboxCard {
  readonly shown: boolean;
  show(): void;
  /** A sheet opened over the unbox: the card steps out of sight until the director lets go. */
  hold?(held: boolean): void;
  dispose(): void;
}

export interface UnboxDirectorOptions {
  readonly parent: Object3D;
  readonly camera: PerspectiveCamera;
  readonly framing: (aspect: number) => CameraPreset;
  readonly events: Bus<CrateEvents>;
  readonly reducedMotion: () => boolean;
  readonly vfx?: UnboxVfx | null;
  readonly haptics?: { pulse(pattern: HapticPattern): boolean } | null;
  /** Mounts the reward card; `skip` jumps the cinematic, `collect` ends it. */
  readonly card: (
    opened: OpenedCrate,
    controls: { readonly skip: () => void; readonly collect: () => void },
  ) => UnboxCard;
  /** The table crate is handed over to the cinematic and should leave the table view. */
  readonly onStart?: (crateId: CrateId) => void;
  /** Where the hero's coins find their struck faces: the table's own bakes. */
  readonly faces?: UnboxAssetsOptions['faces'];
}

interface Playing {
  readonly opened: OpenedCrate;
  readonly cinematic: UnboxCinematic;
  readonly card: UnboxCard;
  collected: boolean;
}

/**
 * Plays opened crates one at a time: the 3D unbox, its stingers on the bus, then the reward card.
 * A crate that opens while another is playing waits its turn in arrival order. The unbox props
 * and light are built here once and lent to each cinematic.
 *
 * While held (a sheet is open) nothing starts and a playing unbox freezes with its card out of
 * sight, so the cinematic never plays behind a sheet or stacks over one; `crate:waiting` tells
 * the dock how many crates are ready for when it lets go.
 */
export class UnboxDirector {
  private readonly options: UnboxDirectorOptions;
  private readonly assets: UnboxAssets;
  private readonly queue: OpenedCrate[] = [];
  private playing: Playing | null = null;
  private isHeld = false;
  private announced = 0;
  private disposed = false;

  constructor(options: UnboxDirectorOptions) {
    this.options = options;
    this.assets = new UnboxAssets(options.parent, { faces: options.faces ?? null });
  }

  /** Starts compiling the unbox props; call it ahead of the first crate. */
  prime(): void {
    if (!this.disposed) this.assets.prime();
  }

  get active(): CrateId | null {
    return this.playing?.opened.crateId ?? null;
  }

  get waiting(): number {
    return this.queue.length;
  }

  get cinematic(): UnboxCinematic | null {
    return this.playing?.cinematic ?? null;
  }

  get held(): boolean {
    return this.isHeld;
  }

  enqueue(opened: OpenedCrate): void {
    if (this.disposed) return;
    this.assets.prime();
    this.queue.push(opened);
    if (this.isHeld) this.announceWaiting();
    else if (this.playing === null) this.startNext();
  }

  /** Holds the unbox while a sheet is open; letting go starts the next crate at once. */
  hold(held: boolean): void {
    if (this.disposed || held === this.isHeld) return;
    this.isHeld = held;
    this.playing?.card.hold?.(held);
    this.announceWaiting();
    if (!held && this.playing === null) this.startNext();
  }

  skip(): void {
    if (this.isHeld) return;
    this.playing?.cinematic.skip();
  }

  collect(): void {
    const playing = this.playing;
    if (this.isHeld || !playing || playing.collected) return;
    if (!playing.card.shown) {
      playing.cinematic.skip();
      return;
    }
    playing.collected = true;
    this.stinger('collect', playing.opened.roll.rarity, 1, 0);
    playing.cinematic.collect();
    this.options.events.emit('crate:collected', {
      crateId: playing.opened.crateId,
      roll: playing.opened.roll,
      wallet: playing.opened.wallet,
    });
  }

  /** `dt` in effect time, so a hit-stop freezes the burst with the rest of the world. */
  update(dt: number): void {
    const playing = this.playing;
    if (this.disposed || this.isHeld || !playing) return;
    playing.cinematic.update(dt);
    if (playing.cinematic.done) this.finish();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.queue.length = 0;
    this.finish();
    this.assets.dispose();
  }

  /**
   * Mounts the card before any 3D so a card that refuses the roll leaves nothing behind; the
   * error still surfaces, and the queue moves on to the next crate.
   */
  private startNext(): void {
    const opened = this.queue.shift();
    if (!opened) return;
    const { roll } = opened;
    this.options.onStart?.(opened.crateId);
    let card: UnboxCard;
    let cinematic: UnboxCinematic;
    try {
      card = this.options.card(opened, {
        skip: () => {
          this.skip();
        },
        collect: () => {
          this.collect();
        },
      });
    } catch (error) {
      this.startNext();
      throw error;
    }
    try {
      cinematic = new UnboxCinematic({
        parent: this.options.parent,
        assets: this.assets,
        camera: this.options.camera,
        framing: this.options.framing,
        at: opened.at,
        rarity: roll.rarity,
        hero: heroOf(roll.rewards),
        reducedMotion: this.options.reducedMotion(),
        vfx: this.options.vfx ?? null,
        haptics: this.options.haptics ?? null,
        onBeat: (beat) => {
          this.onBeat(opened, beat, cinematic.timeline.revealAtMs);
          if (beat.kind === 'reveal') card.show();
        },
      });
    } catch (error) {
      card.dispose();
      this.startNext();
      throw error;
    }
    this.playing = { opened, cinematic, card, collected: false };
    if (cinematic.revealed) card.show();
  }

  private onBeat(opened: OpenedCrate, beat: UnboxBeat, revealAtMs: number): void {
    const rarity: Rarity = opened.roll.rarity;
    switch (beat.kind) {
      case 'land':
        this.stinger('land', rarity, 1, Math.max(0.5, (revealAtMs - beat.atMs) / 1000));
        break;
      case 'shudder':
        this.stinger('shudder', rarity, beat.step, 0);
        break;
      case 'rays':
        this.stinger('rays', rarity, 1, 0);
        break;
      case 'burst':
        this.stinger('burst', rarity, 1, BURST_DUCK_S);
        this.options.events.emit('crate:revealed', { crateId: opened.crateId, rarity });
        break;
      case 'reveal':
        break;
    }
  }

  private announceWaiting(): void {
    const count = this.isHeld ? this.queue.length + (this.playing ? 1 : 0) : 0;
    if (count === this.announced) return;
    this.announced = count;
    this.options.events.emit('crate:waiting', { count });
  }

  private stinger(cue: CrateStingerCue, rarity: Rarity, step: number, duckSeconds: number): void {
    this.options.events.emit('crate:stinger', { cue, rarity, step, duckSeconds });
  }

  private finish(): void {
    const playing = this.playing;
    this.playing = null;
    if (playing) {
      playing.card.dispose();
      playing.cinematic.dispose();
    }
    if (!this.disposed && !this.isHeld) this.startNext();
  }
}
