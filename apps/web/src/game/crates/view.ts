import type { CrateId, Rarity, Roll, Wallet } from '@coinposh/shared';
import {
  BoxGeometry,
  Group,
  Mesh,
  MeshPhysicalNodeMaterial,
  Vector3,
  type Object3D,
  type PerspectiveCamera,
} from 'three/webgpu';
import type { Bus } from '../../app/bus.ts';
import type { CameraPreset } from '../../scene/venues/riviera/layout.ts';
import { RIVIERA_TABLE } from '../../scene/venues/riviera/layout.ts';
import { rivieraTokens } from '../../scene/venues/riviera/palette.ts';
import { easeInQuad, easeOutCubic, lerp } from '../../vfx/easing.ts';
import type { HapticPattern } from '../../vfx/haptics.ts';
import {
  CRATE_SIZE,
  UnboxAssets,
  UnboxCinematic,
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
const MAX_FALL_TILT = 1.1;

/** Where a crate that went over at `x` comes to rest in the catch tray. */
export function trayLanding(x: number): Vector3 {
  return new Vector3(x * 0.6, TRAY_FLOOR_Y, TRAY_Z);
}

interface TableCrate {
  readonly root: Group;
  arrive: number;
  fall: { from: Vector3; to: Vector3; t: number; spin: number } | null;
}

/**
 * The crates on the table: a lacquer box per crate that drops in from the chute with a squash,
 * rides and tips with its `CrateRide`, then tumbles into the catch tray and waits there for its
 * unbox. Shares one geometry and material set across every crate.
 */
export class TableCrateView {
  private readonly parent: Object3D;
  private readonly crates = new Map<CrateId, TableCrate>();
  private readonly body = new BoxGeometry(CRATE_SIZE, CRATE_SIZE, CRATE_SIZE);
  private readonly band = new BoxGeometry(CRATE_SIZE * 1.04, CRATE_SIZE * 0.16, CRATE_SIZE * 1.04);
  private readonly lacquer = new MeshPhysicalNodeMaterial({
    color: rivieraTokens['navy-lacquer'],
    roughness: 0.28,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
  });
  private readonly gold = new MeshPhysicalNodeMaterial({
    color: rivieraTokens['gold-brushed'],
    metalness: 1,
    roughness: 0.3,
  });

  constructor(parent: Object3D) {
    this.parent = parent;
  }

  get count(): number {
    return this.crates.size;
  }

  has(crateId: CrateId): boolean {
    return this.crates.has(crateId);
  }

  spawn(crateId: CrateId): void {
    if (this.crates.has(crateId)) return;
    const root = new Group();
    root.name = `crate:${crateId}`;
    const box = new Mesh(this.body, this.lacquer);
    box.position.y = CRATE_SIZE / 2;
    box.castShadow = true;
    const band = new Mesh(this.band, this.gold);
    band.position.y = CRATE_SIZE * 0.55;
    root.add(box, band);
    this.parent.add(root);
    this.crates.set(crateId, { root, arrive: 0, fall: null });
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
    crate.root.removeFromParent();
    this.crates.delete(crateId);
  }

  /** Poses every crate: riding ones from their ride, falling ones along their tumble. */
  update(dt: number, rides: readonly CrateRide[], reducedMotion: boolean): void {
    const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    for (const ride of rides) {
      const crate = this.crates.get(ride.crate.id);
      if (!crate || crate.fall) continue;
      crate.arrive = reducedMotion ? 1 : Math.min(1, crate.arrive + step / ARRIVE_S);
      const { x, y, z } = ride.position;
      const drop = 1 - easeOutCubic(crate.arrive);
      const squash = reducedMotion ? 1 : 1 - Math.sin(crate.arrive * Math.PI) * 0.18;
      crate.root.position.set(x, y + drop * ARRIVE_HEIGHT, z);
      crate.root.scale.set(2 - squash, squash, 2 - squash);
      crate.root.rotation.set(ride.tilt, 0, 0);
    }
    for (const crate of this.crates.values()) {
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
    for (const crate of this.crates.values()) crate.root.removeFromParent();
    this.crates.clear();
    this.body.dispose();
    this.band.dispose();
    this.lacquer.dispose();
    this.gold.dispose();
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
 */
export class UnboxDirector {
  private readonly options: UnboxDirectorOptions;
  private readonly assets: UnboxAssets;
  private readonly queue: OpenedCrate[] = [];
  private playing: Playing | null = null;
  private disposed = false;

  constructor(options: UnboxDirectorOptions) {
    this.options = options;
    this.assets = new UnboxAssets(options.parent);
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

  enqueue(opened: OpenedCrate): void {
    if (this.disposed) return;
    this.queue.push(opened);
    if (this.playing === null) this.startNext();
  }

  skip(): void {
    this.playing?.cinematic.skip();
  }

  collect(): void {
    const playing = this.playing;
    if (!playing || playing.collected) return;
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
    if (this.disposed || !playing) return;
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
    if (!this.disposed) this.startNext();
  }
}
