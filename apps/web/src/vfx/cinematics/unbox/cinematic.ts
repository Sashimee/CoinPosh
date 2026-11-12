import type { Rarity } from '@coinposh/shared';
import { Vector3, type Object3D, type PerspectiveCamera } from 'three/webgpu';
import type { CameraPreset } from '../../../scene/venues/riviera/layout.ts';
import type { CameraKickOptions } from '../../camera/cameraKick.ts';
import type { ContactOptions } from '../../index.ts';
import type { HapticPattern } from '../../haptics.ts';
import {
  burstStyle,
  unboxBeats,
  unboxPose,
  unboxTimeline,
  type UnboxBeat,
  type UnboxPose,
  type UnboxTimeline,
} from './plan.ts';
import { easeInCubic } from '../../easing.ts';
import { pushIn, unboxShot, type UnboxShot } from './shot.ts';
import { CRATE_SIZE, UnboxStage, type UnboxAssets, type UnboxHero } from './stage.ts';

/** The slice of `Vfx` the unbox fires into; any of it may be missing (tests, a lost GPU). */
export interface UnboxVfx {
  hitStop(ms?: number): void;
  cameraKick(options: CameraKickOptions): void;
  confetti(): number;
  contactSparks(position: Vector3, options: ContactOptions): void;
}

export interface UnboxCinematicOptions {
  readonly parent: Object3D;
  /** Shared props and light, mounted into `parent` once; the cinematic only borrows them. */
  readonly assets: UnboxAssets;
  readonly camera: PerspectiveCamera;
  /** The venue framing for an aspect ratio; the dolly leaves it and returns to it. */
  readonly framing: (aspect: number) => CameraPreset;
  /**
   * Where the table crate came to rest in the catch tray, in world space. The cabinet front
   * hides the tray, so the unbox plays centre stage in front of the table and the crate sinks
   * back here after Collect.
   */
  readonly at: Vector3;
  readonly rarity: Rarity;
  readonly hero: UnboxHero;
  readonly reducedMotion: boolean;
  readonly vfx?: UnboxVfx | null;
  readonly haptics?: { pulse(pattern: HapticPattern): boolean } | null;
  /** Every beat as it lands, including ones a skip jumps over; stingers and the card hang off it. */
  readonly onBeat?: (beat: UnboxBeat) => void;
}

/**
 * Contact strengths kept at or under the facade's `CONTACT_ACCENT`, so the sparks come without
 * its flash sprite: staged this close to the camera, that sprite's anamorphic streak would cross
 * the whole frame. The stage's own round flare marks the burst instead.
 */
const LAND_SPARKS = 0.35;
const BURST_SPARKS = 0.45;

/**
 * One crate opening, driven by `update(dt)` in effect time (pass the delta `Vfx.update`
 * returns, so its hit-stop freezes the lid mid-burst). Holds on the reveal until `collect()`,
 * then flies the item out and hands the camera back to the venue framing.
 */
export class UnboxCinematic {
  readonly stage: UnboxStage;
  readonly timeline: UnboxTimeline;
  private readonly options: UnboxCinematicOptions;
  private readonly beats: readonly UnboxBeat[];
  private next = 0;
  private elapsedMs = 0;
  private flyMs: number | null = null;
  private lastPose: UnboxPose;
  private disposed = false;
  private readonly eye = new Vector3();
  private readonly look = new Vector3();
  private framingAspect = Number.NaN;
  private framed: CameraPreset | null = null;
  private shotOf: UnboxShot | null = null;

  constructor(options: UnboxCinematicOptions) {
    this.options = options;
    this.timeline = unboxTimeline(options.reducedMotion);
    this.beats = unboxBeats(this.timeline);
    this.stage = new UnboxStage(options.rarity, options.hero, options.assets);
    options.parent.add(this.stage.root);
    this.lastPose = unboxPose(0, this.timeline, options.reducedMotion);
    this.render(0);
  }

  /** Where the crate is staged for the camera's current aspect. */
  get shot(): UnboxShot {
    this.framing();
    if (!this.shotOf) throw new Error('Unbox shot was not framed');
    return this.shotOf;
  }

  get pose(): UnboxPose {
    return this.lastPose;
  }

  get elapsed(): number {
    return this.elapsedMs;
  }

  get revealed(): boolean {
    return this.next >= this.beats.length;
  }

  get done(): boolean {
    return this.flyMs !== null && this.flyMs >= this.timeline.flyMs;
  }

  update(dt: number): void {
    if (this.disposed) return;
    const step = Number.isFinite(dt) ? Math.max(0, dt) * 1000 : 0;
    this.elapsedMs += step;
    if (this.flyMs !== null) this.flyMs += step;
    this.fireBeats(false);
    this.render(step / 1000);
  }

  /** Jumps to the reveal: every beat not yet played fires once, without hit-stop or shake. */
  skip(): void {
    if (this.disposed || this.revealed) return;
    this.elapsedMs = Math.max(this.elapsedMs, this.timeline.revealAtMs);
    this.fireBeats(true);
    this.render(0);
  }

  /** Starts the item's flight to the inventory; `done` turns true when it lands. */
  collect(): void {
    if (this.disposed) return;
    this.skip();
    this.flyMs ??= 0;
    this.render(0);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const framing = this.framing();
    this.options.camera.position.copy(framing.position);
    this.options.camera.lookAt(framing.target);
    this.stage.dispose();
  }

  private fireBeats(skipped: boolean): void {
    while (this.next < this.beats.length) {
      const beat = this.beats[this.next];
      if (!beat || beat.atMs > this.elapsedMs) break;
      this.next++;
      this.juice(beat, skipped);
      this.options.onBeat?.(beat);
    }
  }

  private juice(beat: UnboxBeat, skipped: boolean): void {
    const { vfx, haptics, reducedMotion } = this.options;
    const { base } = this.shot;
    switch (beat.kind) {
      case 'land':
        haptics?.pulse('tap');
        if (!skipped) vfx?.contactSparks(base, { strength: LAND_SPARKS, surface: 'wood' });
        break;
      case 'shudder':
        haptics?.pulse(beat.step >= 3 ? 'tap' : 'tick');
        if (!skipped && !reducedMotion) vfx?.cameraKick({ shake: 0.05 * beat.step });
        break;
      case 'rays':
        break;
      case 'burst': {
        const burst = burstStyle(this.options.rarity);
        haptics?.pulse(burst.haptic);
        const top = base.clone();
        top.y += CRATE_SIZE;
        vfx?.contactSparks(top, { strength: BURST_SPARKS, surface: 'metal' });
        if (burst.confetti) vfx?.confetti();
        if (skipped) break;
        if (burst.hitStopMs > 0) vfx?.hitStop(burst.hitStopMs);
        vfx?.cameraKick({ shake: burst.shake, fov: burst.fovKick });
        break;
      }
      case 'reveal':
        break;
    }
  }

  private render(dtSeconds: number): void {
    const pose = unboxPose(this.elapsedMs, this.timeline, this.options.reducedMotion, this.flyMs);
    this.lastPose = pose;
    const framing = this.framing();
    const shot = this.shot;
    this.stage.face(shot.yaw, shot.toCamera);
    this.stage.root.position.lerpVectors(shot.base, this.options.at, easeInCubic(pose.fly));
    this.stage.apply(pose, dtSeconds);
    pushIn(framing, shot.center, pose.dolly, this.eye, this.look);
    this.options.camera.position.copy(this.eye);
    this.options.camera.lookAt(this.look);
  }

  private framing(): CameraPreset {
    const aspect = this.options.camera.aspect;
    if (this.framed === null || aspect !== this.framingAspect) {
      this.framed = this.options.framing(aspect);
      this.shotOf = unboxShot(this.framed, aspect);
      this.framingAspect = aspect;
    }
    return this.framed;
  }
}
