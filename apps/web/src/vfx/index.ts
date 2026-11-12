import {
  CASCADE_TIERS,
  COIN_TIERS,
  type CascadeTier,
  type CoinTier,
  type Rarity,
} from '@coinposh/shared';
import type { i18n as I18n } from 'i18next';
import {
  Group,
  Vector3,
  type Object3D,
  type PerspectiveCamera,
  type WebGPURenderer,
} from 'three/webgpu';
import { createRng, type Rng } from '../audio/rng.ts';
import type { RenderBackend } from '../backend.ts';
import { watchReducedMotion, type MotionPreference } from '../scene/post/reducedMotion.ts';
import type { QualityTier } from '../scene/quality/tiers.ts';
import { RIVIERA_TABLE } from '../scene/venues/riviera/layout.ts';
import { CameraKick, type CameraKickOptions } from './camera/cameraKick.ts';
import {
  confetti as confettiRecipe,
  contactSparks as contactRecipe,
  cascadeFizz,
  dropSwirl,
  dropTrail as trailRecipe,
  fusionImpact,
  fusionImplosion,
  fusionSpark,
  type ContactSurface,
  type EmitContext,
  type Vec3,
  type ViewFrame,
} from './emitters.ts';
import { FlashPool } from './flash.ts';
import { FUSION_FULL_FROM, FusionDirector } from './fusionJuice.ts';
import { GlowEnvelope } from './glow.ts';
import { Haptics, type HapticNavigator } from './haptics.ts';
import { CASCADE_COLORS, HEIRLOOM_PRISM, RARITY_COLORS, VFX_COLORS, tierMetal } from './palette.ts';
import { ParticleKind } from './particles/layout.ts';
import { AttractorTable } from './particles/attractors.ts';
import type { ParticleEnvironment, ParticleFloor } from './particles/physics.ts';
import { ParticleSystem } from './particles/system.ts';
import { ShockwavePool } from './shockwave.ts';
import type { ScreenPoint } from './text/arc.ts';
import { formatPopValue } from './text/format.ts';
import { NumberPopLayer } from './text/numberPopLayer.ts';
import { Timeline } from './timeline.ts';
import { TimeWarp, type SlowMoOptions } from './time/timeWarp.ts';

export { EFFECT_JUICE, JUICE_ITEMS, type JuiceItem, type VfxEffect } from './juice.ts';
export { HIT_STOP_MS, TimeWarp, type SlowMoOptions } from './time/timeWarp.ts';
export { CameraKick, type CameraKickOptions } from './camera/cameraKick.ts';
export {
  FUSION_FULL_FROM,
  FUSION_KICK_GAP_MS,
  FusionDirector,
  type FusionJuice,
  type FusionTreatment,
} from './fusionJuice.ts';
export type { ContactSurface } from './emitters.ts';
export type { ScreenPoint } from './text/arc.ts';

/** The light-response knobs of the post pipeline (`PostPipeline.uniforms`). */
export interface VfxPostUniforms {
  readonly bloomBoost: { value: number };
  readonly exposureBoost: { value: number };
}

export interface VfxOptions {
  readonly scene: Object3D;
  readonly camera: PerspectiveCamera;
  readonly renderer: WebGPURenderer;
  readonly backend: RenderBackend;
  /** Positioned element over the canvas that number pops are drawn into. */
  readonly overlay?: HTMLElement;
  /** Initialised i18next instance; number pops format through it. */
  readonly i18n?: I18n;
  readonly quality?: QualityTier;
  /** Forces the preference; when omitted the vfx follows `prefers-reduced-motion` live. */
  readonly reducedMotion?: boolean;
  readonly post?: { readonly uniforms: VfxPostUniforms };
  /** Surface particles bounce on; defaults to the Riviera playfield. */
  readonly arena?: ParticleFloor;
  readonly seed?: number;
  readonly navigator?: HapticNavigator;
  /** Wall clock in ms for haptic and fusion camera-kick rate limiting. */
  readonly now?: () => number;
}

export interface DropTrail {
  /** Feed the coin's position every frame while it falls. */
  moveTo(position: Vector3): void;
  /** Call on first contact; the trail stops emitting and fades. */
  end(): void;
}

export interface FusionOptions {
  /** World positions of the coins being fused (normally three). */
  readonly sources: readonly Vector3[];
  readonly center: Vector3;
  /** Tier of the coin the fusion produces. */
  readonly tier: CoinTier;
  /** Fires on the frame of the flash, when the new coin should pop up with its hop. */
  readonly onImpact?: () => void;
}

export interface ContactOptions {
  /** Impact strength in [0, 1], e.g. relative speed over the loudest expected hit. */
  readonly strength: number;
  readonly surface: ContactSurface;
  readonly normal?: Vector3;
}

/**
 * The pop's colour comes from what earned it: a loot `rarity` takes the rarity palette, a
 * coin `tier` its own metal (heirloom the prism). Pass one or neither (ivory, like common).
 */
export interface NumberPopOptions {
  readonly rarity?: Rarity;
  readonly tier?: CoinTier;
  readonly onArrive?: () => void;
}

export interface VfxStats {
  readonly mode: 'gpu' | 'cpu';
  readonly particles: number;
  readonly confetti: number;
  readonly dropped: number;
  readonly flashes: number;
  readonly shockwaves: number;
  /**
   * The largest visible flash's scale over its rest size: above 1 only while one pops
   * with overshoot, which reduced motion removes. 0 with no flash on screen.
   */
  readonly flashStretch: number;
  /** Fusion centres currently leased by an implosion. */
  readonly attractors: number;
  readonly pops: number;
  readonly timeScale: number;
  readonly glow: number;
}

/** Beats of the fusion choreography, in effect seconds from the call. */
export const FUSION_TIMING = {
  implode: 0.32,
  ringGap: 0.06,
  releaseSlot: 0.75,
} as const;

/** OBSCENE: the big one. Slow-mo and hit-stop as the art bible asks. */
export const OBSCENE_TIMING = {
  hitStopMs: 80,
  slowMo: { scale: 0.35, holdMs: 900, rampOutMs: 520 },
} as const;

const GLOW_CAPACITY: Readonly<Record<QualityTier, number>> = {
  high: 12288,
  medium: 8192,
  low: 4096,
};
const CONFETTI_CAPACITY = 1024;
/** Contacts beyond this per frame are dropped: a 40-coin avalanche is a hiss, not a strobe. */
const CONTACTS_PER_FRAME = 10;
const MIN_CONTACT = 0.06;
/** Above this strength a contact gets its own flash, glow and haptic. */
export const CONTACT_ACCENT = 0.45;
/** A trail nobody has moved for this long was abandoned (coin despawned) and is closed. */
const TRAIL_TIMEOUT_S = 1;

const DEFAULT_ARENA: ParticleFloor = {
  y: 0,
  minX: -RIVIERA_TABLE.fieldHalfWidth,
  maxX: RIVIERA_TABLE.fieldHalfWidth,
  minZ: RIVIERA_TABLE.backboardFrontZ,
  maxZ: RIVIERA_TABLE.fieldFrontZ,
};
const TABLE_CENTRE = new Vector3(0, 0.01, -0.08);

/**
 * The routine fusion's footprint, metres. A coin is 27 mm across, and the flash sprites pop
 * to about 1.4x their size, so the brightest part stays within about three coins.
 */
export const COMPACT_FUSION = {
  flash: { core: 0.042, halo: 0.056 },
  ringRadius: 0.036,
  implosionDensity: 0.45,
} as const;

interface ActiveTrail {
  readonly tier: CoinTier;
  last: Vec3;
  carry: number;
  idle: number;
  open: boolean;
}

const tmp = new Vector3();

function vec(v: Vector3): Vec3 {
  return [v.x, v.y, v.z];
}

/**
 * Every juice effect behind one object for the game loop (T-1.10) to call. Call
 * `update(realDt)` once per frame before rendering and drive the world's visual delta by
 * `timeScale`, so hit-stop and slow-mo reach coins as well as particles.
 */
export class Vfx {
  readonly root = new Group();
  private readonly camera: PerspectiveCamera;
  private renderer: WebGPURenderer;
  private backend: RenderBackend;
  private quality: QualityTier;
  private reduced: boolean;
  private readonly motion: MotionPreference | null;
  private readonly rng: Rng;
  private readonly env: ParticleEnvironment;
  private sparks: ParticleSystem;
  private foil: ParticleSystem;
  private readonly flashes = new FlashPool();
  private readonly shockwaves = new ShockwavePool();
  private readonly glowEnvelope = new GlowEnvelope();
  private readonly warp = new TimeWarp();
  private readonly kick: CameraKick;
  private readonly haptics: Haptics;
  private readonly timeline = new Timeline();
  private readonly pops: NumberPopLayer | null;
  private readonly i18n: I18n | null;
  private readonly post: { readonly uniforms: VfxPostUniforms } | null;
  private readonly trails = new Set<ActiveTrail>();
  private readonly attractors = new AttractorTable();
  private readonly fusionDirector = new FusionDirector();
  private readonly now: () => number;
  private contactsThisFrame = 0;
  private disposed = false;

  constructor(options: VfxOptions) {
    this.camera = options.camera;
    this.renderer = options.renderer;
    this.backend = options.backend;
    this.quality = options.quality ?? 'high';
    this.rng = createRng(options.seed ?? 0x5eed);
    this.kick = new CameraKick(this.rng);
    this.now = options.now ?? (() => performance.now());
    this.haptics = new Haptics(
      options.navigator ?? (typeof navigator === 'undefined' ? undefined : navigator),
      this.now,
    );
    this.env = { floor: options.arena ?? DEFAULT_ARENA, attractors: this.attractors.positions };
    this.pops = options.overlay ? new NumberPopLayer(options.overlay) : null;
    this.i18n = options.i18n ?? null;
    this.post = options.post ?? null;
    this.root.name = 'vfx';
    [this.sparks, this.foil] = this.createParticles();
    this.root.add(this.flashes.group, this.shockwaves.group);
    options.scene.add(this.root);
    if (options.reducedMotion === undefined) {
      this.motion = watchReducedMotion((reduced) => {
        this.applyReducedMotion(reduced);
      });
      this.reduced = this.motion.reduced;
    } else {
      this.motion = null;
      this.reduced = options.reducedMotion;
    }
    this.applyReducedMotion(this.reduced);
  }

  /** Multiply the world's visual delta by this; 0 during a hit-stop. */
  get timeScale(): number {
    return this.warp.scale;
  }

  /** Current light-response level (0 at rest), already fed to the post pipeline if given. */
  get glow(): number {
    return this.glowEnvelope.value;
  }

  get reducedMotion(): boolean {
    return this.reduced;
  }

  get stats(): VfxStats {
    return {
      mode: this.sparks.mode,
      particles: this.sparks.stats.live,
      confetti: this.foil.stats.live,
      dropped: this.sparks.stats.dropped + this.foil.stats.dropped,
      flashes: this.flashes.active,
      shockwaves: this.shockwaves.active,
      flashStretch: this.flashes.stretch,
      attractors: this.attractors.held,
      pops: this.pops?.active ?? 0,
      timeScale: this.warp.scale,
      glow: this.glowEnvelope.value,
    };
  }

  /**
   * The coin's spin-in at the aim cursor and its falling streak. Juice: tier-coloured
   * swirl and trail (particles), a popping flash (overshoot, light) and a haptic tick.
   */
  dropTrail(start: Vector3, options: { readonly tier: CoinTier }): DropTrail {
    this.assertLive();
    const ctx = this.context(this.sparks);
    dropSwirl(ctx, vec(start), options.tier);
    this.flashes.spawn(start, {
      color: options.tier === 'heirloom' ? HEIRLOOM_PRISM[0] : tierMetal(options.tier),
      size: 0.07,
      intensity: 2.2,
      duration: 0.22,
    });
    this.glowEnvelope.add({ peak: 0.12, attack: 0.04, release: 0.2 });
    this.haptics.pulse('tick');
    const trail: ActiveTrail = {
      tier: options.tier,
      last: vec(start),
      carry: 0,
      idle: 0,
      open: true,
    };
    this.trails.add(trail);
    return {
      moveTo: (position) => {
        if (!trail.open) return;
        const next = vec(position);
        trail.carry = trailRecipe(
          this.context(this.sparks),
          trail.last,
          next,
          trail.tier,
          trail.carry,
        );
        trail.last = next;
        trail.idle = 0;
      },
      end: () => {
        this.closeTrail(trail);
      },
    };
  }

  /**
   * Sparks from a collision, scaled by strength². Strong hits add a flash pop, a bloom
   * nudge, a haptic tap and, at the very top, a whisper of camera shake. Contacts at or
   * under `CONTACT_ACCENT` are particles only: they are the texture of the drop or push
   * they belong to, not interactions of their own.
   */
  contactSparks(position: Vector3, options: ContactOptions): void {
    this.assertLive();
    if (options.strength < MIN_CONTACT || this.contactsThisFrame >= CONTACTS_PER_FRAME) return;
    this.contactsThisFrame++;
    const s = Math.min(1, options.strength);
    contactRecipe(
      this.context(this.sparks),
      vec(position),
      s,
      options.surface,
      options.normal ? vec(options.normal) : undefined,
    );
    if (s > CONTACT_ACCENT) {
      this.flashes.spawn(position, {
        color: VFX_COLORS.whiteGold,
        size: 0.03 + 0.05 * s,
        intensity: 1.5 + 2.5 * s * s,
        duration: 0.12,
      });
      this.glowEnvelope.add({ peak: 0.18 * s * s, attack: 0.02, release: 0.16 });
      this.haptics.pulse(s > 0.75 && !this.reduced ? 'tap' : 'tick');
    }
    if (s > 0.85) this.kick.kick({ shake: 0.06 });
  }

  /**
   * Three coins sucked into a white-gold flash, tiered by how rare the moment is (see
   * `FusionDirector`). Full, for the first fusion and gold-or-better results: the frame
   * tightens (FOV in) as streaks spiral to the centre, then hit-stop, a flash, a double
   * shockwave ring, a spark corona, shake + FOV kick, a bloom surge and a haptic thud.
   * Compact, for the routine copper and silver ones: the same spiral, then a warm flash and
   * a crown of sparks about three coins wide, a small ring, a bloom nudge and a tap; no
   * hit-stop or camera, so a busy table does not wash out or judder.
   */
  fusion(options: FusionOptions): void {
    this.assertLive();
    if (options.sources.length === 0) throw new RangeError('fusion needs at least one source coin');
    const juice = this.fusionDirector.select(options.tier, this.now());
    const full = juice.treatment === 'full';
    const center = options.center.clone();
    const lease = this.attractors.lease(center.x, center.y, center.z);
    fusionImplosion(
      this.context(this.sparks),
      options.sources.map(vec),
      vec(center),
      lease.slot,
      options.tier,
      full ? 1 : COMPACT_FUSION.implosionDensity,
    );
    if (juice.cameraKick) this.kick.kick({ fov: -0.8, dolly: 0.004 });
    this.glowEnvelope.add({
      peak: full ? 0.25 : 0.06,
      attack: FUSION_TIMING.implode,
      release: 0.05,
    });
    this.haptics.pulse('tick');
    this.timeline.at(FUSION_TIMING.implode, () => {
      if (full) this.fusionImpact(center, options.tier, juice.cameraKick);
      else this.fusionCompactImpact(center, options.tier);
      options.onImpact?.();
    });
    this.timeline.at(FUSION_TIMING.releaseSlot, () => {
      this.attractors.release(lease);
    });
  }

  /**
   * A Cascade tier lands: fizz climbs off the table, the bloom swells with the tier,
   * a champagne flash pops over the origin, and from OPULENT up the camera shivers.
   * OBSCENE escalates to `obscene()`.
   */
  cascade(tier: CascadeTier, options: { readonly origin?: Vector3 } = {}): void {
    this.assertLive();
    const level = CASCADE_TIERS.indexOf(tier);
    if (level < 0) throw new RangeError(`Unknown cascade tier "${tier}"`);
    const origin = options.origin ?? TABLE_CENTRE;
    cascadeFizz(this.context(this.sparks), vec(origin), tier, 0.1 + level * 0.035);
    const colors = CASCADE_COLORS[tier];
    this.flashes.spawn(origin, {
      color: colors[0] ?? VFX_COLORS.champagne,
      size: 0.12 + level * 0.06,
      intensity: 1.6 + level * 0.6,
      duration: 0.36,
    });
    this.glowEnvelope.add({ peak: 0.25 + level * 0.2, attack: 0.05, release: 0.45 + level * 0.1 });
    this.haptics.pulse(level >= 3 ? 'thud' : 'tap');
    if (level >= 2) this.kick.kick({ shake: 0.08 * level, fov: 0.5 * level });
    if (tier === 'obscene') this.obscene(origin);
  }

  /** OBSCENE: hit-stop into slow-mo, the confetti storm, rings, a huge bloom, a fanfare buzz. */
  obscene(origin: Vector3 = TABLE_CENTRE): void {
    this.assertLive();
    this.warp.hitStop(OBSCENE_TIMING.hitStopMs);
    this.warp.slowMotion(OBSCENE_TIMING.slowMo);
    this.confetti();
    this.flashes.spawn(origin, { color: VFX_COLORS.gold, size: 0.6, intensity: 4, duration: 0.7 });
    for (let i = 0; i < 3; i++) {
      this.shockwaves.spawn(origin, {
        color: i === 1 ? VFX_COLORS.coral : VFX_COLORS.gold,
        radius: 0.24 + i * 0.05,
        intensity: 2.6 - i * 0.6,
        duration: 0.8,
        delay: i * 0.09,
      });
    }
    this.kick.kick({ shake: 0.5, fov: 3.2 });
    this.glowEnvelope.add({ peak: 2, attack: 0.08, release: 1.4 });
    this.haptics.pulse('fanfare');
  }

  /** The foil shower on its own (also used by OBSCENE); returns the pieces launched. */
  confetti(): number {
    this.assertLive();
    return confettiRecipe(this.context(this.foil), this.viewFrame());
  }

  /**
   * Floating value text: springs in over `from`, hangs, then arcs into `hudTarget` and
   * calls `onArrive` on contact. The source glints and flashes in the pop's colour.
   */
  numberPop(
    value: number,
    from: Vector3,
    hudTarget: Element | ScreenPoint,
    options: NumberPopOptions = {},
  ): void {
    this.assertLive();
    if (!this.pops || !this.i18n) {
      throw new Error(
        'numberPop needs createVfx({ overlay, i18n }) so it has somewhere to draw and a formatter',
      );
    }
    const text = formatPopValue(this.i18n, value);
    const { color, prism } = popColor(options);
    const to = 'getBoundingClientRect' in hudTarget ? this.pops.centerOf(hudTarget) : hudTarget;
    this.pops.spawn({
      text,
      magnitude: value,
      color,
      prism,
      from: this.project(from),
      to,
      ...(options.onArrive ? { onArrive: options.onArrive } : {}),
    });
    this.flashes.spawn(from, {
      color: prism ? HEIRLOOM_PRISM[0] : color,
      size: 0.06,
      intensity: 1.8,
      duration: 0.2,
    });
    this.glowEnvelope.add({ peak: 0.08, attack: 0.03, release: 0.25 });
    const ctx = this.context(this.sparks);
    const glints = this.reduced ? 2 : 6;
    for (let i = 0; i < glints; i++) {
      const a = (i / glints) * Math.PI * 2;
      ctx.emit({
        x: from.x,
        y: from.y + 0.01,
        z: from.z,
        vx: Math.cos(a) * 0.12,
        vy: 0.18,
        vz: Math.sin(a) * 0.12,
        life: 0.45,
        r: 3,
        g: 2.6,
        b: 1.8,
        size: 0.008,
        drag: 4,
        gravity: 0,
        kind: ParticleKind.Glint,
        seed: this.rng(),
      });
    }
  }

  /** Freeze the world for `ms` (40–80 is the impact window; clamped at 120). */
  hitStop(ms?: number): void {
    this.warp.hitStop(ms);
  }

  /** Ignored under reduced motion. */
  slowMotion(options: SlowMoOptions): void {
    this.warp.slowMotion(options);
  }

  /** Shake, FOV punch and dolly on top of the current camera. Ignored under reduced motion. */
  cameraKick(options: CameraKickOptions): void {
    this.kick.kick(options);
  }

  /** Advances every effect; returns the scaled effect delta the frame should use. */
  update(realDt: number): number {
    this.assertLive();
    const real = Number.isFinite(realDt) ? Math.max(0, realDt) : 0;
    const scale = this.warp.update(real);
    const dt = real * scale;
    this.timeline.update(dt);
    for (const trail of this.trails) {
      trail.idle += real;
      if (trail.idle > TRAIL_TIMEOUT_S) this.closeTrail(trail);
    }
    this.sparks.update(dt, this.env, this.renderer);
    this.foil.update(dt, this.env, this.renderer);
    this.shockwaves.update(dt);
    this.flashes.update(real);
    this.writePost(this.glowEnvelope.update(real));
    this.kick.update(real, this.camera);
    this.pops?.update(real);
    this.contactsThisFrame = 0;
    return dt;
  }

  /** Resizes the particle pools for a new tier; effects in flight are cleared. */
  setQuality(tier: QualityTier): void {
    this.assertLive();
    if (tier === this.quality) return;
    this.quality = tier;
    this.rebuildParticles();
  }

  setReducedMotion(reduced: boolean): void {
    this.applyReducedMotion(reduced);
  }

  /** After a backend fallback the particle storage must be rebuilt for the new renderer. */
  setRenderer(renderer: WebGPURenderer, backend: RenderBackend): void {
    this.assertLive();
    this.renderer = renderer;
    if (backend === this.backend) return;
    this.backend = backend;
    this.rebuildParticles();
  }

  /**
   * Puts a zero-strength flash, ring and both particle meshes on screen while `drawFrame`
   * renders, so their programs compile now instead of on the first fusion or OBSCENE.
   * Pass the frame the game really draws (e.g. `() => post.render(now)`): a precompile
   * outside the post pass would build for the wrong target. Call after `renderer.init()`,
   * and again after `setQuality` or `setRenderer`, which rebuild the particle meshes.
   */
  async warmup(drawFrame: () => void | Promise<void>): Promise<void> {
    this.assertLive();
    const meshes = [this.sparks.mesh, this.foil.mesh];
    for (const mesh of meshes) mesh.visible = true;
    try {
      await this.flashes.warm(() =>
        this.shockwaves.warm(async () => {
          await drawFrame();
        }),
      );
    } finally {
      for (const mesh of meshes) mesh.visible = mesh.geometry.instanceCount > 0;
    }
  }

  /** Cancels every running effect and restores time and the camera. */
  clear(): void {
    this.assertLive();
    this.timeline.clear();
    for (const trail of this.trails) this.closeTrail(trail);
    this.attractors.clear();
    this.flashes.clear();
    this.shockwaves.clear();
    this.glowEnvelope.clear();
    this.warp.reset();
    this.kick.reset();
    this.pops?.clear();
    this.writePost(0);
    this.sparks.clear();
    this.foil.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.motion?.dispose();
    this.sparks.dispose();
    this.foil.dispose();
    this.flashes.dispose();
    this.shockwaves.dispose();
    this.pops?.dispose();
    this.root.removeFromParent();
    this.writePost(0);
  }

  private fusionImpact(center: Vector3, tier: CoinTier, cameraKick: boolean): void {
    this.warp.hitStop(60);
    this.flashes.spawn(center, {
      color: VFX_COLORS.whiteGold,
      size: 0.18,
      intensity: 6,
      duration: 0.32,
    });
    this.flashes.spawn(center, {
      color: fusionHalo(tier),
      size: 0.34,
      intensity: 2.2,
      duration: 0.5,
      delay: 0.03,
    });
    this.shockwaves.spawn(center, {
      color: VFX_COLORS.whiteGold,
      radius: 0.16,
      intensity: 3.2,
      duration: 0.55,
    });
    this.shockwaves.spawn(center, {
      color: VFX_COLORS.champagne,
      radius: 0.12,
      intensity: 2,
      duration: 0.6,
      delay: FUSION_TIMING.ringGap,
    });
    fusionImpact(this.context(this.sparks), vec(center), tier);
    if (cameraKick) this.kick.kick({ shake: 0.32, fov: 2.4, dolly: -0.006 });
    this.glowEnvelope.add({ peak: 1.2, attack: 0.03, release: 0.6 });
    this.haptics.pulse('thud');
  }

  private fusionCompactImpact(center: Vector3, tier: CoinTier): void {
    const { flash } = COMPACT_FUSION;
    this.flashes.spawn(center, {
      color: VFX_COLORS.whiteGold,
      size: flash.core,
      intensity: 3.4,
      duration: 0.24,
    });
    this.flashes.spawn(center, {
      color: VFX_COLORS.gold,
      size: flash.halo,
      intensity: 1.3,
      duration: 0.34,
      delay: 0.02,
    });
    this.shockwaves.spawn(center, {
      color: VFX_COLORS.champagne,
      radius: COMPACT_FUSION.ringRadius,
      intensity: 1.6,
      duration: 0.36,
    });
    fusionSpark(this.context(this.sparks), vec(center), tier);
    this.glowEnvelope.add({ peak: 0.14, attack: 0.03, release: 0.22 });
    this.haptics.pulse('tap');
  }

  private writePost(glow: number): void {
    if (!this.post) return;
    this.post.uniforms.bloomBoost.value = 1 + glow;
    this.post.uniforms.exposureBoost.value = 1 + glow * 0.06;
  }

  private closeTrail(trail: ActiveTrail): void {
    trail.open = false;
    this.trails.delete(trail);
  }

  private applyReducedMotion(reduced: boolean): void {
    this.reduced = reduced;
    this.flashes.reducedMotion = reduced;
    this.shockwaves.reducedMotion = reduced;
    this.glowEnvelope.reducedMotion = reduced;
    this.warp.reducedMotion = reduced;
    this.kick.reducedMotion = reduced;
    if (this.pops) this.pops.reducedMotion = reduced;
    if (reduced) {
      this.kick.reset();
      this.warp.reset();
    }
  }

  private context(system: ParticleSystem): EmitContext {
    return {
      rng: this.rng,
      quality: this.quality,
      reducedMotion: this.reduced,
      emit: (spawn) => {
        system.emit(spawn);
      },
    };
  }

  private createParticles(): [ParticleSystem, ParticleSystem] {
    const sparks = new ParticleSystem({
      capacity: GLOW_CAPACITY[this.quality],
      layer: 'glow',
      backend: this.backend,
    });
    const foil = new ParticleSystem({
      capacity: CONFETTI_CAPACITY,
      layer: 'confetti',
      backend: this.backend,
    });
    this.root.add(foil.mesh, sparks.mesh);
    return [sparks, foil];
  }

  private rebuildParticles(): void {
    this.sparks.dispose();
    this.foil.dispose();
    [this.sparks, this.foil] = this.createParticles();
  }

  private project(world: Vector3): ScreenPoint {
    const size = this.pops?.size ?? { width: 0, height: 0 };
    this.camera.updateMatrixWorld();
    tmp.copy(world).project(this.camera);
    return { x: (tmp.x * 0.5 + 0.5) * size.width, y: (-tmp.y * 0.5 + 0.5) * size.height };
  }

  private viewFrame(): ViewFrame {
    const e = this.camera.matrixWorld.elements;
    const at = (i: number): number => e[i] ?? 0;
    return {
      origin: [at(12), at(13), at(14)],
      right: [at(0), at(1), at(2)],
      up: [at(4), at(5), at(6)],
      forward: [-at(8), -at(9), -at(10)],
      tanHalfFov: Math.tan((this.camera.fov * Math.PI) / 360),
      aspect: this.camera.aspect,
    };
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('This Vfx was disposed; create a new one with createVfx()');
  }
}

/**
 * The halo around the white-gold core: the result's metal when it is gold or warmer, and
 * champagne below, so a first silver fusion still reads warm instead of cold chrome.
 */
function fusionHalo(tier: CoinTier): string {
  if (tier === 'heirloom') return HEIRLOOM_PRISM[0];
  return COIN_TIERS.indexOf(tier) >= COIN_TIERS.indexOf(FUSION_FULL_FROM)
    ? tierMetal(tier)
    : VFX_COLORS.champagne;
}

function popColor(options: NumberPopOptions): { readonly color: string; readonly prism: boolean } {
  const { rarity, tier } = options;
  if (rarity !== undefined && tier !== undefined) {
    throw new RangeError('numberPop takes a rarity or a coin tier for its colour, not both');
  }
  if (tier !== undefined) return { color: tierMetal(tier), prism: tier === 'heirloom' };
  const r = rarity ?? 'common';
  return { color: RARITY_COLORS[r], prism: r === 'heirloom' };
}

export function createVfx(options: VfxOptions): Vfx {
  return new Vfx(options);
}
